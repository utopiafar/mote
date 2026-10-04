package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/** No device screenshots, external server, credentials or local VLM are used. */
@RunWith(AndroidJUnit4::class)
class PowerOptimizationInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    @Before fun generatedEmulatorOnly() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
        require(context.queue().depth() == 0)
    }
    private fun bitmap() = Bitmap.createBitmap(640, 320, Bitmap.Config.ARGB_8888).apply {
        Canvas(this).apply {
            drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 42f }
            drawText("MOTE 2048", 24f, 90f, paint)
            drawText("合成测试 阅读记录", 24f, 170f, paint)
        }
    }
    private fun awaitPipeline(pipeline: CapturePipeline) {
        val end = System.currentTimeMillis() + 30_000
        while (pipeline.isBusy()) { check(System.currentTimeMillis() < end); Thread.sleep(50) }
    }
    @Test fun earlyDuplicatesDoNotRunOcrOrCarryContentAndConfigurationInvalidatesReference() {
        val settings = Settings(context); val original = settings.read()
        val diagnostics = context.getSharedPreferences("numeric_diagnostics", 0)
        val firstCalls = diagnostics.getLong("ocrCalls", 0)
        val firstSkips = diagnostics.getLong("earlySkippedFrames", 0)
        val config = original.copy(server = "", token = "", syncMode = "manual",
            masks = "", excludedPackages = "", appCollectionRules = AppCollectionRules.CONTENT_DEFAULT,
            diagnosticsEnabled = true, imageDedupeMode = "exact", imageDedupeDiagnosticsEnabled = false, ocrMode = "chinese", ocrAppModes = "{}")
        val pipeline = CapturePipeline(context) { }
        try {
            settings.save(config); settings.enabled = true
            val windows = WindowSnapshot(setOf("fixture.reader"), "fixture.reader", true)
            repeat(3) { pipeline.submit(bitmap(), windows, config); awaitPipeline(pipeline) }
            val records = listOf("screen","activity").flatMap { source ->
                val page=context.queue().capturePage("2000-01-01T00:00:00Z","2100-01-01T00:00:00Z",limit=60,source=source).getJSONArray("items")
                (0 until page.length()).map { context.queue().capture(page.getJSONObject(it).getString("id"))!! }
            }
            assertEquals(settings.message(), 3, records.sumOf { it.optJSONObject("stateSeries")?.optJSONArray("samples")?.length() ?: 1 })
            assertEquals(1, records.count { it.getString("source") == "screen" })
            records.filter { it.getString("source") == "activity" }.forEach {
                assertFalse(it.has("imageBase64")); assertFalse(it.has("ocrText"))
                assertEquals("none", it.getJSONObject("privacy").getString("mode"))
            }
            assertEquals(firstCalls, diagnostics.getLong("ocrCalls", 0))
            assertEquals(firstSkips + 2, diagnostics.getLong("earlySkippedFrames", 0))
            assertEquals("", records.single { it.getString("source") == "screen" }.getString("ocrText"))
            val next = config.copy(masks = "0,0,0.1,0.1"); settings.save(next)
            pipeline.submit(bitmap(), windows, next); awaitPipeline(pipeline)
            assertEquals(firstCalls, diagnostics.getLong("ocrCalls", 0))
            // A different full window identity must not reuse even identical pixels.
            pipeline.submit(bitmap(), windows.copy(packages = setOf("fixture.reader", "fixture.overlay")), next); awaitPipeline(pipeline)
            assertEquals(firstCalls, diagnostics.getLong("ocrCalls", 0))
        } finally {
            settings.enabled = false; pipeline.close()
            // A transport batch deliberately excludes pixels after a metadata window.
            // Delete every generated row so later fixture guards see a clean queue.
            val generated = context.queue().capturePage("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", limit = 60, source = "").getJSONArray("items")
            (0 until generated.length()).forEach { context.queue().acknowledge(generated.getJSONObject(it).getString("id")) }
            settings.save(original)
        }
    }
    @Test fun configurationSnapshotSurvivesStatusWritesButReflectsDirectPrivacyChanges() {
        val settings = Settings(context); val original = settings.read()
        try {
            assertSame(original, Settings(context).read())
            settings.status("paused", "generated cache fixture")
            assertSame(original, settings.read())
            context.getSharedPreferences("mote", 0).edit().putString("masks", "0,0,1,0.1").commit()
            assertNotSame(original, settings.read())
            assertEquals("0,0,1,0.1", settings.read().masks)
        } finally { settings.save(original) }
    }
    @Test fun repeatedVisibleNotificationStatePublishesAndCancelsOnlyOnce() {
        val settings = Settings(context); val original = settings.read()
        try {
            settings.save(original.copy(diagnosticsEnabled = true))
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
            Notifications.clear(context); Notifications.clearMedia(context); Notifications.showEvents(context, null)
            val counters = context.getSharedPreferences("numeric_diagnostics", 0)
            val publishes = counters.getLong("notificationPublishes", 0)
            repeat(20) { Notifications.show(context, "generated notification fixture") }
            assertEquals(publishes + 1, counters.getLong("notificationPublishes", 0))
            Notifications.show(context, "generated state changed")
            assertEquals(publishes + 2, counters.getLong("notificationPublishes", 0))
            val cancels = counters.getLong("notificationCancels", 0)
            repeat(20) { Notifications.clear(context) }
            assertEquals(cancels + 1, counters.getLong("notificationCancels", 0))
        } finally { Notifications.clear(context); settings.save(original) }
    }
    @Test fun freshDefaultIsStickyAndMissingRulesNeverInferContentFromOtherPreferences() {
        val prefs = context.getSharedPreferences("power-default-fixture", 0)
        val isolated = object : android.content.ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int) = if (name == "mote") prefs else super.getSharedPreferences(name, mode)
        }
        try {
            prefs.edit().clear().commit()
            assertEquals(AppCollectionRules.DEFAULT, Settings(isolated).read().appCollectionRules)
            prefs.edit().putBoolean("enabled", true).commit()
            assertEquals(AppCollectionRules.DEFAULT, Settings(isolated).read().appCollectionRules)
            prefs.edit().remove("appCollectionRules").putInt("interval", 30).commit()
            assertThrows(IllegalStateException::class.java) { Settings(isolated) }
        } finally { prefs.edit().clear().commit() }
    }
    private fun views(view: View): List<View> = buildList {
        add(view); if (view is ViewGroup) for (i in 0 until view.childCount) addAll(views(view.getChildAt(i)))
    }
    @Test fun pageOnlyForegroundSamplesPreserveMeasuredTimeWithoutImagesOrOcr() {
        val settings = Settings(context); val original = settings.read()
        val config = original.copy(server = "", token = "", syncMode = "manual", intervalSeconds = 15,
            metadataEnabled = false, masks = "", excludedPackages = "", uiPageMode = "page_only",
            appCollectionRules = AppCollectionRules.CONTENT_DEFAULT, chargingOnly = false, batteryPauseBelowPct = 0, uploadedRetentionDays = 0)
        val pipeline = CapturePipeline(context) { }
        val queued = mutableListOf<String>()
        try {
            settings.save(config); settings.enabled = true
            val windows = WindowSnapshot(setOf("generated.page.fixture"), "generated.page.fixture", true)
            repeat(3) { index ->
                pipeline.submitPageActivity(windows, config, java.time.Instant.parse("2026-10-05T00:00:00Z").plusSeconds(index * 15L).toString(), index * 15_000L)
                awaitPipeline(pipeline)
            }
            val page = context.queue().capturePage("2026-10-05T00:00:00Z", "2026-10-05T01:00:00Z", limit = 60, source = "activity").getJSONArray("items")
            val records = (0 until page.length()).map { context.queue().capture(page.getJSONObject(it).getString("id"))!! }.filter { it.optString("appId") == "generated.page.fixture" }
            queued.addAll(records.map { it.getString("id") }); assertTrue(records.isNotEmpty())
            val samples = records.flatMap { record -> record.optJSONObject("stateSeries")?.getJSONArray("samples")?.let { series -> (0 until series.length()).map(series::getJSONObject) } ?: listOf(record) }
            assertEquals(listOf(0L, 15_000L, 15_000L), samples.map { it.getLong("durationMs") }.sorted())
            for (record in records) { assertEquals("activity", record.getString("source")); assertFalse(record.has("ocrText")); assertFalse(record.has("imageMime")); assertNull(context.queue().image(record.getString("id"))) }
            pipeline.pause("generated pause")
            pipeline.submitPageActivity(WindowSnapshot(setOf("generated.page.afterpause"), "generated.page.afterpause", true), config, "2026-10-05T00:01:00Z", 60_000); awaitPipeline(pipeline)
            val after = context.queue().capturePage("2026-10-05T00:01:00Z", "2026-10-05T00:02:00Z", limit = 60, source = "activity").getJSONArray("items")
            assertEquals(1, after.length()); queued.add(after.getJSONObject(0).getString("id")); assertEquals(0L, after.getJSONObject(0).getLong("durationMs"))
        } finally { settings.enabled = false; pipeline.close(); queued.distinct().forEach { context.queue().acknowledge(it) }; settings.save(original) }
    }
    @Test fun retiredStoredModelControlsAreRemovedWithoutChangingPrivacyConsent() {
        val settings = Settings(context); val original = settings.read(); val prefs = context.getSharedPreferences("mote", 0)
        try {
            val config = original.copy(uploadGate = UploadGateConfig(blockedText = "generated literal", failureAction = "hold"))
            settings.save(config)
            prefs.edit().putBoolean("nsfwEnabled", true).putString("qwenPolicy", "retired generated policy").putString("localReview", "http://127.0.0.1:1/review").commit()
            val current = Settings(context).read(); assertEquals(config, current)
            for (key in listOf("nsfwEnabled", "qwenPolicy", "localReview")) assertFalse(prefs.contains(key))
        } finally { settings.save(original) }
    }
    @Test fun privacyReviewEngineControlDisplaysSavedSelection() {
        val settings = Settings(context); val original = settings.read()
        try {
            settings.save(original.copy(ocrMode = "dual"))
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString() == "本机" }.performClick()
                    views(activity.window.decorView).single { it.isShown && it.tag == "menu:隐私与应用规则" }.performClick()
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == "高级：截图文字隐私审查" }.performClick()
                    val selectors = views(activity.window.decorView).filterIsInstance<Spinner>()
                    val ocr = selectors.single { it.adapter.count == 3 && it.adapter.getItem(0).toString() == "中文与拉丁文（单引擎）" }
                    assertEquals(2, ocr.selectedItemPosition)
                    ocr.setSelection(1); assertEquals("仅拉丁文", ocr.selectedItem.toString())
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == "保存设置" }.performClick()
                }
                val deadline = System.currentTimeMillis() + 30_000
                while (settings.read().ocrMode != "latin") { check(System.currentTimeMillis() < deadline); Thread.sleep(50) }
                assertEquals("latin", Settings(context).read().ocrMode)
            }
        } finally { settings.save(original) }
    }
}
