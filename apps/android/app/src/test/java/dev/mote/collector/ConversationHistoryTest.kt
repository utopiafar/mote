package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

class ConversationHistoryTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    // Friday 2026-11-06 12:00 +08:00; ISO week runs Monday 2026-11-02 through Sunday 2026-11-08.
    private val now = Instant.parse("2026-11-06T04:00:00Z")

    private fun conv(title: String, updatedAt: String) =
        HistoryConversation(UUID.randomUUID().toString(), title, Instant.parse(updatedAt))

    @Test fun groupsSplitByIsoWeekAndKeepApiOrderWithinGroups() {
        val groups = ConversationHistory.groups(listOf(
            conv("older", "2026-10-20T02:00:00Z"),
            conv("sunday-previous-week", "2026-11-01T10:00:00Z"),
            conv("monday", "2026-11-02T02:00:00Z"),
            conv("friday", "2026-11-05T02:00:00Z"),
        ), now, zone)
        assertEquals(listOf("本周", "更早"), groups.map { it.key })
        assertEquals(listOf("friday", "monday"), groups[0].items.map { it.title })
        assertEquals(listOf("sunday-previous-week", "older"), groups[1].items.map { it.title })
    }

    @Test fun groupsOmitEmptyBuckets() {
        assertEquals(listOf("本周"), ConversationHistory.groups(
            listOf(conv("a", "2026-11-05T02:00:00Z")), now, zone).map { it.key })
        assertEquals(listOf("更早"), ConversationHistory.groups(
            listOf(conv("a", "2026-10-20T02:00:00Z")), now, zone).map { it.key })
        assertTrue(ConversationHistory.groups(emptyList(), now, zone).isEmpty())
    }

    @Test fun dateLabelUsesTodayYesterdayWeekdayThenMonthDay() {
        assertEquals("今天", ConversationHistory.dateLabel(Instant.parse("2026-11-06T01:00:00Z"), now, zone))
        assertEquals("昨天", ConversationHistory.dateLabel(Instant.parse("2026-11-05T10:00:00Z"), now, zone))
        assertEquals("周一", ConversationHistory.dateLabel(Instant.parse("2026-11-02T02:00:00Z"), now, zone))
        assertEquals("10月21日", ConversationHistory.dateLabel(Instant.parse("2026-10-21T02:00:00Z"), now, zone))
    }

    @Test fun itemsAcceptTheContractPageAndRejectMalformedRows() {
        val id = UUID.randomUUID().toString()
        val rows = JSONArray().put(JSONObject()
            .put("id", id).put("title", "question").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", 2))
        val parsed = ConversationHistory.items(rows)
        assertEquals(listOf(HistoryConversation(id, "question", Instant.parse("2026-11-05T02:00:00Z"))), parsed)
        for (bad in listOf(
            JSONObject().put("id", "not-a-uuid").put("title", "t").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", 1),
            JSONObject().put("id", id).put("title", "t").put("updatedAt", "not-a-date").put("turnCount", 1),
            JSONObject().put("id", id).put("title", "t").put("updatedAt", "2026-11-05T02:00:00Z"),
            JSONObject().put("id", id).put("title", "t").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", -1),
            JSONObject().put("id", id).put("title", "t").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", 1).put("status", "unknown"),
        )) {
            try { ConversationHistory.items(JSONArray().put(bad)); fail("malformed row must fail the read") }
            catch (_: Exception) { }
        }
    }

    @Test fun itemsKeepAcceptedAndFailedStatusAndTheListLabelsStayReadable() {
        val id = UUID.randomUUID().toString()
        val rows = JSONArray()
            .put(JSONObject().put("id", id).put("title", "queued").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", 1).put("status", "queued"))
            .put(JSONObject().put("id", UUID.randomUUID().toString()).put("title", "failed").put("updatedAt", "2026-11-05T02:00:00Z").put("turnCount", 1).put("status", "failed"))
        val parsed = ConversationHistory.items(rows)
        assertEquals(listOf("queued", "failed"), parsed.map { it.status })
        assertEquals("处理中", ConversationHistory.statusLabel(parsed[0].status))
        assertEquals("未完成", ConversationHistory.statusLabel(parsed[1].status))
        assertNull(ConversationHistory.statusLabel("completed"))
    }

    @Test fun deleteActionsGainDetailsOnlyAfterAFailureIsRecorded() {
        val state = JSONObject(); val id = UUID.randomUUID().toString()
        assertEquals(listOf("删除这段对话"), ConversationHistory.deleteActions(state, id))
        assertNull(ConversationHistory.deleteFailure(state, id))
        ConversationHistory.recordDeleteFailure(state, id, CentralFailure(500, "internal", "detail"))
        assertEquals(listOf("删除这段对话", "查看详情"), ConversationHistory.deleteActions(state, id))
        val recorded = ConversationHistory.deleteFailure(state, id)!!
        assertEquals(id, recorded.optString("conversationId"))
        val error = recorded.getJSONArray("errors").getJSONObject(0)
        assertEquals(500, error.getInt("status")); assertEquals("internal", error.getString("code")); assertEquals("detail", error.getString("detail"))
        ConversationHistory.clearDeleteFailure(state, id)
        assertEquals(listOf("删除这段对话"), ConversationHistory.deleteActions(state, id))
    }

    @Test fun deleteFailureIsScopedToItsConversation() {
        val state = JSONObject(); val id = UUID.randomUUID().toString(); val other = UUID.randomUUID().toString()
        ConversationHistory.recordDeleteFailure(state, id, IllegalStateException("lost"))
        assertNull(ConversationHistory.deleteFailure(state, other))
        assertEquals(listOf("删除这段对话"), ConversationHistory.deleteActions(state, other))
    }

    @Test fun recordDeleteFailureWalksTheCauseChainOnce() {
        val state = JSONObject(); val id = UUID.randomUUID().toString()
        val outer = IllegalStateException("outer"); val inner = IllegalStateException("inner")
        outer.initCause(inner); inner.initCause(outer)
        ConversationHistory.recordDeleteFailure(state, id, outer)
        val errors = ConversationHistory.deleteFailure(state, id)!!.getJSONArray("errors")
        assertEquals(2, errors.length())
        assertEquals("outer", errors.getJSONObject(0).getString("message"))
        assertEquals("inner", errors.getJSONObject(1).getString("message"))
    }
}
