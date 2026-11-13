package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

class AssistantFeedViewModelTest {
    @get:Rule val folder = TemporaryFolder()
    private val f = AssistantFixtures
    private fun store() = CentralStateFile(folder.newFolder(), "generated-assistant", object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 51).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    })
    private fun api(domain: AssistantDomainBindings? = null, scope: AssistantScope = f.scope(), exchange: (String, String, JSONObject?) -> Pair<Int, JSONObject?>) =
        CentralAssistant(CentralClient("https://generated.invalid", "generated-only", transport = { method, url, bytes, _, _ ->
            exchange(method, url, bytes?.let { JSONObject(String(it)) })
        }), scope, domain)

    @Test fun `work and life cards retain evidence feedback and later revisions through the feed entrance`() {
        val work = f.card(); val life = f.card(f.life)
        val lifeTaskId = "30000000-0000-4000-8000-000000000002"
        val started = mutableListOf<String>()
        val domain = object : GeneratedAssistantDomain() {
            override fun start(request: JSONObject, card: JSONObject): String {
                val id = card.getString("cardId"); started += id
                return if (id == f.work) f.taskId else lifeTaskId
            }
        }
        val api = api(domain) { method, url, body ->
            when {
                method == "GET" && URI(url).path == "/api/assistant-cards" -> 200 to f.page(work, life)
                url.contains("/tasks/") -> 200 to f.task("running").apply { getJSONObject("task").put("id", URI(url).path.substringAfterLast('/')) }
                method == "POST" -> {
                    val target = if (url.contains(f.work)) work else life
                    target.put("revision", target.getLong("revision") + 1).getJSONArray("feedback").put(JSONObject().put("action", body!!.getString("action")))
                    200 to target
                }
                else -> error("Unexpected request")
            }
        }
        val disk = store(); val model = AssistantFeedViewModel(api, disk::read, disk::write)
        model.refresh(); assertNull(model.error); assertEquals(listOf(f.work, f.life), model.cards.map { it.id })
        assertTrue(model.cards.all { it.evidence.single().ref == "capture:${f.evidence}" })
        for (card in model.cards.toList()) {
            model.feedback(card.id, card.revision, "later")
            model.feedback(card.id, card.revision + 1, "ignore")
        }
        assertTrue(model.cards.all { it.feedback == listOf("later", "ignore") })
        work.put("version", "v2").put("revision", 4).put("body", "Generated later project update")
        life.put("version", "v2").put("revision", 4).put("body", "Generated corrected trip update")
        model.refresh()
        assertEquals(2, model.cards.size); assertTrue(model.cards.all { it.version == "v2" })
        assertEquals("Generated corrected trip update", model.cards.last().body)
        for (card in model.cards.toList()) model.start(card.id, card.revision, card.title)
        assertEquals(listOf(f.work, f.life), started)
        assertEquals(setOf(f.taskId, lifeTaskId), model.tasks.values.map { it.id }.toSet())
        assertTrue(model.tasks.values.all { it.state == "running" })
        assertFalse("Feed bodies are never saved as an offline permission cache", disk.read().toString().contains("Generated corrected trip update"))
    }

    @Test fun `two simultaneous start clicks keep one acceptance and never infer completion`() {
        var calls = 0
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val domain = object : GeneratedAssistantDomain() {
            override fun start(request: JSONObject, card: JSONObject): String { calls++; entered.countDown(); release.await(); return f.taskId }
        }
        val disk = store(); val model = AssistantFeedViewModel(api(domain) { _, url, _ -> 200 to if (url.contains("/tasks/")) f.task("waiting") else f.page(f.card()) }, disk::read, disk::write)
        model.refresh()
        val workers = Executors.newFixedThreadPool(2)
        try {
            val first = workers.submit<String?> { model.start(f.work, 1, "Generated edited goal") }
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            val second = workers.submit<String?> { model.start(f.work, 1, "Generated edited goal") }
            release.countDown()
            assertEquals(f.taskId, first.get(5, java.util.concurrent.TimeUnit.SECONDS)); assertEquals(f.taskId, second.get(5, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals(1, calls); assertEquals("waiting", model.tasks[f.work]!!.state)
            assertNull(model.tasks[f.work]!!.answer)
        } finally { release.countDown(); workers.shutdownNow() }
    }

    @Test fun `lost acceptance response survives process recreation with the exact owner command and task id`() {
        val disk = store(); val requests = mutableListOf<String>(); val references = mutableListOf<String>()
        val domain = object : GeneratedAssistantDomain() {
            override fun start(request: JSONObject, card: JSONObject): String {
                assertTrue("Durable intent must precede IO", disk.read().has("pending"))
                requests += request.toString(); references += card.toString()
                if (requests.size == 1) throw IOException("Generated lost response after admission")
                return f.taskId
            }
        }
        var state = "running"
        val api = api(domain) { _, url, _ -> 200 to if (url.contains("/tasks/")) f.task(state) else f.page(f.card()) }
        val before = AssistantFeedViewModel(api, disk::read, disk::write)
        before.refresh(); assertNull(before.start(f.work, 1, "Generated owner goal")); assertNotNull(before.error)
        val rebuilt = AssistantFeedViewModel(api, disk::read, disk::write)
        assertEquals(f.taskId, rebuilt.start(f.work, 99, "Changed text must not replace an uncertain request"))
        assertEquals(requests[0], requests[1]); assertEquals(references[0], references[1])
        assertTrue(AssistantScope(JSONObject(requests[0]).getJSONObject("scope")).same(f.scope()))
        assertEquals("running", rebuilt.tasks[f.work]!!.state)
        state = "needs_input"
        val again = AssistantFeedViewModel(api, disk::read, disk::write)
        assertEquals(f.taskId, again.start(f.work, 1, "Generated owner goal")); assertEquals(2, requests.size)
        assertEquals("needs_input", again.tasks[f.work]!!.state)
        assertFalse(disk.read().has("pending"))
    }

    @Test fun `failed durable write never sends a command including a subsequent click`() {
        var calls = 0
        val domain = object : GeneratedAssistantDomain() { override fun start(request: JSONObject, card: JSONObject): String { calls++; return f.taskId } }
        val model = AssistantFeedViewModel(api(domain) { _, _, _ -> 200 to f.page(f.card()) }, { JSONObject() }, { throw IOException("Generated full disk") })
        // First read cannot save navigation IDs either, so reload through a writer
        // that allows that read and then fails both command writes.
        var fail = false
        val other = AssistantFeedViewModel(model.api, { JSONObject() }, { if (fail) throw IOException("Generated full disk") })
        other.refresh(); fail = true
        other.start(f.work, 1, "Generated goal"); other.start(f.work, 1, "Generated goal")
        assertEquals(0, calls); assertNotNull(other.error)
    }

    @Test fun `empty selection reaches every read unchanged and revoked reads remove prior content`() {
        val scope = AssistantScope(JSONObject().put("kind", "selection").put("evidenceIds", JSONArray()))
        var denied = false; var wireScope: JSONObject? = null
        val emptyApi = api(scope = scope) { _, url, _ ->
            wireScope = JSONObject(URLDecoder.decode(URI(url).rawQuery.substringAfter("scope=").substringBefore('&'), "UTF-8"))
            200 to f.page()
        }
        val emptyDisk = store(); val empty = AssistantFeedViewModel(emptyApi, emptyDisk::read, emptyDisk::write)
        empty.refresh(); assertTrue(empty.cards.isEmpty()); assertNull(empty.error)
        assertEquals("selection", wireScope!!.getString("kind")); assertEquals(0, wireScope!!.getJSONArray("evidenceIds").length())
        val api = api { _, _, _ -> if (denied) 403 to JSONObject() else 200 to f.page(f.card()) }
        val disk = store(); val model = AssistantFeedViewModel(api, disk::read, disk::write)
        model.refresh(); assertEquals(1, model.cards.size)
        denied = true; model.refresh(); assertTrue(model.cards.isEmpty()); assertTrue(model.tasks.isEmpty()); assertNotNull(model.error)
        assertFalse(model.canStart)
    }

    @Test fun `withdrawn suggestion clears the frozen pending goal instead of stranding private prose on disk`() {
        val disk = store(); var withdrawn = false; var starts = 0
        val domain = object : GeneratedAssistantDomain() {
            override fun start(request: JSONObject, card: JSONObject): String { starts++; throw IOException("Generated unknown response") }
        }
        val api = api(domain) { _, url, _ ->
            if (url.contains("/api/assistant-cards/")) 404 to JSONObject() else 200 to if (withdrawn) f.page() else f.page(f.card())
        }
        val model = AssistantFeedViewModel(api, disk::read, disk::write)
        model.refresh(); model.start(f.work, 1, "Generated private pending goal")
        assertTrue(disk.read().has("pending"))
        withdrawn = true; model.refresh()
        assertFalse(disk.read().has("pending")); assertFalse(disk.read().toString().contains("Generated private pending goal"))
        assertEquals(1, starts); assertTrue(model.cards.isEmpty()); assertNotNull(model.error)
    }

    @Test fun `state matrix uses receipts and hides retired result bodies`() {
        for (state in AssistantTask.states) {
            val raw = f.task(state).put("result", JSONObject().put("answer", "Generated prior result"))
            val task = AssistantTask.read(raw)
            assertEquals(state, task.state)
            assertEquals(if (state in setOf("stale", "cancelled")) null else "Generated prior result", task.answer)
        }
        assertThrows(IllegalArgumentException::class.java) { AssistantTask.read(f.task("succeeded")) }
        val bad = f.card().put("acceptedTaskId", "not-an-id")
        assertThrows(IllegalArgumentException::class.java) { AssistantCard.read(bad) }
        assertThrows(IllegalArgumentException::class.java) { AssistantScope(JSONObject().put("kind", "selection")) }
    }

    @Test fun `feedback conflict is visible and never becomes a local ignored state`() {
        val disk = store(); var requests = 0
        val model = AssistantFeedViewModel(api { method, _, _ -> if (method == "POST") { requests++; 409 to JSONObject() } else 200 to f.page(f.card()) }, disk::read, disk::write)
        model.refresh(); model.feedback(f.work, 1, "ignore")
        assertEquals(1, requests); assertTrue(model.cards.isEmpty()); assertNotNull(model.error)
        model.refresh(); assertTrue(model.cards.single().feedback.isEmpty())
    }

    @Test fun `needs input links keep their task and explicit scope and reject a foreign task question`() {
        var foreign = false
        val disk = store()
        val api = api { _, url, _ ->
            assertTrue(url.contains("workId=assistant.task%3Agenerated"))
            200 to f.page(*listOf("open", "deferred", "answered", "closed", "obsolete").map { state ->
                JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("workId", if (foreign) "other-work" else "assistant.task:generated")
                    .put("title", "Generated question").put("state", state)
            }.toTypedArray())
        }
        val model = AssistantFeedViewModel(api, disk::read, disk::write)
        val task = AssistantTask.read(f.task("needs_input"))
        val questions = model.questions(task)
        assertEquals(5, questions.size)
        val link = AssistantOpen.Question(questions.first().id, questions.first().workId, api.scope)
        assertEquals(task.workId, link.workId); assertTrue(link.scope.same(api.scope))
        foreign = true
        assertThrows(IllegalArgumentException::class.java) { model.questions(task) }
    }
}
