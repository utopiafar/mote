package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class NativeOriginalDetailTest {
    private val id = "00000000-0000-4000-8000-000000000001"
    private val material = "material:mat_" + "a".repeat(64) + "@" + "b".repeat(64)

    private fun record(status: String = "indexed", materialRef: String? = null) = JSONObject()
        .put("id", id)
        .put("capturedAt", "2026-11-06T06:20:00Z")
        .put("receivedAt", "2026-11-06T06:22:00Z")
        .put("indexingStatus", status)
        .put("source", "note")
        .put("deviceName", "Generated phone")
        .put("windowTitle", "Generated original")
        .put("ocrText", "Generated original body")
        .apply { if (materialRef != null) put("memoryMaterialRef", materialRef) }

    private fun conversation(scope: JSONObject) = JSONObject().put("id", UUID.randomUUID().toString()).put("scope", scope)

    @Test fun `capture detail keeps receipt times and the exact source`() {
        val detail = NativeOriginalDetail.capture(record(), emptyList())
        assertEquals("Generated original", detail.title)
        assertEquals(listOf("本机已保存", "中央已接收", "已整理，可搜索"), detail.timeline.map { it.title })
        assertTrue(detail.timeline.all { it.completed })
        assertEquals("2026-11-06T06:20:00Z", detail.timeline[0].at)
        assertEquals("2026-11-06T06:22:00Z", detail.timeline[1].at)
        assertEquals("记录 · Generated phone", detail.source)
        assertEquals(0, detail.referenceCount)
    }

    @Test fun `an unfinished index never claims searchable receipts`() {
        assertEquals("正在整理", NativeOriginalDetail.capture(record("pending"), emptyList()).timeline[2].title)
        assertFalse(NativeOriginalDetail.capture(record("pending"), emptyList()).timeline[2].completed)
        assertEquals("整理未完成", NativeOriginalDetail.capture(record("failed"), emptyList()).timeline[2].title)
        assertFalse(NativeOriginalDetail.capture(record("failed"), emptyList()).timeline[2].completed)
        assertTrue(NativeOriginalDetail.capture(record("text_ready"), emptyList()).timeline[2].completed)
    }

    @Test fun `references count exact evidence and the same material across conversations`() {
        val conversations = listOf(
            conversation(JSONObject().put("evidenceIds", JSONArray().put(id))),
            conversation(JSONObject().put("anchorEvidenceIds", JSONArray().put(id))),
            conversation(JSONObject().put("anchorMaterialRef", material)),
            conversation(JSONObject().put("evidenceIds", JSONArray().put(UUID.randomUUID().toString()))),
            conversation(JSONObject().put("anchorMaterialRef", material.replace("mat_a", "mat_c"))),
            conversation(JSONObject()),
        )
        assertEquals(3, NativeOriginalDetail.count(conversations, id, material))
        assertEquals(1, NativeOriginalDetail.count(conversations, null, material))
        assertEquals(2, NativeOriginalDetail.count(conversations, id, null))
    }

    @Test fun `missing conversations do not invent a reference count`() {
        assertNull(NativeOriginalDetail.capture(record(), null).referenceCount)
        assertNull(NativeOriginalDetail.material(JSONObject().put("id", material), null).referenceCount)
    }

    @Test fun `material detail uses its origin times coverage and exact ref`() {
        val item = JSONObject()
            .put("title", "Generated whole material")
            .put("kind", "mote.file")
            .put("ref", material)
            .put("createdAt", "2026-11-06T06:22:00Z")
            .put("coverage", JSONObject().put("state", "complete"))
            .put("origin", JSONObject().put("sourceId", "generated-source").put("deviceId", "generated-device").put("firstAt", "2026-11-06T06:20:00Z"))
        val detail = NativeOriginalDetail.material(item, listOf(conversation(JSONObject().put("anchorMaterialRef", material))))
        assertEquals("Generated whole material", detail.title)
        assertEquals(listOf("本机已保存", "中央已接收", "已整理，可搜索"), detail.timeline.map { it.title })
        assertEquals("2026-11-06T06:20:00Z", detail.timeline[0].at)
        assertEquals("文件 · generated-device", detail.source)
        assertEquals(1, detail.referenceCount)
    }

    @Test fun `capture title falls back to the first line or app name`() {
        assertEquals("Generated first line", NativeOriginalDetail.title(JSONObject().put("ocrText", "\nGenerated first line\nsecond")))
        assertEquals("Generated app", NativeOriginalDetail.title(JSONObject().put("appName", "Generated app")))
        assertEquals("记录", NativeOriginalDetail.title(JSONObject()))
    }
}
