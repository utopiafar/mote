package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerQuestionModelTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private val requestId = "22222222-2222-4222-8222-222222222222"
    private fun question(state: String = "open", revision: Int = 2) = JSONObject()
        .put("id", id)
        .put("provider", JSONObject().put("id", "mote.assistant-task-question").put("version", "1"))
        .put("operationId", "generated-operation")
        .put("workId", "generated-work")
        .put("title", "Generated missing choice")
        .put("prompt", "Which generated plan should continue?")
        .put("reason", "Generated only")
        .put("evidence", JSONArray().put(JSONObject().put("id", "generated-evidence").put("quote", "Generated quote").put("ref", "capture:33333333-3333-4333-8333-333333333333")))
        .put("choices", JSONArray().put(JSONObject().put("id", "a").put("label", "Generated A").put("answer", "Use generated A")))
        .put("state", state)
        .put("revision", revision)
        .put("createdAt", "2026-10-01T00:00:00Z")
        .put("updatedAt", "2026-10-01T00:00:00Z")
        .put("messages", JSONArray().put(JSONObject().put("role", "assistant").put("text", "Which generated plan should continue?").put("createdAt", "2026-10-01T00:00:00Z")))

    @Test fun `reply carries the exact revision and one authored answer`() {
        val parsed = OwnerQuestionModel.parse(question())
        val body = OwnerQuestionModel.reply(requestId, parsed, "answer", choiceId = "a")
        assertEquals(requestId, body.getString("requestId"))
        assertEquals(2, body.getInt("expectedRevision"))
        assertEquals("answer", body.getString("action"))
        assertEquals("a", body.getString("choiceId"))
        assertFalse(body.has("answer"))
        val free = OwnerQuestionModel.reply(requestId, parsed, "answer", answer = "Generated free answer")
        assertEquals("Generated free answer", free.getString("answer"))
        assertFalse(free.has("choiceId"))
        assertEquals("open", parsed.state)
        assertTrue(OwnerQuestionModel.canReply(parsed.state))
        assertFalse(OwnerQuestionModel.resolved(parsed.state))
    }

    @Test fun `answer must choose exactly one shape and older choices are rejected`() {
        val parsed = OwnerQuestionModel.parse(question())
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.reply(requestId, parsed, "answer") }
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.reply(requestId, parsed, "answer", "text", "a") }
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.reply(requestId, parsed, "answer", choiceId = "missing") }
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.reply(requestId, parsed, "defer", answer = "text") }
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.reply("not-a-uuid", parsed, "defer") }
    }

    @Test fun `obsolete and malformed questions are stated without inventing a default`() {
        val obsolete = OwnerQuestionModel.parse(question("obsolete"))
        assertEquals("已失效", OwnerQuestionModel.stateLabel(obsolete.state))
        assertFalse(OwnerQuestionModel.canReply(obsolete.state))
        val unknown = question().put("state", "pending")
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.parse(unknown) }
        val duplicate = question().put("choices", JSONArray()
            .put(JSONObject().put("id", "a").put("label", "One").put("answer", "One"))
            .put(JSONObject().put("id", "a").put("label", "Two").put("answer", "Two")))
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.parse(duplicate) }
        val extra = question().put("consent", true)
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.parse(extra) }
    }

    @Test fun `the list page reads only current questions and keeps its cursor`() {
        val page = OwnerQuestionModel.page(JSONObject().put("items", JSONArray().put(question("open"))).put("nextCursor", "generated-cursor"))
        assertEquals(1, page.first.size)
        assertEquals("generated-cursor", page.second)
        assertThrows(IllegalArgumentException::class.java) { OwnerQuestionModel.page(JSONObject()) }
    }
}
