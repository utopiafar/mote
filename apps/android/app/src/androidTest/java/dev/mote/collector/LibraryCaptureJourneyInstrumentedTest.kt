package dev.mote.collector

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.UUID

/** Run after the native shared-image save and actual WorkManager upload fixtures. */
@RunWith(AndroidJUnit4::class)
class LibraryCaptureJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 30000
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(60) }
    }
    private fun screenshot(activity: MainActivity) {
        val root = activity.window.decorView
        val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(image))
        File(context.filesDir, "library-fixture").apply { mkdirs() }.resolve("joined-captures.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle()
    }
    @Test fun actualSavedAndUploadedRecordHasOneCardAndKeepsOriginalAndSessionBoundaries() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("recordEditorFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        require(!Settings(context).enabled && !ProjectionService.running && CaptureAccessibilityService.instance == null)
        val server = requireNotNull(args.getString("uiJourneyServer")); val token = requireNotNull(args.getString("uiJourneyToken"))
        require(java.net.URI(server).host in setOf("10.0.2.2", "127.0.0.1", "localhost"))
        val settings = Settings(context); val api = CentralClient(server, token)
        assertEquals("Fixture must use the active Central", server, CentralAccess.resolve(context).server)
        assertEquals("owner", CentralAccess.requireClient(context).get("/api/connections/self").getJSONObject("credential").getString("scope"))
        assertEquals("captures", CentralAccess.requireClient(context).post("/api/library/device-view", JSONObject().put("after", "1970-01-01T00:00:00Z").put("before", Instant.now().plusSeconds(1).toString())).getString("coverage"))
        val page = context.queue().capturePage("1970-01-01T00:00:00Z", Instant.now().plusSeconds(1).toString(), source = "note")
        val local = (0 until page.getJSONArray("items").length()).map { page.getJSONArray("items").getJSONObject(it) }.single { it.optString("textPreview") == "My separate generated comment" }
        val id = local.getString("id")
        assertTrue(context.queue().capture(id)!!.getBoolean("uploaded"))
        assertEquals("Generated third-party original", api.get("/api/capture-browser/$id").getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
        val remoteId = UUID.randomUUID().toString()
        api.post("/api/captures", JSONObject().put("id", remoteId).put("deviceId", "generated-other-device").put("deviceName", "Generated other device").put("platform", "android")
            .put("source", "note").put("capturedAt", Instant.now().toString()).put("durationMs", 0).put("ocrText", "Generated remote-only original"))
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            fun shown(text: String): Boolean { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.contains(text) } }; return found }
            fun rows(id: String): Int { var count = 0; scenario.onActivity { activity -> count = views(activity.window.decorView).count { it.isShown && it.tag == "library-record:$id" } }; return count }
            fun location(position: Int) { scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("资料位置") }.setSelection(position) } }
            waitFor("one exact joined record") { shown("本机与中央可读") && rows(id) == 1 && rows(remoteId) == 1 }
            assertEquals(0, context.queue().pendingSync().count)
            location(1); waitFor("local location filter") { rows(id) == 1 && rows(remoteId) == 0 }
            location(2); waitFor("Central location filter") { rows(id) == 1 && rows(remoteId) == 1 }
            scenario.recreate(); waitFor("location and actual data restored after Activity recreation") { rows(id) == 1 && rows(remoteId) == 1 && shown("本机与中央可读") }
            scenario.onActivity { activity ->
                val row = views(activity.window.decorView).single { it.isShown && it.tag == "library-record:$id" }
                assertTrue(views(row).filterIsInstance<TextView>().any { it.text.contains("My separate generated comment") })
                screenshot(activity)
            }
            // No reader fallback: a Central-only card opens the exact remote ID.
            val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
            try {
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "library-record:$remoteId" }.performClick() }
                val reader = instrumentation.waitForMonitorWithTimeout(monitor, 15000) as CaptureRecordsActivity
                waitFor("actual remote original reader") {
                    var found = false; instrumentation.runOnMainSync { found = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().any { it.isShown && it.text.contains("Generated remote-only original") } }; found
                }
                instrumentation.runOnMainSync { reader.finish() }
                waitFor("return preserves location and joined rows") { rows(id) == 1 && rows(remoteId) == 1 }
            } finally { instrumentation.removeMonitor(monitor) }
            // Log out while the page is alive: remote bodies must disappear, local originals survive.
            location(0); settings.signOut()
            scenario.recreate(); waitFor("logout clears Central projection") { shown("中央状态未知") && rows(remoteId) == 0 }
            location(0); waitFor("local readable after logout") { rows(id) == 1 && rows(remoteId) == 0 }
            settings.signIn(server, token, 86400000); scenario.recreate()
            waitFor("owner reconnect reloads same exact records") { rows(id) == 1 && rows(remoteId) == 1 && shown("本机与中央可读") }
            scenario.onActivity { activity -> repeat(3) { views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text == MoteI18n.text("刷新") && it.isClickable }.performClick() } }
            waitFor("duplicate refresh cannot duplicate cards") { rows(id) == 1 && rows(remoteId) == 1 && shown("本机与中央可读") }
        }
        assertEquals(0, context.queue().pendingSync().count)
        assertEquals("Generated third-party original", context.queue().capture(id)!!.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
        assertEquals(1, context.recordDraftStore().record(id)!!.getJSONArray("attachments").length())
    }
    @Test fun differentObservationVersionsKeepTheCentralReaderExplicit() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("recordEditorFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        require(!Settings(context).enabled && !ProjectionService.running && CaptureAccessibilityService.instance == null)
        val server = requireNotNull(args.getString("uiJourneyServer"))
        val api = CentralClient(server, requireNotNull(args.getString("uiJourneyToken")))
        assertEquals(server, CentralAccess.resolve(context).server)
        val settings = Settings(context); val previous = settings.read()
        settings.save(previous.copy(syncPaused = true))
        try {
        val id = UUID.randomUUID().toString(); val at = Instant.now().minusSeconds(5).toString()
        val original = JSONObject().put("id", id).put("deviceId", Settings(context).deviceId).put("deviceName", "Generated version phone").put("platform", "android")
            .put("source", "activity").put("capturedAt", at).put("durationMs", 1000).put("appId", "generated.versions.$id").put("appName", "Generated version fixture")
            .put("privacy", JSONObject().put("mode", "none").put("collection", "activity"))
            .put("stateSeries", JSONObject().put("version", 1).put("samples", org.json.JSONArray().put(JSONObject().put("at", at).put("durationMs", 1000))))
        assertEquals(id, context.queue().enqueue(original, null, 1000000))
        api.post("/api/captures", original)
        val newer = JSONObject(original.toString()).put("id", UUID.randomUUID().toString()).put("capturedAt", Instant.now().minusSeconds(2).toString()).put("durationMs", 2000)
        newer.remove("stateSeries")
        assertEquals(id, context.queue().enqueue(newer, null, 1000000))
        context.queue().flushStages(1000000)
        assertEquals(2, context.queue().capture(id)!!.getJSONObject("stateSeries").getJSONArray("samples").length())
        assertEquals(1, LibraryCaptureProjection.observations(api.get("/api/capture-browser/$id")))
        val beforePending = context.queue().pendingSync().count
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            fun card(): View? { var result: View? = null; scenario.onActivity { result = views(it.window.decorView).singleOrNull { view -> view.isShown && view.tag == "library-record:$id" } }; return result }
            waitFor("different version card has explicit Central reader") {
                var found = false; scenario.onActivity { activity ->
                    val row = views(activity.window.decorView).singleOrNull { it.isShown && it.tag == "library-record:$id" }
                    found = row != null && views(row).filterIsInstance<TextView>().any { it.text.contains("中央另有版本") }
                }; found
            }
            val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
            try {
                scenario.onActivity { activity ->
                    val row = views(activity.window.decorView).single { it.isShown && it.tag == "library-record:$id" }
                    views(row).filterIsInstance<TextView>().single { it.text == MoteI18n.text("查看中央版本") }.performClick()
                }
                val reader = instrumentation.waitForMonitorWithTimeout(monitor, 15000) as CaptureRecordsActivity
                assertTrue(reader.intent.getBooleanExtra("recordRemote", false))
                assertEquals(1, reader.intent.getIntExtra("recordObservationCount", -1))
                assertEquals(api.get("/api/capture-browser/$id").getString("libraryVersion"), reader.intent.getStringExtra("recordVersion"))
                instrumentation.runOnMainSync { reader.finish() }
                waitFor("return retains distinct-version card") { card() != null }
                scenario.recreate(); waitFor("recreation retains distinct-version card") { card() != null }
            } finally { instrumentation.removeMonitor(monitor) }
        }
        assertEquals(beforePending, context.queue().pendingSync().count)
        assertEquals(2, context.queue().capture(id)!!.getJSONObject("stateSeries").getJSONArray("samples").length())
        assertEquals(1, LibraryCaptureProjection.observations(api.get("/api/capture-browser/$id")))
        } finally { settings.save(previous) }
    }

    @Test fun offlineCentralKeepsLocalOriginalAndReturnAfterRecreation() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("libraryOfflineFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        require(!Settings(context).enabled && !ProjectionService.running && CaptureAccessibilityService.instance == null)
        assertTrue("This fixture requires the actual Central service to be stopped", runCatching { CentralAccess.requireClient(context).get("/api/connections/self") }.isFailure)
        val page = context.queue().capturePage("1970-01-01T00:00:00Z", Instant.now().plusSeconds(1).toString(), source = "note")
        val id = (0 until page.getJSONArray("items").length()).map { page.getJSONArray("items").getJSONObject(it) }.single { it.optString("textPreview") == "My separate generated comment" }.getString("id")
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            fun localCardShown(): Boolean { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.tag == "library-record:$id" } }; return found }
            waitFor("offline local original remains visible") { localCardShown() }
            scenario.recreate(); waitFor("offline local original restored") { localCardShown() }
            scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("资料类型") }.setSelection(8) }
            waitFor("empty source filter has an explicit empty state") {
                var empty = false; scenario.onActivity { activity -> empty = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.contains("这里还没有内容") } }; !localCardShown() && empty
            }
            scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("资料类型") }.setSelection(4) }
            waitFor("return from empty source restores local note") { localCardShown() }
            val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
            try {
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "library-record:$id" }.performClick() }
                val reader = instrumentation.waitForMonitorWithTimeout(monitor, 15000) as CaptureRecordsActivity
                assertFalse(reader.intent.getBooleanExtra("recordRemote", false))
                waitFor("offline actual local original reader") {
                    var found = false; instrumentation.runOnMainSync { found = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().any { it.isShown && it.text.contains("My separate generated comment") } }; found
                }
                instrumentation.runOnMainSync { reader.finish() }
                waitFor("cancel reader returns to offline list") { localCardShown() }
            } finally { instrumentation.removeMonitor(monitor) }
        }
    }

    @Test fun serverDenialAfterLoadingDropsRemoteRowsWithoutLosingLocalOriginal() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("libraryDenialFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        require(!Settings(context).enabled && !ProjectionService.running && CaptureAccessibilityService.instance == null)
        val server = requireNotNull(args.getString("uiJourneyServer")); val token = requireNotNull(args.getString("uiJourneyToken"))
        Settings(context).signIn(server, token, 86400000)
        val api = CentralClient(server, token)
        val page = context.queue().capturePage("1970-01-01T00:00:00Z", Instant.now().plusSeconds(1).toString(), source = "note")
        val id = (0 until page.getJSONArray("items").length()).map { page.getJSONArray("items").getJSONObject(it) }.single { it.optString("textPreview") == "My separate generated comment" }.getString("id")
        repeat(21) { index ->
            api.post("/api/captures", JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", "generated-denial-device").put("deviceName", "Generated denial device").put("platform", "android")
                .put("source", "note").put("capturedAt", Instant.now().minusSeconds(1).toString()).put("durationMs", 0).put("ocrText", "Generated remote denial original $index"))
        }
        api.post("/api/fixture/library-denial", JSONObject().put("mode", "none"))
        try {
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
                fun shown(text: String): Boolean { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.contains(text) } }; return found }
                fun click(label: String) { scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text == MoteI18n.text(label) && it.isClickable }.performClick() } }
                fun location(position: Int) { scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("资料位置") }.setSelection(position) } }
                for (mode in listOf("forbidden", "revoked")) {
                    api.post("/api/fixture/library-denial", JSONObject().put("mode", "none"))
                    click("刷新")
                    waitFor("remote body and exact local/Central availability are initially loaded") { shown("Generated remote denial original") && shown("本机与中央可读") }
                    val generation = CentralAccess.resolve(context).generation
                    api.post("/api/fixture/library-denial", JSONObject().put("mode", mode))
                    // Loading the next page retains the first page until the server denies it.
                    waitFor("next remote page is actionable") { var enabled = false; scenario.onActivity { activity -> enabled = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text == MoteI18n.text("加载更多") && it.isEnabled } }; enabled }
                    click("加载更多")
                    try {
                        waitFor("server denial clears previously loaded remote bodies and read claims") {
                            !shown("Generated remote denial original") && !shown("本机与中央可读") && shown("本机可读 · 中央状态未知")
                        }
                    } catch (error: Throwable) {
                        scenario.onActivity { activity -> error.addSuppressed(IllegalStateException(views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.joinToString(" | ") { it.text.toString() })) }
                        throw error
                    }
                    if (mode == "forbidden") assertEquals("403 must clear remote content in the same signed-in session", generation, CentralAccess.resolve(context).generation)
                    else assertNull("The existing HTTP 401 handler invalidates the revoked session", CentralAccess.resolve(context).client)
                    location(2)
                    waitFor("Central filter has no stale readable row after denial") { shown("这里还没有内容") && !shown("My separate generated comment") }
                    location(0)
                    waitFor("local original survives server denial") { shown("My separate generated comment") }
                }
                val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
                try {
                    scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "library-record:$id" }.performClick() }
                    val reader = instrumentation.waitForMonitorWithTimeout(monitor, 15000) as CaptureRecordsActivity
                    assertFalse(reader.intent.getBooleanExtra("recordRemote", false))
                    waitFor("local original opens after server denial") {
                        var found = false; instrumentation.runOnMainSync { found = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().any { it.isShown && it.text.contains("My separate generated comment") } }; found
                    }
                    instrumentation.runOnMainSync { reader.finish() }
                    waitFor("reader return retains local original") { shown("My separate generated comment") }
                } finally { instrumentation.removeMonitor(monitor) }
            }
        } finally { api.post("/api/fixture/library-denial", JSONObject().put("mode", "none")) }
        assertEquals("Generated third-party original", context.queue().capture(id)!!.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
    }

}
