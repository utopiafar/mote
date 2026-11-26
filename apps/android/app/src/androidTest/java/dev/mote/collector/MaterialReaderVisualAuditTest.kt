package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class MaterialReaderVisualAuditTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val output get() = File(context.filesDir, "reader-visual").apply { mkdirs() }

    @Test fun localCaptureReaders() = fixture { manifest ->
        val sources = setOf("note", "screen", "ui_page", "notification", "device_event", "activity", "media")
        val records = manifest.getJSONArray("localCaptures").objects().filter { it.getString("source") in sources }
        val settings = Settings(context)
        val ids = mutableMapOf<String, String>()
        try {
            records.forEach { original ->
                val record = JSONObject(original.toString())
                val id = UUID.randomUUID().toString()
                val image = record.optString("imageBase64").takeIf(String::isNotEmpty)?.let { Base64.decode(it, Base64.DEFAULT) }
                val source = record.getString("source")
                record.put("id", id).put("deviceId", settings.deviceId).put("deviceName", "Generated Android reader")
                    .put("platform", "android")
                record.remove("imageBase64")
                if (source in SystemEventRules.sources || source == "activity") {
                    record.remove("ocrText")
                    record.remove("windowTitle")
                }
                if (source == "device_event") {
                    record.remove("appId")
                    record.remove("appName")
                }
                context.queue().enqueue(record, image)
                ids[source] = id
            }
            openLibrary().use {
                audit(records) { record ->
                    val source = record.getString("source")
                    clickTag("library-record:" + ids.getValue(source))
                    captureReader("local-$source", source, readableMarker(source, record.optString("ocrText")), central = false)
                }
            }
        } finally {
            ids.values.forEach { context.queue().removeGeneratedRecord(it) }
        }
    }

    @Test fun centralCaptureReadersFromLibrary() = fixture { manifest ->
        connect(manifest)
        val cases = manifest.getJSONArray("examples").objects()
            .filter { it.getString("key") in setOf("note","screenshot","page","notification","device-event","activity","media") }
        openLibrary().use {
            clickTag("library-filter")
            clickTag("library-location:central")
            audit(cases) { row ->
                val key = row.getString("key")
                clickTag("library-record:" + row.getString("captureId"))
                captureReader("central-$key", key, readableMarker(key, row.getString("marker")), central = true)
            }
        }
    }

    @Test fun centralMaterialAndArchivedFileReaders() = fixture { manifest ->
        connect(manifest)
        val api = CentralClient(manifest.getString("origin"), manifest.getString("token"))
        val rows = api.get("/api/library/browse?limit=60").getJSONArray("items").objects()
            .mapNotNull { it.optJSONObject("material") }
        val examples = manifest.getJSONArray("examples").objects()
        val collected = setOf("mote.note", "mote.capture-event", "mote.screen-segment", "mote.ui-page-object", "mote.state-series", "mote.notification")
        val extras = rows.filter { it.getString("kind") in collected }
        val ids = examples.filter { it.has("materialRef") }.map {
            if (it.getString("key") in setOf("document", "image", "recording")) {
                val title = it.getString("title")
                rows.first { row -> row.getString("kind") == "mote.file" && row.getString("title") == title }.getString("id")
            } else it.getString("materialRef").substringBefore('@').removePrefix("material:")
        }
        val materials = (rows.filter { it.getString("id") in ids } + extras).distinctBy { it.getString("id") }
        central("archive").use {
            audit(materials) { row ->
                val title = row.getString("title").let { if (it == "device_event") "设备事件" else it }
                val id = row.getString("id")
                clickTag("material-open:" + id)
                await(title) { text(title) && views().any { it.tag == "library-reader-details" } }
                if (row.getString("kind") == "mote.note") assertTrue(main { !text("\"captureId\"") })
                val archivedImage = title == examples.first { it.getString("key") == "image" }.getString("title")
                if (archivedImage) {
                    assertTrue(main { text("查看文件详情") && !text("original_image_reference") })
                }
                screenshot("material-" + id, title)
                if (archivedImage) {
                    clickLabel("查看文件详情")
                    await("image opened from the material") { views().filterIsInstance<ImageView>().any { it.drawable is android.graphics.drawable.BitmapDrawable } }
                    verifyImageViewer("material-" + id + "-zoom")
                    clickLabel("返回上级")
                    await("return to formal image reader") { text(title) && text("查看文件详情") }
                }
                clickTag("library-reader-details")
                await("material source sheet") { views().any { matches(it, "关闭") } }
                screenshot("material-" + id + "-source", "详情")
                clickLabel("关闭")
                clickLabel("返回上级")
                await("catalogue after $title") { text("全部资料") }
            }
            clickLabel("原始采集记录")
            val message = examples.first { it.getString("key") == "message" }
            clickTag("archive-original:" + message.getString("captureId"))
            captureReader("central-message", "message", message.getString("marker"), central = true) { text("原始采集记录") || text("刷新") }
        }
        central("files").use {
            audit(examples.filter { it.getString("key") in setOf("image", "document", "recording") }) { row ->
                val key = row.getString("key")
                val title = row.getString("title")
                clickTag("archive-file:" + row.getString("captureId"))
                await("file reader for $key") { text(title) && text("处理详情") }
                if (key == "image") {
                    await("archived original image") { views().filterIsInstance<ImageView>().any { it.drawable is android.graphics.drawable.BitmapDrawable } }
                    verifyImageViewer("file-image-zoom")
                }
                if (key == "recording") {
                    await("readable transcript speakers") { text("说话人 1") && !text("[SPEAKER_0]") }
                    clickLabel("播放录音")
                    await("recording entered its native player") { views().any { it is android.widget.SeekBar && it.isEnabled } }
                    clickLabel("播放或暂停")
                }
                screenshot("file-$key", title)
                clickLabel("处理详情")
                screenshot("file-$key-source", "处理详情")
                clickLabel("返回上级")
                await("file archive after $key") { text("处理设置") }
            }
        }
    }

    private fun captureReader(name: String, source: String, marker: String, central: Boolean, returned: () -> Boolean = { views().any { it.tag == "library-filter" } }) {
        await(name) { active() is CaptureRecordsActivity && views().any { it.tag == "capture-reader-details" } }
        if (source in setOf("screen", "screenshot")) {
            await("screenshot bitmap") { views().filterIsInstance<ImageView>().any { it.drawable is android.graphics.drawable.BitmapDrawable } }
            verifyImageViewer("$name-zoom")
        }
        val readerLabel = main { views().filterIsInstance<TextView>().first { it.text.isNotBlank() }.text.toString() }
        screenshot(name, readerLabel)
        if (marker.isNotBlank()) assertTrue("Expected the evidence body for $name", main { text(marker) })
        clickTag("capture-reader-details")
        await("source sheet for $name") { views().any { matches(it, "关闭") } }
        if (central) await("Central receipt for $name") { text("中央已接收") }
        screenshot("$name-source", "详情")
        if (source in setOf("page", "ui_page", "notification", "device-event", "device_event")) {
            clickLabel("技术详情")
            await("technical information for $name") { text("\"collector\"") }
            clickLabel("技术详情")
            await("technical information collapsed for $name") { !text("\"collector\"") }
        }
        clickLabel("关闭")
        clickLabel("返回上一页")
        await("returned from $name", returned)
    }

    private fun readableMarker(key: String, fallback: String) = when (key) {
        "device-event", "device_event" -> "熄屏"
        "media" -> "路线实地回听"
        "notification" -> "周五下午五点前确认折页校样。"
        "activity" -> "导览编辑器"
        else -> fallback.lineSequence().filter(String::isNotBlank).lastOrNull().orEmpty()
    }

    private fun verifyImageViewer(name: String) {
        clickLabel("查看原图")
        await("image viewer opened") { views().any { it is BulkDedupeImageView } && views().any { matches(it, "关闭") } }
        screenshot(name, "查看原图")
        clickLabel("关闭")
        await("image viewer closed") {
            val current = views()
            current.isNotEmpty() && current.none { it is BulkDedupeImageView }
        }
    }

    private fun back() {
        assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
    }
    private fun openLibrary(): ActivityScenario<MainActivity> =
        ActivityScenario.launch(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY"))
    private fun central(page: String): ActivityScenario<CentralActivity> =
        ActivityScenario.launch(Intent(context, CentralActivity::class.java).putExtra("page", page))

    private fun connect(manifest: JSONObject) {
        val origin = manifest.getString("origin")
        assertTrue(ConnectionGuard.beginReconfiguration())
        try {
            ConnectionGuard.reconfigure(context, origin, bindLocal = true) {
                Settings(context).saveConnection(origin, manifest.getString("token"), "Generated Central reader", true)
            }
        } finally {
            ConnectionGuard.endReconfiguration()
        }
        CentralSession.get(context).select(origin)
    }

    private fun fixture(test: (JSONObject) -> Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("readerVisualFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val manifest = JSONObject(File(context.filesDir, "reader-visual-fixture.json").readText())
        val origin = URI(manifest.getString("origin"))
        require(manifest.getBoolean("generatedOnly") && origin.scheme == "http" && origin.host == "127.0.0.1" && origin.port > 0)
        val settings = Settings(context)
        val before = settings.read()
        val previousOrigin = before.server
        val language = MoteI18n.preference()
        val appearance = MoteAppearance.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected && context.queue().inventory().records == 0)
        try {
            MoteI18n.select(context, "zh-CN")
            main { MoteAppearance.select(context, AppearancePreference.LIGHT) }
            settings.save(before.copy(server = "", token = "", syncPaused = true, syncMode = "manual"), confirmCentralEndpoint = true)
            CentralSession.get(context).select("")
            test(manifest)
        } finally {
            settings.save(before, confirmCentralEndpoint = true)
            CentralSession.get(context).select(previousOrigin)
            MoteI18n.select(context, language)
            main { MoteAppearance.select(context, appearance) }
        }
    }

    private fun audit(rows: List<JSONObject>, test: (JSONObject) -> Unit) {
        assertTrue("The generated entry list must be populated", rows.isNotEmpty())
        val failures = mutableListOf<Throwable>()
        rows.forEach { row ->
            val label = row.optString("key", row.optString("title", row.optString("source")))
            try {
                test(row)
                android.util.Log.i("ReaderVisualAudit", "PASS $label")
            } catch (error: AssertionError) {
                failures.add(error)
                android.util.Log.e("ReaderVisualAudit", "FAIL $label", error)
                val visible = main { views().filterIsInstance<TextView>().firstOrNull { it.text.isNotBlank() }?.text?.toString() }
                if (visible != null) runCatching { screenshot("failed-" + label.replace(Regex("[^a-zA-Z0-9_-]"), "_"), visible) }
                if (main { active() is CaptureRecordsActivity || views().any { it.tag == "library-reader-details" } }) back()
            }
        }
        if (failures.isNotEmpty()) throw AssertionError(failures.joinToString("\n") { it.message.orEmpty() })
    }

    private fun active(): Activity? = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).lastOrNull()
    private fun walk(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(walk(root.getChildAt(it))) }
    }
    private fun windows() = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }
    private fun views() = windows().flatMap(::walk).filter(View::isShown)
    private fun text(value: String) = views().filterIsInstance<TextView>().any { it.text.toString().contains(value) }
    private fun clickTag(tag: String) = click(tag) { views().firstOrNull { it.tag == tag } }
    private fun clickLabel(label: String) = click(label) { views().firstOrNull { matches(it, label) } }
    private fun matches(view: View, label: String) =
        view.contentDescription?.toString() == label || (view as? TextView)?.text?.toString() == label

    private fun click(label: String, find: () -> View?) {
        await(label) { find()?.isEnabled == true }
        main {
            val target = generateSequence(requireNotNull(find())) { it.parent as? View }.first { it.isClickable }
            target.requestRectangleOnScreen(Rect(0, 0, target.width, target.height), true)
            assertTrue(label, target.performClick())
        }
    }

    private fun await(label: String, ready: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 12_000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (main(ready)) return
            Thread.sleep(55)
        }
        throw AssertionError(label + " · " + main { views().filterIsInstance<TextView>().take(18).joinToString(" / ") { it.text } })
    }

    private fun screenshot(name: String, marker: String) {
        await("rendered frame for $name") { windows().isNotEmpty() && windows().all(GeneratedWindowRendering::hasNoPendingLabels) }
        val ready = CountDownLatch(1)
        main { requireNotNull(active()).window.decorView.postOnAnimation { ready.countDown() } }
        assertTrue("A frame must paint before $name", ready.await(5, TimeUnit.SECONDS))
        main {
            val activity = requireNotNull(active())
            GeneratedWindowRendering.save(activity, output, name, windows().filter { it !== activity.window.decorView },
                includeScrollEvidence = false, includeHorizontalEvidence = false, readerMarker = marker)
        }
    }

    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }

    private fun JSONArray.objects() = (0 until length()).map(::getJSONObject)
}
