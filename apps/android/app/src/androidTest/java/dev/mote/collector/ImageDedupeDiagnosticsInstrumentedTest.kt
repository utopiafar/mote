package dev.mote.collector

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Generated bitmap inputs only; requires the dedicated emulator, never a real screenshot or model. */
@RunWith(AndroidJUnit4::class)
class ImageDedupeDiagnosticsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use {
        ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() }
    }
    private fun waitUntil(label: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30000
        while (!condition()) { check(System.currentTimeMillis() < deadline) { "Generated dedupe diagnostic fixture timed out: $label" }; Thread.sleep(80) }
    }
    private fun views(view: View): List<View> = buildList { add(view); if (view is ViewGroup) for (index in 0 until view.childCount) addAll(views(view.getChildAt(index))) }
    private fun generated(gray: Int, privateColor: Int): Bitmap = Bitmap.createBitmap(160, 96, Bitmap.Config.ARGB_8888).apply {
        Canvas(this).drawColor(Color.rgb(gray, gray, gray))
        val pixels = IntArray(40 * 96) { privateColor }; setPixels(pixels, 0, 40, 0, 0, 40, 96)
    }
    private fun cancel(context: Context) {
        listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload", "mote-capture-ocr", "mote-capture-ocr-recovery", "mote-image-dedupe-diagnostics-cleanup").forEach {
            WorkManager.getInstance(context).cancelUniqueWork(it).result.get(5, TimeUnit.SECONDS)
        }
    }
    private fun assertMasked(bytes: ByteArray) {
        val bitmap = requireNotNull(CapturePreview.decode(bytes, 640))
        try { assertTrue("Private color must be masked before diagnostic storage", Color.red(bitmap.getPixel(10, 40)) < 10 && Color.green(bitmap.getPixel(10, 40)) < 10 && Color.blue(bitmap.getPixel(10, 40)) < 10) }
        finally { bitmap.recycle() }
    }

    @Test fun pipelineKeepsMaskedAcceptedReferenceShowsMeasurementsAndDeletesLocalPairs() {
        val context = instrumentation.targetContext; val settings = Settings(context)
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!settings.enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val directory = File(context.noBackupFilesDir, "image-dedupe-diagnostics")
        require(directory.listFiles().orEmpty().isEmpty())
        val ids = mutableListOf<String>(); val pipeline = CapturePipeline(context) { }
        val start = Instant.now(); var sequence = 0L
        try {
            cancel(context); shell("dumpsys battery unplug"); shell("dumpsys battery set status 3")
            waitUntil("unplug fixture battery") { !Diagnostics.battery(context).second }
            val base = settings.read().copy(server = "", token = "", syncMode = "manual", wifiOnly = false,
                screenCollectionEnabled = true, notificationCollectionEnabled = false, deviceEventCollectionEnabled = false, mediaCollectionEnabled = false,
                chargingOnly = false, batteryPauseBelowPct = 0, ocrChargingOnly = true, localReviewUrl = "", metadataEnabled = false,
                masks = "0,0,0.25,1", excludedPackages = "", appCollectionRules = AppCollectionRules.LEGACY_DEFAULT,
                imageDedupeMode = "balanced", imageDedupeDiagnosticsEnabled = false, contentEncryptionEnabled = false, nsfw = settings.read().nsfw.copy(enabled = false))
            settings.save(base); settings.enabled = true
            fun capture(config: CollectorConfig, gray: Int, privateColor: Int = Color.RED, source: String = "screen"): JSONObject {
                val at = start.plusSeconds(++sequence).toString()
                pipeline.submit(generated(gray, privateColor), WindowSnapshot(setOf("dev.mote.generated"), "dev.mote.generated", true), config, at, sequence * 30000)
                waitUntil("pipeline $sequence") { !pipeline.isBusy() }
                val rows = context.queue().capturePage(start.toString(), start.plusSeconds(1000).toString(), limit = 60, source = source).getJSONArray("items")
                val item = (0 until rows.length()).map { rows.getJSONObject(it) }.singleOrNull { row ->
                    val samples = row.optJSONObject("stateSeries")?.optJSONArray("samples")
                    row.getString("capturedAt") == at || (samples != null && (0 until samples.length()).any { i -> samples.getJSONObject(i).getString("at") == at })
                }

                assertNotNull("Generated capture persisted: ${settings.message()}", item)
                return context.queue().capture(item!!.getString("id"))!!.also { ids += it.getString("id") }
            }
            capture(base, 240); val silentDuplicate = capture(base, 235, source = "activity")
            assertEquals("activity", silentDuplicate.getString("source"))
            assertNull(context.queue().image(silentDuplicate.getString("id")))
            assertTrue(context.imageDedupeDiagnostics().list().isEmpty()); assertTrue(directory.listFiles().orEmpty().isEmpty())

            val enabled = base.copy(imageDedupeDiagnosticsEnabled = true); settings.save(enabled)
            val accepted = capture(enabled, 240, Color.RED)
            val rejected1 = capture(enabled, 235, Color.GREEN)
            val rejected2 = capture(enabled, 230, Color.BLUE)
            val store = context.imageDedupeDiagnostics(); val pairs = store.list()
            assertEquals(2, pairs.size)
            val originalBytes = requireNotNull(context.queue().image(accepted.getString("id")))
            pairs.forEach { summary ->
                val pair = requireNotNull(store.read(summary.getString("id")))
                assertEquals(accepted.getString("id"), pair.metadata.getString("referenceCaptureId"))
                assertEquals("perceptual_match", pair.metadata.getString("reason"))
                assertEquals(100.0, pair.metadata.getDouble("hashSimilarityPercent"), 0.0)
                assertEquals(0, pair.metadata.getInt("hashDistance")); assertEquals(8, pair.metadata.getJSONObject("thresholds").getInt("maxHashDistance"))
                assertEquals(160, pair.metadata.getInt("width")); assertEquals(96, pair.metadata.getInt("sampleWidth"))
                assertArrayEquals("Every duplicate refers to the last accepted frame", originalBytes, pair.referenceImage)
                assertFalse(pair.referenceImage.contentEquals(pair.duplicateImage))
                assertMasked(pair.referenceImage); assertMasked(pair.duplicateImage)
            }
            for (event in listOf(rejected1, rejected2)) {
                assertNull(context.queue().image(event.getString("id")))
                assertEquals("", event.getString("ocrText"))
                assertFalse(event.toString().contains("referenceCaptureId")); assertFalse(event.toString().contains("hashSimilarityPercent"))
            }
            assertTrue(directory.listFiles().orEmpty().all { it.extension == "enc" })
            assertTrue(directory.listFiles().orEmpty().all { String(it.readBytes()).contains("referenceCaptureId") })

            val blocked = enabled.copy(excludedPackages = "dev.mote.generated"); settings.save(blocked)
            val queuedBefore = context.queue().depth()
            pipeline.submit(generated(230, Color.MAGENTA), WindowSnapshot(setOf("dev.mote.generated"), "dev.mote.generated", true), blocked)
            waitUntil("excluded frame") { !pipeline.isBusy() }
            assertEquals(queuedBefore, context.queue().depth()); assertEquals(2, store.list().size)
            settings.enabled = false

            ActivityScenario.launch(ImageDedupeDiagnosticsActivity::class.java).use { scenario ->
                fun shown(value: String): Boolean { var result = false; scenario.onActivity { result = views(it.window.decorView).filterIsInstance<TextView>().any { view -> view.isShown && view.text.toString().contains(value) } }; return result }
                waitUntil("pair list") { shown("本机保留 2 组") }
                scenario.onActivity { activity ->
                    assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                    views(activity.window.decorView).first { it.tag == "dedupe:${pairs[0].getString("id")}" }.performClick()
                }
                waitUntil("both diagnostic images") {
                    var ready = false
                    instrumentation.runOnMainSync {
                        val windows = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views)
                        val images = windows.filterIsInstance<ImageView>()
                        ready = images.any { it.contentDescription == "处理后基准图" && it.drawable != null } && images.any { it.contentDescription == "被去重图片" && it.drawable != null }
                        if (ready) assertTrue(windows.filterIsInstance<TextView>().any { it.text.toString().contains("不是模型置信度") })
                    }; ready
                }
                instrumentation.runOnMainSync {
                    android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().first { it.isShown && it.text.toString() == "删除这组图片" }.performClick()
                }
                waitUntil("single deletion") { store.list().size == 1 && shown("本机保留 1 组") }
                assertNull(store.read(pairs[0].getString("id")))
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString() == "清空全部诊断图片" }.performClick() }
                waitUntil("clear all") { store.list().isEmpty() && shown("本机保留 0 组") }
                assertTrue(directory.listFiles().orEmpty().isEmpty())
            }
            pipeline.pause("合成诊断 fixture 重启采样")
            settings.save(enabled); settings.enabled = true
            capture(enabled, 240); capture(enabled, 235); assertEquals(1, store.list().size)
            settings.save(base)
            assertTrue(store.list().isEmpty()); assertTrue(directory.listFiles().orEmpty().isEmpty())
            capture(base, 240); capture(base, 235, source = "activity"); assertTrue(store.list().isEmpty())
            File(context.filesDir, "dedupe-diagnostics-result.json").writeText(JSONObject().put("generatedOnly", true).put("passed", true)
                .put("pairsVerified", 2).put("lastAcceptedReference", true).put("privacyMasks", true).put("excludedFrameBlocked", true)
                .put("disabledNoRetention", true).put("localOnly", true).put("bothImagesAndMetricsDisplayed", true).put("deleteAndClear", true).toString())
        } finally {
            settings.enabled = false; waitUntil("pipeline cleanup") { !pipeline.isBusy() }; pipeline.close(); cancel(context)
            context.imageDedupeDiagnostics().clear()
            // Discover successful enqueues even when an assertion failed before its ID was recorded.
            val remaining = listOf("screen", "activity").flatMap { source ->
                val page = context.queue().capturePage(start.toString(), start.plusSeconds(1000).toString(), limit = 60, source = source).getJSONArray("items")
                (0 until page.length()).map { page.getJSONObject(it).getString("id") }
            }
            val cleanupIds = (ids + remaining).distinct()
            cleanupIds.forEach { id ->
                context.queue().capture(id)?.let { context.queue().acknowledge(id)
                    if (context.queue().capture(id) != null) { context.queue().completeOcr(id, "", "failed", 64 * 1024 * 1024); context.queue().acknowledgeOcr(id) }
                }
            }
            shell("dumpsys battery reset")
            val edit = prefs.edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value); is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value) } }; edit.commit()
        }
    }
}
