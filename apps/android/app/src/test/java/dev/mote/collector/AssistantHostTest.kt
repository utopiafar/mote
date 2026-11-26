package dev.mote.collector

import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import dev.mote.collector.plugins.AssistantPlugin
import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativeAskPlugin
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.registerBuiltinPlugins
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.RealObject
import org.robolectric.util.ReflectionHelpers
import org.robolectric.shadows.ShadowApplication
import java.io.DataInputStream
import java.net.URLDecoder
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/** Replace application-wide capture/WorkManager startup only. The production
 * CentralActivity, CentralContent, plugin route factories, models and Views all
 * run; no test constructs either U6 ViewModel or mounts its own page. */
@Implements(MoteApplication::class)
class AssistantHostApplicationShadow : ShadowApplication() {
    @RealObject private lateinit var application: MoteApplication
    @Implementation fun onCreate() {
        // Each test owns a new application/profile, including the process session.
        ReflectionHelpers.setStaticField(CentralSession::class.java, "store", null)
        ReflectionHelpers.setStaticField(NativeAskPlugin::class.java, "owner", null)
        application.getSharedPreferences("mote.language", 0).edit().putString("language", "zh-CN").commit()
        MoteI18n.initialize(application)
        if (runCatching { NativeUiPacks.registry.theme() }.isFailure) NativeUiPacks.initialize(application)
        MoteAppearance.initialize(application)
        ReflectionHelpers.setField(application, "pluginHost", NativePluginHost(NativePluginRegistry().apply { registerBuiltinPlugins("generated-host") }))
    }
}

/** AndroidKeyStore is unavailable on the JVM. Keep authenticated encryption
 * over the private generated profile while substituting only the OS key store. */
@Implements(SecretBox::class)
class AssistantHostSecretBoxShadow {
    @Implementation fun seal(bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.ENCRYPT_MODE, key)
        iv + doFinal(bytes)
    }
    @Implementation fun open(bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        doFinal(bytes.copyOfRange(12, bytes.size))
    }
    companion object { private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey() }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, shadows = [AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class], sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class AssistantHostTest {
    private val f = AssistantFixtures
    private lateinit var tls: GeneratedCentralTls
    private lateinit var network: ExecutorService
    private val fixtureFailure = AtomicReference<Throwable?>()
    private lateinit var origin: String
    private val activities = mutableListOf<ActivityController<CentralActivity>>()
    private val requests = CopyOnWriteArrayList<Pair<String, JSONObject?>>()
    private val deferredIdea = "10000000-0000-4000-8000-000000000005"
    private val ignoredIdea = "10000000-0000-4000-8000-000000000006"
    private val cards = listOf(f.card(revision = 3), f.card(f.life, 3), f.card(deferredIdea), f.card(ignoredIdea),
        f.card("10000000-0000-4000-8000-000000000003").put("kind", "briefing").put("title", "Generated daily briefing"),
        f.card("10000000-0000-4000-8000-000000000004").put("kind", "activity").put("title", "Generated activity"))
    private var matter = f.matter()
    private var rule = f.routine()
    private val taskIds = mapOf(f.work to f.taskId, f.life to "30000000-0000-4000-8000-000000000002")
    private val workbenchRequest = AtomicReference<JSONObject?>()
    @Volatile private var withdrawn = false

    @Before fun generatedCentral() {
        tls = GeneratedCentralTls(20)
        val server = tls.server
        network = Executors.newSingleThreadExecutor()
        network.execute {
          while (!server.isClosed) try { server.accept().use { socket ->
            socket.soTimeout = 15000
            val input = DataInputStream(socket.getInputStream().buffered())
            fun line(): String = buildString {
                while (true) { val byte = input.read(); if (byte < 0 || byte == 10) break; if (byte != 13) append(byte.toChar()) }
            }
            val target = line().split(' ')[1]
            val path = URLDecoder.decode(target.substringBefore('?'), "UTF-8")
            val query = target.substringAfter('?', "").split('&').associate { field ->
                field.substringBefore('=') to URLDecoder.decode(field.substringAfter('=', ""), "UTF-8")
            }
            var length = 0
            while (true) {
                val header = line(); if (header.isEmpty()) break
                if (header.substringBefore(':').equals("Content-Length", ignoreCase = true)) length = header.substringAfter(':').trim().toInt()
            }
            val bytesIn = ByteArray(length).also(input::readFully)
            val body = bytesIn.takeIf { it.isNotEmpty() }?.let { JSONObject(String(it)) }
            requests += path to body
            val result = synchronized(this) {
                when {
                    path == "/api/assistant-cards" -> {
                        val kinds = query.getValue("kinds").split(',')
                        val matching = if (withdrawn) emptyList() else cards.filter { it.getString("kind") in kinds }
                        f.page(*matching.toTypedArray()).put("revision", "generated-feed").put("categories", JSONArray())
                    }
                    path == "/api/assistant/ideas" -> ideas()
                    path == "/api/actions" -> f.page()
                    path.startsWith("/api/assistant-cards/") && !path.endsWith("/feedback") ->
                        cards.single { path.substringAfterLast('/') == it.getString("id") }
                    path.endsWith("/feedback") -> cards.single { path.contains(it.getString("id")) }.apply {
                        put("revision", getLong("revision") + 1)
                        getJSONArray("feedback").put(JSONObject().put("action", body!!.getString("action")))
                    }
                    path == "/api/assistant/tasks" -> {
                        val command = requireNotNull(body); val id = taskIds.getValue(command.getString("cardId"))
                        cards.single { it.getString("id") == command.getString("cardId") }.apply {
                            put("acceptedTaskId", id); put("revision", getLong("revision") + 1)
                        }
                        JSONObject().put("requestId", command.getString("requestId")).put("taskId", id)
                    }
                    path.startsWith("/api/assistant/tasks/") -> f.task("needs_input").apply {
                        getJSONObject("task").put("id", path.substringAfterLast('/'))
                        put("workId", "assistant.task:" + path.substringAfterLast('/'))
                    }
                    path == "/api/assistant/matters" -> f.page(matter.getJSONObject("matter"))
                    path == "/api/assistant/matters/${f.matterId}" -> matter
                    path == "/api/assistant/commitments" -> f.page(f.commitment())
                    path == "/api/assistant/goals" -> goals()
                    path == "/api/assistant/workbench" -> {
                        val request = JSONObject(requireNotNull(query["request"]))
                        workbenchRequest.set(request)
                        JSONObject("""{
                            "descriptor":{"id":"assistant.workbench.travel","kind":"declarative-view","apiVersion":"1",
                                "platforms":["android"],"presentation":{"labelKey":"travel","i18nNamespace":"mote"},"commands":[]},
                            "spec":{"components":[]},"data":{},"commands":[]
                        }""").put("request", request)
                    }
                    path == "/api/assistant/matters/${f.matterId}/actions" -> JSONObject().put("items", JSONArray())
                    path == "/api/assistant/routines" -> f.page(rule)
                    path == "/api/assistant/matter-commands" -> {
                        matter = f.matter(if (body!!.getString("type") == "pause") "paused" else "active", body.getLong("expectedRevision") + 1)
                        matter.getJSONObject("matter")
                    }
                    path == "/api/assistant/routines/${f.routineId}" -> {
                        if (body != null) rule = f.routine(body.getBoolean("enabled"), body.getLong("expectedRevision") + 1)
                        rule
                    }
                    path == "/api/owner-questions" -> f.page(question(requireNotNull(query["workId"])))
                    path.startsWith("/api/work-activity/") -> work(path.substringAfter("/api/work-activity/"))
                    else -> error("Unexpected generated host request: $path")
                }
            }
            val bytes = result.toString().toByteArray()
            socket.getOutputStream().use {
                it.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                it.write(bytes)
            }
          } } catch (failure: Exception) { if (!server.isClosed) fixtureFailure.set(failure); return@execute }
        }
        origin = tls.origin
        val application = RuntimeEnvironment.getApplication() as MoteApplication
        Settings(application).read()
        // Seed an already connected private profile. Pairing's pending-capture
        // checks require the intentionally absent application-wide transport.
        val token = CredentialValue(RuntimeProfile.current, application.secretBox()).encode("generated-host-only-" + "a".repeat(32))
        check(application.getSharedPreferences("mote", 0).edit().putString("server", origin).putString("centralEndpoint", origin)
            .putString("dataOrigin", origin).putString("token", token).putString("deviceName", "Generated phone").commit())
    }
    @After fun cleanup() {
        try {
            activities.asReversed().forEach { it.pause().stop().destroy() }
            assertTrue((RuntimeEnvironment.getApplication() as MoteApplication).pluginHost.quit().isEmpty())
        } finally {
            if (::tls.isInitialized) tls.close()
            if (::network.isInitialized) network.shutdown()
        }
        if (!::network.isInitialized) return
        assertTrue("The generated HTTP fixture stopped", network.awaitTermination(5, TimeUnit.SECONDS))
        fixtureFailure.get()?.let { throw AssertionError("Generated HTTP fixture failed", it) }
    }
    private fun open(page: String): CentralActivity = open(Intent(RuntimeEnvironment.getApplication(), CentralActivity::class.java).putExtra("page", page))
    private fun open(intent: Intent): CentralActivity = Robolectric.buildActivity(CentralActivity::class.java, intent).also { activities += it }.setup().get()
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun all(activity: CentralActivity) = views(activity.window.decorView)
    private fun tagged(activity: CentralActivity, tag: String): View? = activity.window.decorView.findViewWithTag(tag)
    private fun contains(activity: CentralActivity, text: String) = all(activity).filterIsInstance<TextView>().any { it.text.toString() == text }
    private fun await(reason: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos()
        while (!condition() && System.nanoTime() < deadline) {
            fixtureFailure.get()?.let { throw AssertionError("Generated HTTP fixture failed", it) }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
            Thread.sleep(10)
        }
        val labels = activities.flatMap { all(it.get()).filterIsInstance<TextView>().map { view -> view.text.toString() } }
        assertTrue("$reason; requests=${requests.map { it.first }}; page=$labels", condition())
    }
    private fun button(activity: CentralActivity, text: String, title: String? = null) {
        val root = if (title == null) activity.window.decorView else all(activity).filterIsInstance<TextView>().first { it.text.toString() == title }.parent as View
        views(root).filterIsInstance<Button>().first { it.text.toString() == text && it.isEnabled }.performClick()
    }
    private fun clickText(activity: CentralActivity, text: String) {
        var view = all(activity).filterIsInstance<TextView>().first { it.text.toString() == text } as View
        while (!view.isClickable) view = view.parent as View
        view.performClick()
    }
    private fun goals(): JSONObject {
        val key = JSONObject().put("kind", "matter").put("id", f.matterId).put("title", "Generated trip").put("template", "travel")
        val row = JSONObject().put("id", f.life).put("kind", "commitment").put("title", "Generated trip confirmation")
            .put("direction", "mine").put("inferred", false).put("revision", 1).put("actions", JSONArray())
        val group = JSONObject().put("key", key).put("theirs", JSONArray()).put("mine", JSONArray().put(row)).put("unconfirmed", JSONArray())
        return JSONObject().put("revision", "generated-goals").put("groups", JSONArray().put(group))
    }
    private fun ideas(): JSONObject {
        val mine = JSONArray()
        val started = JSONArray()
        cards.filter { it.getString("kind") == "suggestion" }.forEach { card ->
            val task = AssistantJson.nullable(card, "acceptedTaskId")
            val title = card.getString("title")
            if (task != null) {
                started.put(JSONObject().put("taskId", task).put("title", title).put("state", "blocked"))
            } else if (card.getJSONArray("feedback").length() == 0) {
                mine.put(JSONObject().put("id", card.getString("id")).put("source", "card").put("title", title)
                    .put("detail", card.getString("body")).put("revision", card.getLong("revision")).put("seq", 1)
                    .put("actions", JSONArray(listOf("start", "later", "ignore"))))
            }
        }
        return JSONObject().put("revision", "generated-ideas").put("watermark", if (mine.length() == 0) 0 else 1)
            .put("mine", mine).put("yours", JSONArray()).put("started", started)
    }
    private fun question(workId: String) = JSONObject().put("id", if (workId == "assistant.task:${f.taskId}") "60000000-0000-4000-8000-000000000001" else "60000000-0000-4000-8000-000000000002")
        .put("provider", JSONObject().put("id", "mote.assistant-task-question").put("version", "1"))
        .put("operationId", workId).put("workId", workId)
        .put("title", "Generated missing choice").put("prompt", if (workId == "assistant.task:${f.taskId}") "Which generated work option should continue?" else "Which generated life option should continue?")
        .put("evidence", JSONArray()).put("choices", JSONArray()).put("state", "open").put("revision", 1)
        .put("createdAt", f.time).put("updatedAt", f.time).put("messages", JSONArray())
    private fun work(workId: String) = JSONObject().put("id", workId).put("kind", "query").put("goal", "Generated original work")
        .put("state", "needs_input").put("createdAt", f.time).put("updatedAt", f.time)
        .put("progress", JSONObject().put("mode", "semantic").put("stage", "preparing"))
        .put("branches", JSONArray()).put("branchCounts", JSONObject().put("total", 0).put("running", 0).put("completed", 0))
        .put("branchesNextCursor", JSONObject.NULL).put("artifacts", JSONArray()).put("events", JSONArray())
        .put("evidence", JSONObject().put("count", 0).put("refs", JSONArray())).put("destination", "ask")
        .put("technical", JSONObject().put("operationIds", JSONArray().put(workId)))

    private fun questionBacklink(activity: CentralActivity, workId: String, prompt: String) {
        button(activity, "需要补充")
        var next: Intent? = null
        await("The question opens its original work through a canonical MoteLink") { next = next ?: shadowOf(activity).nextStartedActivity; next != null }
        assertEquals(MoteLink.Route.Run(workId), MoteLink.parse(requireNotNull(next).getStringExtra("link")!!)!!.route)
        val workActivity = open(requireNotNull(next))
        await("The backlink opens the same work and existing reply composer") { contains(workActivity, prompt) }
        assertTrue(requests.any { it.first == "/api/work-activity/$workId" })
        assertTrue(contains(workActivity, "回答并继续"))
    }

    @Test fun goalsTabOpensItsMatterWorkbenchWithoutReplacingTheLegacyAssistantBinding() {
        val activity = open(AssistantPlugin.FEED_ROUTE)
        await("Existing assistant route mounted") { tagged(activity, "assistant-page:${AssistantPlugin.FEED_ROUTE}") != null }
        val existing = requireNotNull(AssistantPlugin.screen(activity))
        val tab = CentralContent(activity, null, initialPage = AssistantPlugin.GOALS_ROUTE, openLocalPage = {})
        try {
            activity.setContentView(tab.root)
            tab.resume()
            await("Goals mounted in the second content host") { contains(activity, "Generated trip confirmation") }
            assertSame(existing, AssistantPlugin.screen(activity))

            clickText(activity, "Generated trip")
            await("The matter template mounted in the same tab") {
                tab.root.findViewWithTag<View>("workbench-templates") != null
            }
            val request = requireNotNull(workbenchRequest.get())
            assertEquals("travel", request.getString("template"))
            assertEquals(f.matterId, request.getString("matterId"))
            assertSame(existing, AssistantPlugin.screen(activity))
        } finally {
            tab.close()
        }
    }

    @Test fun productionRoutesMountBothPagesAndWorkLifeCommandsReachTheExistingTransport() {
        val feed = open(AssistantPlugin.FEED_ROUTE)
        await("The production feed route attaches its rows") { tagged(feed, "assistant-page:${AssistantPlugin.FEED_ROUTE}")?.isAttachedToWindow == true && contains(feed, "Generated daily briefing") }
        assertTrue(contains(feed, "Generated activity"))
        assertNull(tagged(feed, "ideas-action:${f.work}:start"))

        val ideas = open(AssistantPlugin.IDEAS_ROUTE)
        for ((id, action) in listOf(deferredIdea to "later", ignoredIdea to "ignore")) {
            await("The pending idea offers its server action") { tagged(ideas, "ideas-action:$id:$action")?.isEnabled == true }
            tagged(ideas, "ideas-action:$id:$action")!!.performClick()
            await("The existing feedback route is used and the handled row goes away") {
                tagged(ideas, "ideas-row:$id") == null &&
                    requests.any { (path, body) -> path == "/api/assistant-cards/$id/feedback" && body?.optString("action") == action && body.optLong("expectedRevision") == 1L } &&
                    requests.count { it.first == "/api/assistant/ideas" } >= if (action == "later") 2 else 3
            }
            await("The Ideas read has published its remaining buttons") { tagged(ideas, "ideas-action:${f.work}:start")?.isEnabled == true }
        }
        for ((card, task) in taskIds) {
            await("A pending idea offers start") { tagged(ideas, "ideas-action:$card:start")?.isEnabled == true }
            tagged(ideas, "ideas-action:$card:start")!!.performClick()
            await("The accepted idea is in the started list") {
                tagged(ideas, "ideas-started:$task") != null && tagged(ideas, "ideas-row:$card") == null
            }
        }
        val starts = requests.filter { it.first == "/api/assistant/tasks" }.map { requireNotNull(it.second) }
        assertEquals(2, starts.size)
        assertEquals(setOf(f.work, f.life), starts.map { it.getString("cardId") }.toSet())
        assertTrue(starts.all { f.scope().same(AssistantScope(it.getJSONObject("scope"))) && it.getLong("expectedRevision") == 3L })
        assertFalse(contains(ideas, "已完成"))

        val activity = open(AssistantPlugin.MATTERS_ROUTE)
        await("The production matters entry lists current matters") { contains(activity, "Generated shared matter") }
        clickText(activity, "Generated shared matter")
        await("The production route must construct and attach AssistantMatterView") { all(activity).any { it is AssistantMatterView } && contains(activity, "Generated daily review") }
        assertTrue(contains(activity, "Generated trip confirmation"))
        button(activity, "暂停")
        await("Matter pause is re-read from Central") { contains(activity, "已暂停") && contains(activity, "Generated daily review") }
        assertTrue(contains(activity, "已开启"))
        button(activity, "暂停", "Generated daily review")
        await("The discovered rule can be paused without caller-supplied rule IDs") { synchronized(this) { !rule.getBoolean("enabled") } && contains(activity, "Generated daily review") }
        assertEquals(1, requests.count { it.first == "/api/assistant/matter-commands" })
        assertEquals(1, requests.count { it.first == "/api/assistant/routines/${f.routineId}" && it.second != null })

        clickText(activity, "任务状态")
        await("Matter task detail keeps the saved matter scope") { all(activity).any { it is AssistantTaskView } && contains(activity, "Generated missing choice") }
        questionBacklink(activity, "assistant.task:${f.taskId}", "Which generated work option should continue?")

        val life = open(AssistantPlugin.IDEAS_ROUTE)
        val lifeTask = "ideas-started:${taskIds.getValue(f.life)}"
        await("The accepted life card remains reachable from a fresh production entry") { tagged(life, lifeTask) != null }
        tagged(life, lifeTask)!!.performClick()
        await("The life task loads its own questions") { all(life).any { it is AssistantTaskView } && contains(life, "Generated missing choice") }
        questionBacklink(life, "assistant.task:${taskIds.getValue(f.life)}", "Which generated life option should continue?")
    }

    @Test fun pausingRemovesMountedPrivateContentAndResumeReadsWithdrawal() {
        val activity = open(AssistantPlugin.FEED_ROUTE)
        await("The feed is mounted") { contains(activity, "Generated activity") }
        val pageTag = "assistant-page:${AssistantPlugin.FEED_ROUTE}"
        val old = requireNotNull(tagged(activity, pageTag))
        activities.single().pause()
        assertNull("Pausing disposes the real plugin contribution", old.parent)
        assertFalse(contains(activity, "Generated activity"))
        withdrawn = true
        activities.single().resume()
        await("Resuming remounts a current, empty feed") { tagged(activity, pageTag) != null && requests.count { it.first == "/api/assistant-cards" } == 2 && contains(activity, "没有新动态") }
        assertFalse(contains(activity, "Generated activity"))
        val fresh = requireNotNull(tagged(activity, pageTag))
        assertNotSame(old, fresh)
        (activity.application as MoteApplication).pluginHost.stopScope(AssistantPlugin.INSTANCE_ID)
        assertNull("Stopping the owning plugin withdraws the mounted page", fresh.parent)
    }
}
