package dev.mote.collector

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import android.widget.Button
import android.widget.TextView
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Real archive/configuration/storage work; only the system document chooser uses generated URIs. */
@RunWith(AndroidJUnit4::class)
class BackupJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private val generatedIds = mutableListOf<String>()
    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun visible() = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun until(label: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(50) }
        fail(label)
    }
    private fun textVisible(value: String) = main { visible().filterIsInstance<TextView>().any { it.text.toString().contains(MoteI18n.text(value)) } }
    private fun click(value: String) {
        until(value) { main { visible().filterIsInstance<Button>().any { it.text.toString() == MoteI18n.text(value) && it.isEnabled } } }
        main { visible().filterIsInstance<Button>().single { it.text.toString() == MoteI18n.text(value) && it.isEnabled }.apply { requestRectangleOnScreen(android.graphics.Rect(0, 0, width, height), true); performClick() } }
    }
    private fun tag(value: String) {
        until(value) { main { visible().any { it.tag == value && it.isEnabled } } }
        main { visible().single { it.tag == value }.performClick() }
    }
    private fun screenshotOne(scenario: ActivityScenario<BackupActivity>, name: String) {
        instrumentation.waitForIdleSync()
        scenario.onActivity { activity ->
            assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            val root = activity.window.decorView; val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            root.draw(Canvas(image))
            File(context.filesDir, "generated-secondary-ui").apply { mkdirs() }.resolve("$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
            image.recycle()
        }
    }
    private fun screenshot(scenario:ActivityScenario<BackupActivity>,name:String) {
        val before=MoteAppearance.preference()
        try { for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
            main { MoteAppearance.select(context,theme) };screenshotOne(scenario,name+if(theme==AppearancePreference.DARK)"-dark" else "")
        } } finally { main { MoteAppearance.select(context,before) } }
    }
    private fun <T> picker(action: String, file: File?, block: () -> T): T {
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? = if (intent.action == action) {
                if (file == null) Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
                else Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)))
            } else null
        }
        instrumentation.addMonitor(monitor)
        return try { block() } finally { instrumentation.removeMonitor(monitor) }
    }
    private fun fixture(block: (File) -> Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("secondaryUiFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val before = settings.read(); val language = MoteI18n.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        if (InstrumentationRegistry.getArguments().getString("backupCleanupGenerated") == "true") {
            finishGeneratedStage(null)
            context.queue().dedupeIds().forEach { id -> context.queue().capture(id)?.takeIf(::isGenerated)?.let { context.queue().acknowledge(id) } }
        }
        require(!context.queue().hasPendingConnectionWork())
        val root = File(context.cacheDir, "record-camera/backup-ui-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            MoteI18n.select(context, "zh-CN")
            settings.save(before.copy(server = "", token = "", syncPaused = true), confirmCentralEndpoint = true)
            block(root)
        } finally {
            finishGeneratedStage(generatedIds.toSet())
            generatedIds.forEach { context.queue().acknowledge(it) }; generatedIds.clear()
            root.deleteRecursively(); settings.save(before, confirmCentralEndpoint = true); MoteI18n.select(context, language)
        }
    }
    private fun isGenerated(event: JSONObject) = event.optString("ocrText") == "Generated backup UI fixture" && event.optString("capturedAt") == "2026-10-29T01:00:00Z"
    private fun finishGeneratedStage(allowedIds: Set<String>?) {
        val inbox = File(QueueStorage(context).current().path, ".capture-stages.inbox")
        if (!inbox.exists()) return
        val input = JSONObject(String(LocalContentCipher().open(inbox.readBytes()), Charsets.UTF_8)).getJSONObject("input").getJSONObject("event")
        check(isGenerated(input) && (allowedIds == null || input.getString("id") in allowedIds)) { "Preserve an unrelated pending capture stage" }
        context.queue().flushStages(64L * 1024 * 1024)
    }
    private fun event(): JSONObject = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", "2026-10-29T01:00:00Z").put("privacy", JSONObject().put("excluded", false))
        .put("imageMime", "image/png").put("ocrText", "Generated backup UI fixture")
    private fun archive(root: File, sizes: List<Int> = listOf(4)): Pair<File, List<String>> {
        val source = DurableQueue(File(root, "queue-${UUID.randomUUID()}"), plain)
        val ids = sizes.mapIndexed { i, size ->
            val event = event(); source.enqueue(event, ByteArray(size).also { java.util.Random(i.toLong() + 101).nextBytes(it) }, 20_000_000)
            event.getString("id").also(generatedIds::add)
        }
        val file = File(root, "generated-records.zip")
        file.outputStream().use { QueueArchive.export(source, Settings(context).dataOrigin(), it) }
        return file to ids
    }
    private fun chooseRestore(file: File) {
        tag("backup-restore-records")
        picker(Intent.ACTION_OPEN_DOCUMENT, file) { click("选择备份文件"); until("backup checked") { textVisible("备份已校验") } }
    }
    private fun home() = click("← " + MoteI18n.text("备份与恢复"))

    @Test fun validArchivePreviewCancelImportAndDuplicateRetryKeepOriginalIds() = fixture { root ->
        val (file, ids) = archive(root); val id = ids.single(); val count = context.queue().inventory().records
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            chooseRestore(file); screenshot(scenario, "backup-restore-preview"); click("取消")
            assertNull(context.queue().capture(id)); assertEquals(count, context.queue().inventory().records)
            chooseRestore(file); click("导入到此手机"); until("records restored") { textVisible("记录已回来") }
            assertNotNull(context.queue().capture(id)); assertEquals("manual", Settings(context).read().syncMode)
            screenshot(scenario, "backup-restore-success"); home()
            chooseRestore(file); click("导入到此手机"); until("same archive restored") { textVisible("记录已回来") }
            assertEquals(count + 1, context.queue().inventory().records)
        }
        until("staging cleaned") { context.cacheDir.listFiles()?.none { it.name.startsWith("restore-") } == true }
    }

    @Test fun invalidArchiveAndCancelledChooserNeverChangeQueue() = fixture { root ->
        val before = context.queue().inventory(); val bad = File(root, "invalid.zip").apply { writeText("generated invalid archive") }
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            tag("backup-restore-records")
            picker(Intent.ACTION_OPEN_DOCUMENT, null) { click("选择备份文件"); until("chooser cancellation") { textVisible("选择本机记录 ZIP") } }
            picker(Intent.ACTION_OPEN_DOCUMENT, bad) { click("选择备份文件"); until("invalid backup") { textVisible("备份无法导入：") } }
            screenshot(scenario, "backup-restore-invalid"); assertEquals(before, context.queue().inventory())
            click("返回")
        }
    }

    @Test fun configurationPreviewRequiresConfirmationAndPreservesIdentity() = fixture { root ->
        val before = Settings(context).read(); val device = Settings(context).deviceId
        val next = before.copy(intervalSeconds = if (before.intervalSeconds == 25) 30 else 25)
        val file = File(root, "generated-settings.json").apply { writeText(ConfigurationArchive.encode(next)) }
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            tag("backup-config-tab")
            picker(Intent.ACTION_OPEN_DOCUMENT, file) { click("导入配置 JSON"); until("configuration preview") { textVisible("替换这台手机的偏好设置？") } }
            screenshot(scenario, "backup-config-preview"); click("取消"); assertEquals(before.intervalSeconds, Settings(context).read().intervalSeconds)
            picker(Intent.ACTION_OPEN_DOCUMENT, file) { click("导入配置 JSON"); until("configuration preview again") { textVisible("替换这台手机的偏好设置？") } }
            click("导入配置"); until("configuration applied") { textVisible("配置已导入") }
            assertEquals(next.intervalSeconds, Settings(context).read().intervalSeconds); assertEquals(device, Settings(context).deviceId)
            assertFalse(Settings(context).enabled); screenshot(scenario, "backup-config-success")
        }
    }

    @Test fun exportReportsRealOutputAndWriteFailureKeepsRecords() = fixture { root ->
        val output = File(root, "export.zip"); val invalid = File(root, "not-a-file").apply { mkdirs() }; val before = context.queue().inventory()
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            picker(Intent.ACTION_CREATE_DOCUMENT, output) { tag("backup-export-records"); until("export saved") { textVisible("导出文件已生成") } }
            java.util.zip.ZipFile(output).use { assertNotNull(it.getEntry("archive.json")) }
            screenshot(scenario, "backup-export-success"); click("完成")
            picker(Intent.ACTION_CREATE_DOCUMENT, invalid) { tag("backup-export-records"); until("export failed") { textVisible("备份未能生成") } }
            screenshot(scenario, "backup-export-failure"); assertEquals(before, context.queue().inventory())
            picker(Intent.ACTION_CREATE_DOCUMENT, output) { click("重新导出"); until("export retried") { textVisible("导出文件已生成") } }
        }
    }

    @Test fun selectedExportFactsAndSourceHierarchyKeepRecordsAndNeverReuseCancelledFile() = fixture { root ->
        val before = context.queue().inventory()
        val output = File(root, "generated-selected-records.zip")
        val metadata = File(root, "generated-selected-metadata.json")
        val configuration = File(root, "generated-selected-configuration.json")
        val invalid = File(root,"generated-unwritable-output").apply { mkdirs() }
        fun facts(file: File) {
            val uri = FileProvider.getUriForFile(context,"${context.packageName}.record-files",file).toString()
            until("same selected document post-write metadata") { main {
                visible().filterIsInstance<TextView>().any { it.tag=="backup-export-name" && it.text.toString()==file.name } &&
                    visible().filterIsInstance<TextView>().any { it.tag=="backup-export-size" && it.text.toString()==java.text.NumberFormat.getIntegerInstance(MoteI18n.locale()).format(file.length())+" B" }
            } }
            assertFalse(main { visible().any { it.tag=="backup-export-uri" } })
            tag("backup-file-details")
            assertTrue(main { visible().filterIsInstance<TextView>().any { it.tag=="backup-export-uri" && it.text.toString()==uri } })
            tag("backup-file-details")
            assertFalse(main { visible().any { it.tag=="backup-export-uri" } })
        }
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            until("real local count") { main { visible().filterIsInstance<TextView>().any { it.tag=="backup-record-count" && it.text.toString()==java.text.NumberFormat.getIntegerInstance(MoteI18n.locale()).format(before.records) } } }
            main { val count=visible().filterIsInstance<TextView>().single { it.tag=="backup-record-count" }; assertEquals(35f,count.textSize/context.resources.displayMetrics.scaledDensity,.1f) }
            assertFalse(textVisible("已清理的本机副本不在其中。"))
            tag("backup-scope"); assertTrue(textVisible("已清理的本机副本不在其中。")); assertTrue(textVisible("备份文件为明文，仅保存在自己信任的位置。"))
            screenshot(scenario,"backup-source-scope"); tag("backup-scope")
            picker(Intent.ACTION_CREATE_DOCUMENT,output) { tag("backup-export-records");until("real ZIP output") { textVisible("导出文件已生成") } }
            java.util.zip.ZipFile(output).use { assertNotNull(it.getEntry("archive.json")) }; facts(output)
            assertTrue(textVisible("导出本机记录")); screenshot(scenario,"backup-selected-record-facts");click("完成")
            tag("backup-scope")
            picker(Intent.ACTION_CREATE_DOCUMENT,metadata) { click("导出本机元数据 JSON");until("real metadata output") { textVisible("导出文件已生成") } }
            assertEquals("mote-local-metadata",JSONObject(metadata.readText()).getString("format"));facts(metadata)
            assertTrue(textVisible("导出本机元数据"));screenshot(scenario,"backup-selected-metadata-facts");click("完成")
            tag("backup-config-tab")
            picker(Intent.ACTION_CREATE_DOCUMENT,configuration) { click("导出配置 JSON");until("real configuration output") { textVisible("导出文件已生成") } }
            assertFalse(JSONObject(configuration.readText()).getJSONObject("settings").has("token"));facts(configuration)
            assertTrue(textVisible("导出客户端配置"));screenshot(scenario,"backup-selected-configuration-facts");click("完成")
            tag("backup-records-tab")
            picker(Intent.ACTION_CREATE_DOCUMENT,invalid) { tag("backup-export-records");until("real output write failure") { textVisible("备份未能生成") } }
            until("failed selected URI visible") { textVisible(invalid.name) };screenshot(scenario,"backup-selected-failed-file")
            picker(Intent.ACTION_CREATE_DOCUMENT,null) { click("重新导出");instrumentation.waitForIdleSync() }
            assertFalse(main { visible().any { it.tag=="backup-export-file" } });screenshot(scenario,"backup-picker-cancel-withdraws-old-file")
            assertEquals(before,context.queue().inventory());assertFalse(Settings(context).enabled)
        }
    }

    @Test fun partialRestoreRetainsRecordsAndRetriesSameValidatedFileWithoutDuplication() = fixture { root ->
        val settings = Settings(context); val before = settings.read(); settings.save(before.copy(maxQueueMiB = 8))
        val blocker = event().getString("id")
        val existing = event().put("id", blocker); generatedIds.add(blocker)
        context.queue().enqueue(existing, ByteArray(2_000_000).also { java.util.Random(99).nextBytes(it) }, 32_000_000)
        val (file, ids) = archive(root, listOf(1_500_000, 1_500_000))
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            chooseRestore(file); click("导入到此手机"); until("partial failure") { textVisible("导入尚未完成") }
            assertEquals(1, ids.count { context.queue().capture(it) != null }); screenshot(scenario, "backup-restore-partial")
            context.queue().acknowledge(blocker)
            click("重试同一备份"); until("same preview") { textVisible("备份已校验") }; click("导入到此手机")
            until("retry completed") { textVisible("记录已回来") }; assertEquals(2, ids.count { context.queue().capture(it) != null })
            screenshot(scenario, "backup-restore-retry-success")
        }
    }
    @Test fun anotherCentralConfigurationPreviewShowsTheBoundaryAndCancelPreservesIdentity() = fixture { root ->
        val settings=Settings(context);val before=settings.read();val device=settings.deviceId;val inventory=context.queue().inventory()
        val next=before.copy(server="http://127.0.0.1:47999",token="",debugHttp=true)
        val file=File(root,"generated-other-central.json").apply { writeText(ConfigurationArchive.encode(next)) }
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            tag("backup-config-tab");picker(Intent.ACTION_OPEN_DOCUMENT,file) { click("导入配置 JSON");until("Other Central explicit preview"){textVisible("中央将改变；未携带令牌时需重新连接")} }
            screenshot(scenario,"backup-other-central-preview");click("取消")
            assertEquals(before,settings.read());assertEquals(device,settings.deviceId);assertEquals(inventory,context.queue().inventory())
        }
    }

    @Test fun actualCentralExportRemainsInProgressUntilTheRealArchiveResponseArrives() = fixture { root ->
        assumeTrue(InstrumentationRegistry.getArguments().getString("discoveryFixture")=="true")
        val origin="http://127.0.0.1:47886";val token="generated-native-discovery-owner-token";val api=CentralClient(origin,token)
        api.post("/api/__fixture/reset");val settings=Settings(context);settings.save(settings.read().copy(server=origin,token="",debugHttp=true,syncMode="manual"),confirmCentralEndpoint=true)
        CentralSession.get(context).select(origin);CentralSession.get(context).signIn(origin,token)
        val output=File(root,"generated-actual-central.tar.gz");val before=context.queue().inventory()
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            try {
                tag("backup-central");api.post("/api/__fixture/hold-export")
                picker(Intent.ACTION_CREATE_DOCUMENT,output) { click("导出中央元数据");until("Actual generated archive response held"){api.get("/api/__fixture/state").getBoolean("exportHeld")} }
                until("Native actual export in progress"){textVisible("正在导出中央资料")};until("Held export selected document") { textVisible(output.name) };assertTrue(textVisible("导出中央元数据"));assertFalse(textVisible("导出文件已生成"));screenshot(scenario,"actual-central-export-in-progress")
                api.post("/api/__fixture/release-export");until("Actual archive saved after response"){textVisible("导出文件已生成")}
                assertTrue(output.length()>0);java.util.zip.GZIPInputStream(output.inputStream()).use { assertTrue(it.readBytes().isNotEmpty()) };assertEquals(before,context.queue().inventory());screenshot(scenario,"actual-central-export-completed")
            } finally { api.post("/api/__fixture/release-export") }
        }
    }

}
