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
        val config = original.copy(server = "", token = "", syncMode = "manual", nsfw = original.nsfw.copy(enabled = false),
            localReviewUrl = "", masks = "", excludedPackages = "", appCollectionRules = AppCollectionRules.LEGACY_DEFAULT,
            diagnosticsEnabled = true, imageDedupeMode = "exact", imageDedupeDiagnosticsEnabled = false, ocrMode = "chinese", ocrAppModes = "{}", ocrChargingOnly = false)
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
            context.queue().peekBatch().forEach { context.queue().acknowledge(it.getString("id")) }
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
    @Test fun freshDefaultIsStickyAndLegacyUnconfiguredRulesRemainContent() {
        val prefs = context.getSharedPreferences("power-default-fixture", 0)
        val isolated = object : android.content.ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int) = if (name == "mote") prefs else super.getSharedPreferences(name, mode)
        }
        try {
            prefs.edit().clear().commit()
            assertEquals(AppCollectionRules.DEFAULT, Settings(isolated).read().appCollectionRules)
            prefs.edit().putBoolean("enabled", true).commit()
            assertEquals(AppCollectionRules.DEFAULT, Settings(isolated).read().appCollectionRules)
            prefs.edit().clear().putInt("interval", 30).commit()
            assertEquals(AppCollectionRules.LEGACY_DEFAULT, Settings(isolated).read().appCollectionRules)
        } finally { prefs.edit().clear().commit() }
    }
    private fun views(view: View): List<View> = buildList {
        add(view); if (view is ViewGroup) for (i in 0 until view.childCount) addAll(views(view.getChildAt(i)))
    }
    @Test fun ocrModeControlDisplaysSavedSelection() {
        val settings = Settings(context); val original = settings.read()
        try {
            settings.save(original.copy(ocrMode = "dual"))
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString() == "本机" }.performClick()
                    views(activity.window.decorView).single { it.isShown && it.tag == "menu:采集与存储" }.performClick()
                    views(activity.window.decorView).single { it.isShown && it.tag == "menu:图像与文字识别" }.performClick()
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
