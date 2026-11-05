package dev.mote.collector

import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.UUID

/** Captures the UA15 library/memory pairs on a generated Dev profile. */
@RunWith(AndroidJUnit4::class)
class Ua15AcceptanceCaptureInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun until(label: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(50) }
        throw AssertionError(label)
    }
    private fun frames(scenario: ActivityScenario<out android.app.Activity>) {
        val latch = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5, java.util.concurrent.TimeUnit.SECONDS))
    }
    private fun save(activity: android.app.Activity, name: String) {
        val root = activity.window.decorView
        val image = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            val canvas = android.graphics.Canvas(image)
            root.draw(canvas)
            val origin = IntArray(2); root.getLocationOnScreen(origin)
            val overlays = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it !== root && it.isShown }
            if (overlays.isNotEmpty()) canvas.drawColor(android.graphics.Color.argb(82, 0, 0, 0))
            overlays.forEach { overlay ->
                val at = IntArray(2); overlay.getLocationOnScreen(at)
                canvas.save(); canvas.translate((at[0] - origin[0]).toFloat(), (at[1] - origin[1]).toFloat()); overlay.draw(canvas); canvas.restore()
            }
            File(context.filesDir, "ua15-visual").apply { mkdirs() }.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { image.recycle() }
    }
    private fun seedLibrary() {
        val queue = context.queue(); val device = Settings(context).deviceId
        val base = Instant.now().minusSeconds(300)
        val image = java.io.ByteArrayOutputStream().use { out -> android.graphics.Bitmap.createBitmap(16, 16, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(0xffd9d2c4.toInt()) }.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out); out.toByteArray() }
        fun note(title: String, at: Instant, appName: String = "Generated library") = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("deviceId", device).put("deviceName", "Generated UA15 phone").put("platform", "android")
            .put("source", "note").put("windowTitle", title).put("appName", appName).put("capturedAt", at.toString())
            .put("durationMs", 0).put("ocrText", title)
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))
        val photo = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("deviceId", device).put("deviceName", "Generated UA15 phone").put("platform", "android")
            .put("source", "screen").put("windowTitle", "白板：第三季度路线图").put("appName", "白板").put("capturedAt", base.toString())
            .put("durationMs", 0).put("ocrText", "白板：第三季度路线图")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))
        val recording = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("deviceId", device).put("deviceName", "Generated UA15 phone").put("platform", "android")
            .put("source", "media").put("appId", "generated.phone").put("appName", "和陈老师的电话").put("capturedAt", base.minusSeconds(120).toString())
            .put("durationMs", 40_000)
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))
            .put("metadata", JSONObject().put("media", JSONObject().put("status", "available").put("sessions", org.json.JSONArray().put(JSONObject()
                .put("sessionId", UUID.randomUUID().toString()).put("appId", "generated.phone").put("appName", "和陈老师的电话").put("playbackState", "playing")))))
        val notification = JSONObject()
            .put("id", UUID.randomUUID().toString()).put("deviceId", device).put("deviceName", "Generated UA15 phone").put("platform", "android")
            .put("source", "notification").put("appId", "com.sf").put("appName", "顺丰：包裹已放入驿站").put("capturedAt", base.minusSeconds(86_400).toString())
            .put("durationMs", 0)
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))
            .put("metadata", JSONObject().put("version", 1).put("observedAt", base.minusSeconds(86_400).toString())
                .put("collector", JSONObject().put("method", "notification_listener"))
                .put("observation", JSONObject().put("sessionId", UUID.randomUUID().toString()).put("elapsedRealtimeMs", 0))
                .put("notification", JSONObject().put("action", "posted").put("notificationKey", "a".repeat(64))
                    .put("postedAt", base.minusSeconds(86_400).toString()).put("ongoing", false).put("groupSummary", false)))
        val rows = listOf(
            photo,
            recording,
            note("暖气费按实际用量分摊，月底前给账单照片", base.minusSeconds(240)),
            note("低温慢烤牛肋排的时间表", base.minusSeconds(360), "seriouseats.com"),
            notification,
            note("租房合同 2026.pdf", base.minusSeconds(86_500)))
        rows.forEach { event -> queue.enqueue(event, if (event.optString("source") == "screen") image else null, 1_000_000) }
        LocalStatusProducer.get(context).refresh()
        until("seeded local records") { LocalStatusProducer.get(context).state.value.active?.records == rows.size }
    }
    @Test fun libraryPairs() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua15Fixture") == "true")
        MoteI18n.select(context, "zh-CN")
        val server = InstrumentationRegistry.getArguments().getString("ua15Server")
        val token = InstrumentationRegistry.getArguments().getString("ua15Token")
        if (server != null && token != null) Settings(context).signIn(server, token, 86_400_000)
        if (context.queue().inventory().records == 0) seedLibrary()
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            until("seeded library rows") { var yes = false; scenario.onActivity { a -> yes = views(a.window.decorView).any { it.isShown && it.tag?.toString()?.startsWith("library-record:") == true } }; yes }
            frames(scenario); instrumentation.waitForIdleSync()
            scenario.onActivity { save(it, "library-light") }
            scenario.onActivity { a -> views(a.window.decorView).single { it.tag == "library-filter" }.performClick() }
            until("library filter sheet") { var yes = false; scenario.onActivity { yes = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).any { it.isShown && it.tag == "library-location:local" } }; yes }
            frames(scenario); scenario.onActivity { save(it, "library-filter-light") }
            scenario.onActivity { android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).single { it.isShown && it.contentDescription?.toString() == MoteI18n.text("关闭") }.performClick() }
            MoteAppearance.select(context, AppearancePreference.DARK); scenario.recreate(); scenario.awaitMainUi()
            until("dark library rows") { var yes = false; scenario.onActivity { a -> yes = views(a.window.decorView).any { it.isShown && it.tag?.toString()?.startsWith("library-record:") == true } }; yes }
            frames(scenario); scenario.onActivity { save(it, "library-dark") }
        }
        MoteAppearance.select(context, AppearancePreference.LIGHT)
    }
    @Test fun memoryPairs() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua15Fixture") == "true")
        val server = requireNotNull(InstrumentationRegistry.getArguments().getString("ua15Server"))
        val token = requireNotNull(InstrumentationRegistry.getArguments().getString("ua15Token"))
        MoteI18n.select(context, "zh-CN")
        Settings(context).signIn(server, token, 86_400_000)
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "memories")).use { scenario ->
            until("generated memories") { var yes = false; scenario.onActivity { a -> yes = views(a.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == "租房押金" } }; yes }
            frames(scenario); instrumentation.waitForIdleSync()
            scenario.onActivity { save(it, "memories-light") }
            scenario.onActivity { a -> views(a.window.decorView).single { it.tag == "memory-filter" }.performClick() }
            until("memory filter sheet") { var yes = false; scenario.onActivity { yes = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).any { it.isShown && it.contentDescription?.toString() == MoteI18n.text("关闭") } }; yes }
            frames(scenario); scenario.onActivity { save(it, "memories-filter-light") }
            scenario.onActivity { android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).single { it.isShown && it.contentDescription?.toString() == MoteI18n.text("关闭") }.performClick() }
            scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<EditText>().single { it.tag == "memory-search" }.apply { requestFocus(); setText("押金"); setSelection(2) } }
            until("memory search results") { var yes = false; scenario.onActivity { a -> yes = views(a.window.decorView).count { it.isShown && it.tag?.toString()?.startsWith("topic-memory:") == true } == 2 && views(a.window.decorView).filterIsInstance<TextView>().none { it.isShown && it.text.toString() == "暖气费分摊" } }; yes }
            frames(scenario); scenario.onActivity { save(it, "memories-search-light") }
            scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<EditText>().single { it.tag == "memory-search" }.setText("") }
            MoteAppearance.select(context, AppearancePreference.DARK); scenario.recreate()
            until("dark memories") { var yes = false; scenario.onActivity { a -> yes = views(a.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == "租房押金" } }; yes }
            frames(scenario); scenario.onActivity { save(it, "memories-dark") }
        }
        MoteAppearance.select(context, AppearancePreference.LIGHT)
    }
}
