package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.lifecycle.Lifecycle
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Home 403 lifecycle on the production views, against a generated loopback Central: a revoked
 * read withdraws its rows, the retry affordance survives leaving and returning, a callback that
 * lands after a pause cannot strand the section, a same-generation resolution failure keeps the
 * denied affordance ready, and an explicit retry recovers the same session.
 */
@RunWith(AndroidJUnit4::class)
class HomeForbiddenJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val conversation = "6c1a8d2f-4e5b-4c7a-9d3e-1f2a3b4c5d6e"
    private val action = "2f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun inStage(vararg stages: Stage): List<Activity> {
        val found = mutableListOf<Activity>()
        instrumentation.runOnMainSync { stages.forEach { found += ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) } }
        return found
    }
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(100) }
        val labels = inStage(Stage.RESUMED).firstOrNull()?.let { top -> var value = ""; instrumentation.runOnMainSync { value = top.javaClass.simpleName + ": " + shown(top).filterIsInstance<TextView>().map { it.text.toString() }.joinToString(" | ") }; value }
        fail("$description — $labels")
    }
    private fun onTop(description: String, check: (Activity) -> Boolean): Activity {
        var top: Activity? = null
        until(description) { inStage(Stage.RESUMED).firstOrNull()?.let { activity -> var ok = false; instrumentation.runOnMainSync { ok = check(activity) }; if (ok) top = activity; ok } ?: false }
        return top!!
    }
    /** A view inside one home section (whose root carries [sectionTag]); null when absent. */
    private fun inside(activity: Activity, sectionTag: String, find: (View) -> Boolean): View? {
        val section = shown(activity).firstOrNull { it.tag == sectionTag } ?: return null
        return views(section).filter { it.isShown }.firstOrNull(find)
    }
    private fun clickInside(activity: Activity, sectionTag: String, find: (View) -> Boolean) =
        instrumentation.runOnMainSync { requireNotNull(inside(activity, sectionTag, find)).performClick() }
    private fun retry(activity: Activity, sectionTag: String) = inside(activity, sectionTag) { it is TextView && it.text == MoteI18n.text("重试") && it.isClickable }
    private fun tagged(activity: Activity, tag: String) = shown(activity).any { it.tag == tag }
    private fun hasText(activity: Activity, value: String) = shown(activity).any { it is TextView && it.text.toString() == value }
    private fun emptyConversationLabel(activity: Activity) = inside(activity, "home-recent-conversations") { it is TextView && it.text.toString().startsWith("还没有对话") }

    private fun connect(fixture: Fixture) {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = fixture.origin, token = "generated-journey-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
        File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)).deleteRecursively()
    }
    private fun disconnect() {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = "", token = "", authSignedOut = true))
    }
    /**
     * Makes the next [CentralAccess.resolve] throw through the real endpoint validation while the
     * session generation stays untouched: `debugHttp` is not part of the generation hash, so the
     * same session either keeps or regains its denied retry, never a silent re-read.
     */
    private fun blockResolve() {
        check(context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().putBoolean("debugHttp", false).commit())
    }
    private fun unblockResolve() {
        check(context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().putBoolean("debugHttp", true).commit())
    }
    private fun sessionGeneration() = CentralSession.get(context).generation
    /**
     * The loopback fixture binds one fixed port, so a task-owned profile may only ever remember
     * this generated origin's index — residue from an earlier run of this same fixture is
     * generated data, never user data.
     */
    private val generatedNativeIndex get() = File(context.noBackupFilesDir, "central-native/" + SourceRules.hash("http://127.0.0.1:47913"))
    /**
     * An emulator fingerprint does not prove the profile is task-owned and generated; the journey
     * refuses to mutate a profile that could hold real records, credentials or a running capture.
     * `enabled == false` up front also means teardown has no capture scheduling to restart.
     */
    private fun requireGeneratedProfile() {
        val settings = Settings(context)
        require(!settings.enabled && settings.lastCapture() == null) { "generated fixture needs a task-owned profile: capture must not be enabled or have captured" }
        require(runCatching { settings.dataOrigin() }.getOrDefault("unreadable").isBlank()) { "generated fixture needs a profile without a retained origin" }
        require(!settings.hasPendingData()) { "generated fixture needs a profile without pending records, drafts or uploads" }
        require(context.queue().inventory().records == 0) { "generated fixture needs a profile without stored records" }
        val natives = File(context.noBackupFilesDir, "central-native").listFiles().orEmpty()
        require(natives.all { it.name == generatedNativeIndex.name }) { "generated fixture needs a profile without indexes for another origin" }
    }
    private fun reset() {
        val settings = Settings(context)
        settings.enabled = false
        settings.save(settings.read().copy(server = "", token = "", debugHttp = false, screenCollectionEnabled = true, notificationCollectionEnabled = false, syncPaused = false))
        settings.screenPaused(null); settings.status("paused", "生成的初始状态")
        context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().remove("capturePreviewSeen").remove("lastCapture").commit()
        NativeRecordReceipt.recordId = null
        NativeRecordReceipt.fromFirstUse = false
    }

    private var armed = false
    private var savedMotePrefs: Map<String, Any?> = emptyMap()
    private var savedAppearance = "auto"
    private var savedLanguage = "system"
    private var savedReceipt: String? = null
    private var savedReceiptFromFirstUse = false
    private var generatedIndexExisted = false

    /** Restore the exact pre-test profile: preference snapshot, appearance, language and receipt. */
    private fun restoreProfile() {
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
        val edit = prefs.edit()
        prefs.all.keys.forEach { if (it !in savedMotePrefs) edit.remove(it) }
        savedMotePrefs.forEach { (key, value) ->
            when (value) {
                is String -> edit.putString(key, value)
                is Int -> edit.putInt(key, value)
                is Long -> edit.putLong(key, value)
                is Boolean -> edit.putBoolean(key, value)
                is Float -> edit.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") edit.putStringSet(key, value as Set<String>)
            }
        }
        check(edit.commit())
        MoteI18n.select(context, savedLanguage)
        MoteAppearance.select(context, AppearancePreference.parse(savedAppearance))
        NativeRecordReceipt.recordId = savedReceipt
        NativeRecordReceipt.fromFirstUse = savedReceiptFromFirstUse
        if (!generatedIndexExisted) generatedNativeIndex.deleteRecursively()
    }

    @Before fun generatedOnly() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("journeyHomeFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a")) { "Run only on a task-owned emulator" }
        requireGeneratedProfile()
        generatedIndexExisted = generatedNativeIndex.exists()
        savedMotePrefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        savedAppearance = context.getSharedPreferences("mote.appearance", Context.MODE_PRIVATE).getString("appearance", "auto") ?: "auto"
        savedLanguage = context.getSharedPreferences("mote.language", Context.MODE_PRIVATE).getString("language", "system") ?: "system"
        savedReceipt = NativeRecordReceipt.recordId
        savedReceiptFromFirstUse = NativeRecordReceipt.fromFirstUse
        armed = true
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        reset()
    }
    /** Skipped tests never ran: an unarmed teardown leaves the task-owned profile untouched. */
    @After fun restore() {
        if (!armed) return
        armed = false
        restoreProfile()
    }

    @Test fun aRevokedHomeReadWithdrawsRowsAndKeepsAUsableRetryAcrossPauses() {
        Fixture().use { fixture ->
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The generated rows come from the production home sections") { activity ->
                    tagged(activity, "home-conversation:$conversation") && tagged(activity, "home-calendar-need:$action") && tagged(activity, "home-discovery-history")
                }
                // The first resolve selects the origin and bumps the lazy generation; the
                // same-session baseline only exists once the rows proved that resolve happened.
                val generation = sessionGeneration()
                // Revoke while a held conversations read lets the owner pause before its callback.
                fixture.holdConversations = true
                fixture.forbidden = true
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                assertTrue("the denied conversations read is in flight", fixture.conversationsEntered.await(15, TimeUnit.SECONDS))
                scenario.moveToState(Lifecycle.State.STARTED) // pause between the probe and the callback
                fixture.releaseConversations.countDown()
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("A 403 withdraws the rows and every denied section offers a retry") {
                    !tagged(home, "home-conversation:$conversation") && !tagged(home, "home-calendar-need:$action") && !tagged(home, "home-discovery-history") &&
                        retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("The denied affordances survive leaving and returning home") {
                    !tagged(home, "home-conversation:$conversation") &&
                        retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                // A same-generation resolution failure hides the affordances; the denied state survives
                // without a session change and re-renders once resolution recovers.
                blockResolve()
                until("A resolve failure clears the sections without reviving reads or retries") {
                    !tagged(home, "home-conversation:$conversation") && retry(home, "home-recent-conversations") == null &&
                        retry(home, "home-calendar-needs") == null && retry(home, "home-existing-discovery") == null
                }
                unblockResolve()
                until("The denied retry returns once access resolves again on the same session") {
                    retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                assertEquals("the transient failure must not change the session generation", generation, sessionGeneration())
                fixture.forbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The conversations retry issues a fresh read and restores the row") { tagged(home, "home-conversation:$conversation") }
                clickInside(home, "home-calendar-needs") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The calendar retry restores its row") { tagged(home, "home-calendar-need:$action") }
                clickInside(home, "home-existing-discovery") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The discovery retry restores its card") { tagged(home, "home-discovery-history") }
                assertEquals("the explicit retry recovers on the same session", generation, sessionGeneration())
            }
        }
    }

    @Test fun aDeniedArchiveProbeShowsRetryNotAFalseEmptyHome() {
        Fixture().use { fixture ->
            fixture.conversationsEmpty = true
            fixture.probeForbidden = true
            fixture.holdProbe = true
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The home opens with a resumable conversations section") { it is MainActivity }
                // Hold the real archive probe in flight, pause, then let its 403 land: the late
                // callback belongs to the paused epoch and must not fake an empty home.
                assertTrue("the empty-conversations read reached the archive probe", fixture.probeEntered.await(15, TimeUnit.SECONDS))
                scenario.moveToState(Lifecycle.State.STARTED)
                fixture.releaseProbe.countDown()
                assertTrue("the denied probe answer lands while the home is paused", fixture.probeServed.await(15, TimeUnit.SECONDS))
                // Let the worker finish the served answer inside the pause window; resuming first
                // would take the immediate callback path instead of the dropped-delivery one.
                Thread.sleep(300)
                assertNull("the deferred failure callback cannot render before the home returns", retry(home, "home-recent-conversations"))
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("A denied probe fails the read instead of claiming an empty archive") {
                    retry(home, "home-recent-conversations") != null && emptyConversationLabel(home) == null &&
                        !hasText(home, MoteI18n.text("先记下一件事。"))
                }
                assertTrue("the dropped probe answer did not mark the archive; the read probes again", fixture.probeRequests.get() >= 2)
                fixture.probeForbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("A recovered probe confirms the empty archive and the first-use home shows") {
                    hasText(home, MoteI18n.text("先记下一件事。")) && !tagged(home, "home-recent-conversations")
                }
                instrumentation.runOnMainSync {
                    assertFalse("the confirmed empty archive hides the section rather than faking rows", tagged(home, "home-conversation:$conversation"))
                }
            }
        }
    }

    @Test fun anInconclusiveProbeKeepsAnHonestEmptyUntilTheNextSessionRechecks() {
        Fixture().use { fixture ->
            fixture.conversationsEmpty = true
            fixture.malformedCaptures = true
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The home opens with a resumable conversations section") { it is MainActivity }
                until("A malformed storage.captures probe is inconclusive: truthful empty label, no first-use hide") {
                    emptyConversationLabel(home) != null && !hasText(home, MoteI18n.text("先记下一件事。"))
                }
                // A session change re-arms the probe; a held answer released while paused still
                // cannot mark the new generation done, so the next read probes for real. The
                // disconnected stamp must be observed by a real refresh first, or the instant
                // reconnect leaves the generation — and the old probe schedule — untouched.
                fixture.malformedCaptures = false
                fixture.holdProbe = true
                val previous = sessionGeneration()
                disconnect()
                until("the disconnected session is observed before reconnecting") { sessionGeneration() != previous }
                connect(fixture)
                assertTrue("the new session reached the archive probe", fixture.probeEntered.await(15, TimeUnit.SECONDS))
                scenario.moveToState(Lifecycle.State.STARTED)
                fixture.releaseProbe.countDown()
                assertTrue("the held probe answer lands while the home is paused", fixture.probeServed.await(15, TimeUnit.SECONDS))
                Thread.sleep(300) // the worker completes inside the pause window, as above
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("The rechecked probe confirms the empty archive and the first-use home shows") {
                    hasText(home, MoteI18n.text("先记下一件事。")) && !tagged(home, "home-recent-conversations")
                }
                assertTrue("the malformed and held answers never stood in for a real probe", fixture.probeRequests.get() >= 3)
            }
        }
    }

    /** Loopback Central with switchable 403s, malformed storage counts and holdable reads. */
    private inner class Fixture : AutoCloseable {
        private val listener = ServerSocket().apply { reuseAddress = true; bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), 47913), 16) }
        val origin = "http://127.0.0.1:${listener.localPort}"
        @Volatile var forbidden = false
        @Volatile var probeForbidden = false
        @Volatile var conversationsEmpty = false
        @Volatile var malformedCaptures = false
        @Volatile var holdConversations = false
        @Volatile var holdProbe = false
        val probeRequests = AtomicInteger()
        val conversationsEntered = CountDownLatch(1)
        val releaseConversations = CountDownLatch(1)
        val probeEntered = CountDownLatch(1)
        val releaseProbe = CountDownLatch(1)
        val probeServed = CountDownLatch(1)
        private val executor = Executors.newCachedThreadPool()
        init {
            executor.submit {
                while (!listener.isClosed) runCatching { listener.accept() }.getOrNull()?.let { socket -> executor.submit { runCatching { serve(socket) } } }
            }
        }
        private fun serve(socket: java.net.Socket) {
            socket.use {
                val input = it.getInputStream().bufferedReader()
                val path = input.readLine().orEmpty().split(' ').getOrElse(1) { "" }
                while (!input.readLine().isNullOrBlank()) Unit
                val probe = path == "/api/status" || path.startsWith("/api/library/catalog") || path.startsWith("/api/files")
                if (probe) probeRequests.incrementAndGet()
                val heldProbe = probe && holdProbe
                if (heldProbe) { probeEntered.countDown(); releaseProbe.await(30, TimeUnit.SECONDS) }
                if (path.startsWith("/api/conversations?") && holdConversations) { conversationsEntered.countDown(); releaseConversations.await(30, TimeUnit.SECONDS) }
                val status: Int; val payload: JSONObject
                when {
                    forbidden || (probeForbidden && probe) -> { status = 403; payload = JSONObject().put("error", JSONObject().put("code", "forbidden")) }
                    path.startsWith("/api/conversations?") -> {
                        status = 200; payload = JSONObject().put("items", if (conversationsEmpty) JSONArray() else JSONArray().put(JSONObject()
                            .put("id", conversation).put("title", "生成的跨设备对话").put("updatedAt", "2026-10-30T10:00:00Z").put("turnCount", 2)))
                    }
                    path.startsWith("/api/actions?") -> {
                        status = 200; payload = JSONObject().put("nextCursor", JSONObject.NULL).put("targets", JSONArray()).put("items", JSONArray().put(JSONObject()
                            .put("id", action).put("version", 1).put("kind", "calendar.create").put("status", "proposed").put("evidence", JSONArray())
                            .put("event", JSONObject().put("title", "生成的设计评审").put("start", JSONObject.NULL).put("end", JSONObject.NULL).put("timeZone", "Asia/Shanghai").put("allDay", false).put("location", "").put("description", ""))))
                    }
                    path.startsWith("/api/insights?") -> {
                        status = 200; payload = JSONObject().put("items", JSONArray().put(JSONObject()
                            .put("runId", "generated-insight-1").put("answer", "生成的回顾结论").put("status", "completed")
                            .put("citations", JSONArray().put(JSONObject().put("id", "c1")))
                            .put("artifact", JSONObject().put("id", "generated-artifact-1").put("title", "生成的周回顾"))))
                    }
                    path == "/api/status" -> { status = 200; payload = JSONObject().put("storage", JSONObject().put("captures", if (malformedCaptures) "zero" else 0)) }
                    path.startsWith("/api/library/catalog") || path.startsWith("/api/files") -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                    path.startsWith("/api/model-settings") -> { status = 200; payload = JSONObject().put("profiles", JSONArray()) }
                    else -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                }
                val body = payload.toString().toByteArray()
                it.getOutputStream().apply { write("HTTP/1.1 $status ${if (status == 200) "OK" else "Forbidden"}\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(body); flush() }
                // The denied answer is only served after the release latch, so the test can pause
                // at the real boundary: probe complete on the worker, callback not yet delivered.
                if (heldProbe) probeServed.countDown()
            }
        }
        override fun close() { listener.close(); executor.shutdownNow() }
    }
}
