package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantActionResultsTest {
    private val taskId = "11111111-1111-4111-8111-111111111111"
    private val matterId = "22222222-2222-4222-8222-222222222222"
    private val actionId = "33333333-3333-4333-8333-333333333333"
    private val evidenceId = "44444444-4444-4444-8444-444444444444"

    private fun draft(status: String = "proposed", kind: String = "todo.create", linked: Boolean = false): JSONObject {
        val value = JSONObject()
            .put("kind", kind)
            .put("evidence", JSONArray().put(JSONObject().put("id", evidenceId).put("quote", "Generated quote")))
        when (kind) {
            "todo.create" -> value.put("todo", JSONObject().put("title", "Generated task").put("description", "Generated detail").put("dueAt", JSONObject.NULL))
            "calendar.create" -> value.put("event", JSONObject().put("title", "Generated event").put("start", JSONObject.NULL)
                .put("end", JSONObject.NULL).put("timeZone", JSONObject.NULL).put("allDay", false).put("location", "").put("description", "Generated detail"))
                .put("uncertainty", "Generated boundary")
            else -> value.put("message", JSONObject().put("conversationId", "generated-chat").put("conversationName", "Generated chat").put("text", "Generated message"))
        }
        val item = JSONObject().put("index", 0).put("draft", value)
            .put("targets", if (kind == "todo.create") JSONArray() else JSONArray().put(JSONObject()
                .put("name", "Generated device")
                .put("target", JSONObject().put("deviceId", "generated-device").put("calendarId", "generated-calendar"))))
        if (linked) item.put("linked", JSONObject().put("id", actionId).put("kind", kind).put("status", status))
        return item
    }
    private fun result(item: JSONObject = draft()): JSONObject =
        JSONObject().put("taskId", taskId).put("revision", 3).put("matterId", matterId).put("drafts", JSONArray().put(item))

    @Test fun `an external uncertain status is never reported as success`() {
        val parsed = AssistantActionResultsReader.read(result(draft(status = "uncertain", linked = true)))
        val linked = parsed.drafts.single().linked!!
        assertEquals("uncertain", linked.status)
        assertFalse(AssistantActionResultsReader.isSuccess(linked.status))
        assertEquals("保存结果待核实", AssistantActionResultsReader.statusLabel(linked.status))
        assertFalse(AssistantActionResultsReader.statusLabel(linked.status).contains("已完成"))
        assertTrue(AssistantActionResultsReader.isSuccess("succeeded"))
        assertTrue(AssistantActionResultsReader.isSuccess("completed"))
        assertFalse(AssistantActionResultsReader.isSuccess("approved"))
        assertFalse(AssistantActionResultsReader.isSuccess("executing"))
    }

    @Test fun `drafts and by-matter pages use the same strict action schema`() {
        val parsed = AssistantActionResultsReader.read(result())
        assertEquals(3L, parsed.revision)
        assertEquals(matterId, parsed.matterId)
        val draft = parsed.drafts.single()
        assertEquals("todo.create", draft.draft.kind)
        assertEquals("Generated task", draft.draft.title)
        assertTrue(draft.linked == null)
        val page = AssistantActionResultsReader.readPage(JSONObject().put("items", JSONArray().put(result())))
        assertEquals(listOf(parsed), page)
    }

    @Test fun `unknown linked state and mismatched draft kind are rejected`() {
        val unknown = draft(kind = "todo.create", linked = true)
        unknown.getJSONObject("linked").put("status", "maybe")
        assertThrows(IllegalArgumentException::class.java) { AssistantActionResultsReader.read(result(unknown)) }
        val mismatch = draft(kind = "todo.create", linked = true)
        mismatch.getJSONObject("linked").put("kind", "calendar.create")
        assertThrows(IllegalArgumentException::class.java) { AssistantActionResultsReader.read(result(mismatch)) }
        val extra = result()
        extra.getJSONArray("drafts").getJSONObject(0).put("command", "send")
        assertThrows(IllegalArgumentException::class.java) { AssistantActionResultsReader.read(extra) }
    }

    @Test fun `an unknown draft kind or external target shape is rejected`() {
        val unknown = draft(kind = "todo.create")
        unknown.getJSONObject("draft").put("kind", "message.send")
        assertThrows(IllegalArgumentException::class.java) { AssistantActionResultsReader.read(result(unknown)) }
        val badTarget = draft(kind = "calendar.create")
        badTarget.getJSONArray("targets").getJSONObject(0).getJSONObject("target").put("url", "https://example.invalid")
        assertThrows(IllegalArgumentException::class.java) { AssistantActionResultsReader.read(result(badTarget)) }
    }
}
