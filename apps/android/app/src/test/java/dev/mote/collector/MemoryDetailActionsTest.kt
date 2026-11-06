package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** M05/M06: Memory detail wording and the owner DELETE request used by the native view. */
class MemoryDetailActionsTest {
    private val id = "00000000-0000-4000-8000-000000000001"
    private val next = "00000000-0000-4000-8000-000000000002"
    private val other = "00000000-0000-4000-8000-000000000003"
    private fun client(calls: MutableList<String>, response: (String) -> JSONObject): CentralClient =
        CentralClient("http://127.0.0.1:49001", "generated-owner-token", transport = { method, url, body, _, _ ->
            calls.add(method + " " + url.substringAfter("49001") + (body?.let { " " + String(it) } ?: ""))
            200 to response(url)
        })

    @Test fun `more and correction wording match the web memory detail`() {
        assertEquals(listOf("纠正这条记忆", "历史与有效时间", "生成信息", "删除记忆"), MemoryDetailPanel.moreItems)
        assertEquals(listOf("标题", "纠正后的内容", "判断的边界", "生效时间", "失效时间"), MemoryDetailPanel.correctionFields)
        assertEquals("纠正", MemoryDetailPanel.correctionAction)
        assertEquals("取消", MemoryDetailPanel.correctionCancel)
        assertFalse(MemoryDetailPanel.correctionFields.contains("保存校正"))
        assertFalse(MemoryDetailPanel.correctionAction == "保存校正")
    }

    @Test fun `delete confirmation is word for word the web dialog`() {
        assertEquals("删除这条记忆？", MemoryDetailPanel.deleteTitle)
        assertEquals("原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。", MemoryDetailPanel.deleteMessage)
        assertEquals("确认删除", MemoryDetailPanel.deleteConfirm)
        assertEquals("取消", MemoryDetailPanel.deleteCancel)
    }

    @Test fun `memory deletion sends the same owner DELETE endpoint as web`() {
        val calls = mutableListOf<String>()
        val receipt = JSONObject().put("externalErase", "acknowledged").put("physicalEraseVerified", true)
        val client = client(calls) { receipt }
        assertEquals(receipt.toString(), MemoryDetailPanel.delete(client, id).toString())
        assertEquals(listOf("DELETE /api/memories/$id {}"), calls)
        assertEquals("记忆已禁止使用。", MemoryDetailPanel.deletionNotice(receipt))
    }

    @Test fun `deletion notices use the same pending acknowledged and default text as web`() {
        assertEquals("记忆已禁止使用；外部清除仍待确认。", MemoryDetailPanel.deletionNotice(JSONObject().put("externalErase", "pending")))
        assertEquals("记忆已禁止使用；外部已确认移除当前记录，物理擦除尚未核验。",
            MemoryDetailPanel.deletionNotice(JSONObject().put("externalErase", "acknowledged").put("physicalEraseVerified", false)))
        assertEquals("记忆已禁止使用。", MemoryDetailPanel.deletionNotice(JSONObject()))
    }

    @Test fun `correction request carries the five panel fields and version`() {
        val body = MemoryDetailPanel.correctionRequest("Synthetic title", "Synthetic statement", "Synthetic boundary",
            "2026-11-06 10:30", "2026-11-07T02:00:00Z", 3)
        assertEquals("Synthetic title", body.getString("title"))
        assertEquals("Synthetic statement", body.getString("statement"))
        assertEquals("Synthetic boundary", body.getString("uncertainty"))
        assertEquals(3, body.getInt("version"))
        assertEquals(LocalDateTime.parse("2026-11-06 10:30", DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
            .atZone(ZoneId.systemDefault()).toInstant(), Instant.parse(body.getString("validFrom")))
        assertEquals(Instant.parse("2026-11-07T02:00:00Z"), Instant.parse(body.getString("validUntil")))
    }

    @Test fun `blank validity fields stay omitted and an invalid time is rejected`() {
        val body = MemoryDetailPanel.correctionRequest("Synthetic title", "Synthetic statement", "", "", "", 1)
        assertFalse(body.has("validFrom"))
        assertFalse(body.has("validUntil"))
        val calls = mutableListOf<String>()
        val client = client(calls) { JSONObject() }
        assertThrows(IllegalArgumentException::class.java) {
            MemoryDetailPanel.correct(client, id, MemoryDetailPanel.correctionRequest("Synthetic title", "Synthetic statement", "", "not-a-time", "", 1))
        }
        assertTrue(calls.isEmpty())
    }

    @Test fun `history follows explicit replacement links and keeps contradictions separate`() {
        val calls = mutableListOf<String>()
        val current = JSONObject().put("id", id).put("supersededBy", next)
            .put("relations", JSONArray().put(JSONObject().put("kind", "contradicts").put("memoryId", other)))
        val older = JSONObject().put("id", next)
        val client = client(calls) { url -> if (url.endsWith(next)) older else current }
        assertEquals(listOf(id, next), MemoryDetailPanel.history(client, id).map { it.getString("id") })
        assertEquals(listOf("/api/memories/$id", "/api/memories/$next"), calls.map { it.substringAfter(' ') })
    }
}
