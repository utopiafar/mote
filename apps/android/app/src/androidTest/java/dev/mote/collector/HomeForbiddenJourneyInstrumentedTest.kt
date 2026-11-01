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

/**
 * Home 403 lifecycle on the production views, against a generated loopback Central: a revoked
 * read withdraws its rows, the retry affordance survives leaving and returning, a callback that
 * lands after a pause cannot strand the section, and an explicit retry recovers the same session.
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

    private fun connect(fixture: Fixture) {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = fixture.origin, token = "generated-journey-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
        File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)).deleteRecursively()
    }
    private fun disconnect() {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = "", token = "", authSignedOut = true))
    }
    private fun reset() {
        val settings = Settings(context)
        settings.enabled = false
        settings.save(settings.read().copy(server = "", token = "", debugHttp = false, screenCollectionEnabled = true, notificationCollectionEnabled = false, syncPaused = false))
        settings.screenPaused(null); settings.status("paused", "生成的初始状态")
        context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().remove("capturePreviewSeen").remove("lastCapture").commit()
        NativeRecordReceipt.recordId = null
    }

    @Before fun generatedOnly() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("journeyHomeFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a")) { "Run only on a task-owned emulator" }
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        reset()
    }
    @After fun restore() { reset(); MoteAppearance.select(context, AppearancePreference.LIGHT) }

    @Test fun aRevokedHomeReadWithdrawsRowsAndKeepsAUsableRetryAcrossPauses() {
        Fixture().use { fixture ->
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The generated rows come from the production home sections") { activity ->
                    tagged(activity, "home-conversation:$conversation") && tagged(activity, "home-calendar-need:$action") && tagged(activity, "home-discovery-history")
                }
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
                // A temporary access-resolution failure hides the sections; the denied retry must come back.
                disconnect()
                until("A lost connection clears the sections without reviving reads") {
                    !tagged(home, "home-conversation:$conversation") && retry(home, "home-recent-conversations") == null && retry(home, "home-calendar-needs") == null
                }
                connect(fixture)
                until("The denied retry returns once access resolves again") {
                    retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                fixture.forbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The conversations retry issues a fresh read and restores the row") { tagged(home, "home-conversation:$conversation") }
                clickInside(home, "home-calendar-needs") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The calendar retry restores its row") { tagged(home, "home-calendar-need:$action") }
                clickInside(home, "home-existing-discovery") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The discovery retry restores its card") { tagged(home, "home-discovery-history") }
            }
        }
    }

    @Test fun aDeniedArchiveProbeShowsRetryNotAFalseEmptyHome() {
        Fixture().use { fixture ->
            fixture.conversationsEmpty = true
            fixture.probeForbidden = true
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use {
                val home = onTop("A denied probe fails the read instead of claiming an empty archive") { activity ->
                    retry(activity, "home-recent-conversations") != null
                }
                instrumentation.runOnMainSync {
                    assertFalse("the empty-history label must not appear", inside(home, "home-recent-conversations") { it is TextView && it.text.toString().startsWith("还没有对话") } != null)
                }
                fixture.probeForbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("A recovered probe reaches the real empty state") {
                    inside(home, "home-recent-conversations") { it is TextView && it.text.toString().startsWith("还没有对话") } != null &&
                        retry(home, "home-recent-conversations") == null
                }
            }
        }
    }

    /** Loopback Central with switchable 403s and a holdable conversations read. */
    private inner class Fixture : AutoCloseable {
        private val listener = ServerSocket().apply { reuseAddress = true; bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), 47913), 16) }
        val origin = "http://127.0.0.1:${listener.localPort}"
        @Volatile var forbidden = false
        @Volatile var probeForbidden = false
        @Volatile var conversationsEmpty = false
        @Volatile var holdConversations = false
        val conversationsEntered = CountDownLatch(1)
        val releaseConversations = CountDownLatch(1)
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
                            .put("event", JSONObject().put("title", "生成的设计评审").put("start", "2026-11-02T07:00:00Z").put("end", JSONObject.NULL).put("timeZone", "Asia/Shanghai").put("allDay", false).put("location", "").put("description", ""))))
                    }
                    path.startsWith("/api/insights?") -> {
                        status = 200; payload = JSONObject().put("items", JSONArray().put(JSONObject()
                            .put("runId", "generated-insight-1").put("answer", "生成的回顾结论").put("status", "completed")
                            .put("citations", JSONArray().put(JSONObject().put("id", "c1")))
                            .put("artifact", JSONObject().put("id", "generated-artifact-1").put("title", "生成的周回顾"))))
                    }
                    path == "/api/status" -> { status = 200; payload = JSONObject().put("storage", JSONObject().put("captures", 0)) }
                    path.startsWith("/api/library/catalog") || path.startsWith("/api/files") -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                    path.startsWith("/api/model-settings") -> { status = 200; payload = JSONObject().put("profiles", JSONArray()) }
                    else -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                }
                val body = payload.toString().toByteArray()
                it.getOutputStream().apply { write("HTTP/1.1 $status ${if (status == 200) "OK" else "Forbidden"}\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(body); flush() }
            }
        }
        override fun close() { listener.close(); executor.shutdownNow() }
    }
}
