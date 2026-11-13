package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CentralConversationMessageTest {
    private fun receipt(status: String = "accepted") = JSONObject()
        .put("id", UUID.randomUUID().toString())
        .put("conversationId", UUID.randomUUID().toString())
        .put("clientRequestId", UUID.randomUUID().toString())
        .put("status", status).put("seq", 2).put("revision", 1)

    @Test fun `the C2 C6 receipt keeps the exact server state and identity`() {
        val value = receipt("queued")
        val parsed = CentralConversationMessage.read(value)
        assertEquals(value.getString("id"), parsed.id)
        assertEquals(value.getString("conversationId"), parsed.conversationId)
        assertEquals(value.getString("clientRequestId"), parsed.clientRequestId)
        assertEquals("queued", parsed.status)
        assertEquals(2, parsed.seq)
        assertNull(parsed.runId)
    }

    @Test fun `unknown or malformed receipts fail the read`() {
        for (bad in listOf(
            receipt().put("status", "stopped"),
            receipt().put("id", "not-a-uuid"),
            receipt().put("clientRequestId", "not-a-uuid"),
            receipt().put("seq", -1),
            receipt().put("revision", 0),
        )) {
            assertThrows(IllegalArgumentException::class.java) { CentralConversationMessage.read(bad) }
        }
    }

    @Test fun `a page turn with the same client request id becomes a readable receipt`() {
        val turn = JSONObject().put("id", UUID.randomUUID().toString())
            .put("clientRequestId", UUID.randomUUID().toString())
            .put("status", "running").put("seq", 0).put("version", 2)
        val conversationId = UUID.randomUUID().toString()
        val receipt = requireNotNull(CentralConversationMessage.fromTurn(turn, conversationId))
        assertEquals(2, receipt.getInt("revision"))
        assertEquals("running", CentralConversationMessage.read(receipt).status)
        assertNull(CentralConversationMessage.fromTurn(turn.apply { remove("clientRequestId") }, conversationId))
    }

    @Test fun `status labels come from the same accepted state`() {
        assertEquals(MoteI18n.text("已收到"), CentralConversationMessage.statusLabel("accepted"))
        assertEquals(MoteI18n.text("排队中"), CentralConversationMessage.statusLabel("queued"))
        assertEquals(MoteI18n.text("中央正在回答…"), CentralConversationMessage.statusLabel("running"))
        assertEquals(MoteI18n.text("回答未完成"), CentralConversationMessage.statusLabel("failed"))
        assertEquals(MoteI18n.text("已停止回答"), CentralConversationMessage.statusLabel("cancelled"))
        assertNull(CentralConversationMessage.statusLabel("unknown"))
    }
}
