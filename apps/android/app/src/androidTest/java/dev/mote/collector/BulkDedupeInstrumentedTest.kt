package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BulkDedupeInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use { ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() } }
    private fun views(view: View): List<View> = buildList { add(view); if (view is ViewGroup) repeat(view.childCount) { addAll(views(view.getChildAt(it))) } }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 60000
        while (!condition()) { check(System.currentTimeMillis() < deadline) { "Timed out: $label" }; Thread.sleep(100) }
    }
    private fun launch(data: Data): UUID {
        val request = OneTimeWorkRequestBuilder<BulkDedupeWorker>().setInputData(data).build()
        WorkManager.getInstance(context).enqueueUniqueWork(BulkDedupeWorker.NAME, ExistingWorkPolicy.KEEP, request).result.get()
        return request.id
    }
    private fun finish(id: UUID): WorkInfo {
        val manager = WorkManager.getInstance(context)
        waitFor("worker $id") { manager.getWorkInfoById(id).get()!!.state.isFinished }
        return manager.getWorkInfoById(id).get()!!.also { assertEquals(it.outputData.toString(), WorkInfo.State.SUCCEEDED, it.state) }
    }
    @Test fun twoThousandGeneratedImagesScanAndDeleteThroughWorkerWithoutBlockingUi() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        waitFor("storage recovery") { !QueueStorage.recovering }
        val store = BulkDedupeStore(context)
        val queue = context.queue()
        require(queue.depth() == 0 && store.quarantine().depth() == 0)
        val settings = Settings(context); val original = settings.read()
        val manager = WorkManager.getInstance(context)
        val ids = mutableListOf<String>()
        try {
            manager.cancelAllWork().result.get()
            settings.save(original.copy(server = "", token = "", syncMode = "manual", ocrChargingOnly = true))
            val bitmap = Bitmap.createBitmap(96, 160, Bitmap.Config.ARGB_8888)
            val start = Instant.parse("2026-09-01T00:00:00Z")
            try {
                queue.withDeferredIndexWrites {
                    repeat(100) { group ->
                        bitmap.eraseColor(Color.rgb(group * 2, group, 255 - group))
                        val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                        repeat(20) { offset ->
                            val id = UUID.randomUUID().toString(); ids += id
                            queue.enqueue(JSONObject().put("id", id).put("source", "screen")
                                .put("capturedAt", start.plusSeconds(group * 20L + offset).toString())
                                .put("appId", "fixture.bulk").put("appName", "Generated bulk fixture")
                                .put("privacy", JSONObject().put("excluded", false))
                                .put("ocr", JSONObject().put("status", "disabled")), png, 1_000_000_000)
                        }
                    }
                }
            } finally { bitmap.recycle() }
            var maxUiMs = 0L
            var scanMs = 0L
            var deleteMs = 0L
            ActivityScenario.launch(BulkDedupeActivity::class.java).use { scenario ->
                fun responsiveWhileRunning(work: UUID) {
                    val deadline = System.currentTimeMillis() + 60_000
                    do {
                        val before = android.os.SystemClock.elapsedRealtime()
                        scenario.onActivity { activity ->
                            assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text == "本机图片批量去重" })
                        }
                        val uiMs = android.os.SystemClock.elapsedRealtime() - before
                        maxUiMs = maxOf(maxUiMs, uiMs)
                        assertTrue("UI stalled for $uiMs ms with 2000 images", uiMs < 1500)
                        check(System.currentTimeMillis() < deadline) { "2000-image worker did not finish within 60 seconds" }
                        Thread.sleep(100)
                    } while (!manager.getWorkInfoById(work).get()!!.state.isFinished)
                    finish(work)
                }
                val scanStart = android.os.SystemClock.elapsedRealtime()
                responsiveWhileRunning(launch(workDataOf("action" to "scan", "mode" to "exact")))
                scanMs = android.os.SystemClock.elapsedRealtime() - scanStart
                val report = store.read("report")
                val pairs = report.getJSONArray("pairs")
                assertEquals(2000, report.getInt("scanned")); assertEquals(0, report.getInt("errors"))
                assertEquals(1900, pairs.length())
                waitFor("2000-image result first page") {
                    var ready = false
                    scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("候选 1900 张") } }
                    ready
                }
                scenario.onActivity { activity ->
                    val thumbnails = views(activity.window.decorView).filterIsInstance<ImageView>()
                    assertEquals("Only the visible page creates thumbnails", 20, thumbnails.size)
                    views(activity.window.decorView).filterIsInstance<Button>().first { it.text == "选择全部候选" }.performClick()
                    assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("已选 1900 条") })
                    thumbnails.zip(views(activity.window.decorView).filterIsInstance<ImageView>()).forEach { (before, after) -> assertSame(before, after) }
                }
                val job = UUID.randomUUID().toString()
                store.write("plan", JSONObject().put("job", job).put("items", pairs))
                val deleteStart = android.os.SystemClock.elapsedRealtime()
                responsiveWhileRunning(launch(workDataOf("action" to "delete", "job" to job)))
                deleteMs = android.os.SystemClock.elapsedRealtime() - deleteStart
                assertEquals(100, queue.depth())
                repeat(100) { assertNotNull("Retained reference must remain readable", queue.image(ids[it * 20])) }
            }
            java.io.File(context.filesDir, "bulk-dedupe-performance.json").writeText(JSONObject()
                .put("fixtureImages", 2000).put("distinctImages", 100).put("deleted", 1900)
                .put("scanMs", scanMs).put("deleteMs", deleteMs).put("maxUiMs", maxUiMs).toString())
        } finally {
            manager.cancelUniqueWork(BulkDedupeWorker.NAME).result.get()
            queue.withDeferredIndexWrites {
                ids.forEach { id -> queue.dedupeRow(id)?.let { queue.resolveDedupe(id, it.getString("blob"), null, null, null) } }
            }
            settings.save(original)
            store.write("report", JSONObject()); store.write("plan", JSONObject())
        }
    }
    @Test fun generatedImagesScanPreviewLifecycleMoveRestoreDeleteAndCancel() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        waitFor("storage recovery") { !QueueStorage.recovering }
        require(context.queue().depth() == 0 && BulkDedupeStore(context).quarantine().depth() == 0)
        val settings = Settings(context); val original = settings.read()
        val manager = WorkManager.getInstance(context)
        val store = BulkDedupeStore(context)
        val ids = mutableListOf<String>()
        try {
            manager.cancelAllWork().result.get()
            settings.save(original.copy(server = "", token = "", syncMode = "manual", ocrChargingOnly = true))
            val bitmap = Bitmap.createBitmap(240, 400, Bitmap.Config.ARGB_8888)
            fun png(color: Int): ByteArray { bitmap.eraseColor(color); return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray() }
            // Generated high-frequency pattern verifies identical feature extraction at every tier.
            val pixels = IntArray(240 * 400) { i -> if ((i / 240 + i % 240) % 7 == 0) Color.BLACK else Color.WHITE }
            bitmap.setPixels(pixels, 0, 240, 0, 0, 240, 400)
            val pattern = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            ScreenshotDedupeHelper.Mode.entries.forEach { mode ->
                val size = ScreenshotDedupeHelper.sampleSizeForMode(240, 400, mode)
                val sample = Bitmap.createScaledBitmap(bitmap, size.width, size.height, true)
                val sampled = IntArray(size.width * size.height); sample.getPixels(sampled, 0, size.width, 0, 0, size.width, size.height)
                val expected = ScreenshotDedupeHelper.buildFeatures(size.width, size.height, sampled).copy(width = 240, height = 400)
                assertEquals(expected.toSignature(), BulkDedupeRules.features(pattern, mode).toSignature())
                if (sample !== bitmap) sample.recycle()
            }
            val white = png(Color.WHITE); val black = png(Color.BLACK); bitmap.recycle()
            val start = Instant.parse("2026-09-01T00:00:00Z")
            fun add(second: Long, image: ByteArray = white, app: String = "fixture.a") {
                val id = UUID.randomUUID().toString(); ids += id
                context.queue().enqueue(JSONObject().put("id", id).put("source", "screen").put("capturedAt", start.plusSeconds(second).toString())
                    .put("appId", app).put("appName", "Generated fixture").put("privacy", JSONObject().put("excluded", false))
                    .put("ocr", JSONObject().put("status", "disabled")), image, 100_000_000)
            }
            add(0); add(30); add(61); add(62, black); add(63, black, "fixture.b"); add(64, black, "fixture.b")
            repeat(100) { add(200 + it.toLong() * 86400, white, "fixture.long") }
            val scan = launch(workDataOf("action" to "scan", "mode" to "exact"))
            ActivityScenario.launch(BulkDedupeActivity::class.java).use { scenario ->
                repeat(8) {
                    val before = System.currentTimeMillis()
                    scenario.onActivity { activity -> assertNotNull(views(activity.window.decorView).filterIsInstance<TextView>().find { it.text.contains("本机图片批量去重") }) }
                    assertTrue("UI must respond during scanning", System.currentTimeMillis() - before < 1500)
                    Thread.sleep(100)
                }
                finish(scan)
                val report = store.read("report"); val pairs = report.getJSONArray("pairs")
                assertEquals(106, report.getInt("scanned")); assertEquals(0, report.getInt("errors")); assertEquals(102, pairs.length())
                val comparisons = (0 until pairs.length()).map { pairs.getJSONObject(it) }
                assertEquals(ids[0], comparisons.single { it.getJSONObject("candidate").getString("id") == ids[2] }.getJSONObject("reference").getString("id"))
                assertEquals(ids[6], comparisons.single { it.getJSONObject("candidate").getString("id") == ids.last() }.getJSONObject("reference").getString("id"))
                assertFalse(report.has("seconds"))
                scenario.recreate()
                waitFor("persistent result UI") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("候选 102 张") } }; ready }
                scenario.onActivity { activity ->
                    val thumbnails = views(activity.window.decorView).filterIsInstance<ImageView>()
                    assertTrue(thumbnails.isNotEmpty())
                    views(activity.window.decorView).filterIsInstance<Button>().first { it.text == "选择全部候选" }.performClick()
                    assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("已选 102 条") })
                    val afterSelection = views(activity.window.decorView).filterIsInstance<ImageView>()
                    assertEquals("Selecting candidates must preserve decoded thumbnails", thumbnails.size, afterSelection.size)
                    thumbnails.zip(afterSelection).forEach { (before, after) -> assertSame(before, after) }
                    views(activity.window.decorView).filterIsInstance<Button>().first { it.text == "取消全部选择" }.performClick()
                    views(activity.window.decorView).filterIsInstance<Button>().first { it.text == "预览图片与保留图" }.performClick()
                }
                waitFor("preview dialog") { instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("候选图")?.isNotEmpty() == true }
                instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                Thread.sleep(200)
            }
            fun resolve(action: String, items: JSONArray) {
                val job = UUID.randomUUID().toString(); store.write("plan", JSONObject().put("job", job).put("items", items))
                val result = finish(launch(workDataOf("action" to action, "job" to job)))
                assertTrue(result.outputData.getString("message")!!.contains("失效或失败 0"))
            }
            val pairs = store.read("report").getJSONArray("pairs")
            resolve("move", pairs)
            assertEquals(4, context.queue().depth()); assertEquals(102, store.quarantine().depth())
            assertArrayEquals(white, context.queue().image(ids[0]))
            fun pendingItems() = JSONArray(store.quarantine().dedupeIds().map { JSONObject().put("candidate", store.quarantine().dedupeRow(it)) })
            resolve("restore", pendingItems())
            assertEquals(106, context.queue().depth()); assertEquals(0, store.quarantine().depth())
            resolve("delete", JSONArray().put(pairs.getJSONObject(0)))
            assertEquals(105, context.queue().depth()); assertArrayEquals(white, context.queue().image(ids[0]))
            val remaining = JSONArray((1 until pairs.length()).map { pairs.getJSONObject(it) })
            resolve("move", remaining); resolve("purge", pendingItems())
            assertEquals(0, store.quarantine().depth()); assertEquals(4, context.queue().depth())
            val cancel = launch(workDataOf("action" to "scan", "mode" to "exact"))
            manager.cancelWorkById(cancel).result.get()
            waitFor("cancel") { manager.getWorkInfoById(cancel).get()!!.state.isFinished }
            assertEquals(4, context.queue().depth())
            val gray = Bitmap.createBitmap(240, 400, Bitmap.Config.ARGB_8888)
            try {
                for (value in listOf(0, 20, 40)) {
                    gray.eraseColor(Color.rgb(value, value, value))
                    val image = ByteArrayOutputStream().also { gray.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                    add(200L + 101L * 86400 + value, image, "fixture.drift")
                }
            } finally { gray.recycle() }
            // Every threshold mode preserves the same app boundaries without a time cutoff.
            for (mode in listOf("conservative", "balanced", "aggressive")) {
                finish(launch(workDataOf("action" to "scan", "mode" to mode)))
                val found = store.read("report").getJSONArray("pairs")
                val drift = (0 until found.length()).map { found.getJSONObject(it) }.filter { it.getJSONObject("candidate").getString("appId") == "fixture.drift" }
                assertEquals("Similar rejected frames must not become the next reference", 1, drift.size)
                assertEquals(ids[ids.size - 2], drift.single().getJSONObject("candidate").getString("id"))
                assertEquals(ids[ids.size - 3], drift.single().getJSONObject("reference").getString("id"))
            }
        } finally {
            manager.cancelUniqueWork(BulkDedupeWorker.NAME).result.get()
            ids.forEach { id -> listOf(context.queue(), store.quarantine()).forEach { queue -> queue.dedupeRow(id)?.let { queue.resolveDedupe(id, it.getString("blob"), null, null, null) } } }
            settings.save(original)
            store.write("report", JSONObject()); store.write("plan", JSONObject())
        }
    }
}
