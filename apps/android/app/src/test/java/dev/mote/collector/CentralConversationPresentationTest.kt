package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CentralConversationPresentationTest {
    private fun turn() = JSONObject().put("result", JSONObject().put("answer", "Generated saved answer").put("citations", org.json.JSONArray().put(JSONObject().put("id", "generated-original"))))
    @Test fun `ordinary deletion keeps exact saved answer and citation with the unavailable notice`() {
        val source = turn().put("evidenceStale", true).put("evidenceUnavailable", true)
        val shown = CentralConversationPresentation.read(source)
        assertEquals(MoteI18n.text("引用原文已删除，历史问答仍保留。"), shown.notice)
        assertSame(source.getJSONObject("result"), shown.result)
        assertEquals("generated-original", shown.result!!.getJSONArray("citations").getJSONObject(0).getString("id"))
    }
    @Test fun `privacy erasure wins over ordinary retirement and revision flags`() {
        val shown = CentralConversationPresentation.read(turn().put("evidenceDeleted", true).put("evidenceUnavailable", true).put("evidenceStale", true))
        assertEquals(MoteI18n.text("相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。"), shown.notice)
        assertNull(shown.result)
    }
    @Test fun `revision retains result and a failed turn never invents a result`() {
        val source = turn().put("evidenceStale", true)
        val shown = CentralConversationPresentation.read(source)
        assertEquals(MoteI18n.text("这是历史版本，当前资料已更新。"), shown.notice)
        assertSame(source.getJSONObject("result"), shown.result)
        assertNull(CentralConversationPresentation.read(JSONObject().put("evidenceUnavailable", true)).result)
    }
    @Test fun `accepted and queued turns expose their server status without a result`() {
        for (status in listOf("accepted", "queued", "running")) {
            val shown = CentralConversationPresentation.read(JSONObject().put("status", status))
            assertEquals(status, shown.status)
            assertNull(shown.notice)
            assertNull(shown.result)
        }
    }
    @Test fun `a failed turn keeps its server error for retry and details`() {
        val error = JSONObject().put("code", "provider_timeout").put("message", "Generated timeout")
        val shown = CentralConversationPresentation.read(JSONObject().put("status", "failed").put("error", error))
        assertEquals("failed", shown.status)
        assertEquals("provider_timeout", shown.error!!.getString("code"))
        assertNull(shown.result)
    }
}
