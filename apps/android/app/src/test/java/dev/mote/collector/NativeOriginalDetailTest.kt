package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeOriginalDetailTest {
    private val id = "00000000-0000-4000-8000-000000000001"
    private val material = "material:mat_" + "a".repeat(64) + "@" + "b".repeat(64)

    private fun record(status: String = "indexed") = JSONObject()
        .put("id", id)
        .put("capturedAt", "2026-11-06T06:20:00Z")
        .put("receivedAt", "2026-11-06T06:22:00Z")
        .put("indexingStatus", status)
        .put("source", "note")
        .put("deviceName", "Generated phone")
        .put("windowTitle", "Generated original")
        .put("ocrText", "Generated original body")

    @Test fun `capture detail keeps receipt times and the exact source`() {
        val detail = NativeOriginalDetail.capture(record())
        assertEquals("Generated original", detail.title)
        assertEquals(listOf("本机已保存", "中央已接收", "已整理，可搜索"), detail.timeline.map { it.title })
        assertTrue(detail.timeline.all { it.completed })
        assertEquals("2026-11-06T06:20:00Z", detail.timeline[0].at)
        assertEquals("2026-11-06T06:22:00Z", detail.timeline[1].at)
        assertEquals("记录 · Generated phone", detail.source)
    }

    @Test fun `organized receipt keeps the recorded completion time`() {
        val detail = NativeOriginalDetail.capture(record().put("ocr", JSONObject().put("status", "completed").put("updatedAt", "2026-11-06T06:25:00Z")))
        assertEquals("2026-11-06T06:25:00Z", detail.timeline[2].at)
        assertEquals("2026-11-06T06:26:00Z", NativeOriginalDetail.capture(record("indexed").put("indexedAt", "2026-11-06T06:26:00Z")).timeline[2].at)
    }

    @Test fun `an unfinished index never claims searchable receipts`() {
        assertEquals("正在整理", NativeOriginalDetail.capture(record("pending")).timeline[2].title)
        assertFalse(NativeOriginalDetail.capture(record("pending")).timeline[2].completed)
        assertEquals("整理未完成", NativeOriginalDetail.capture(record("failed")).timeline[2].title)
        assertFalse(NativeOriginalDetail.capture(record("failed")).timeline[2].completed)
        assertTrue(NativeOriginalDetail.capture(record("text_ready")).timeline[2].completed)
    }

    @Test fun `material detail uses its origin times coverage and exact ref`() {
        val item = JSONObject()
            .put("title", "Generated whole material")
            .put("kind", "mote.file")
            .put("ref", material)
            .put("createdAt", "2026-11-06T06:22:00Z")
            .put("coverage", JSONObject().put("state", "complete"))
            .put("origin", JSONObject().put("sourceId", "generated-source").put("deviceId", "generated-device").put("firstAt", "2026-11-06T06:20:00Z"))
        val detail = NativeOriginalDetail.material(item)
        assertEquals("Generated whole material", detail.title)
        assertEquals(listOf("本机已保存", "中央已接收", "已整理，可搜索"), detail.timeline.map { it.title })
        assertEquals("2026-11-06T06:20:00Z", detail.timeline[0].at)
        assertEquals("文件 · generated-device", detail.source)
    }

    @Test fun `capture title falls back to the first line or app name`() {
        assertEquals("Generated first line", NativeOriginalDetail.title(JSONObject().put("ocrText", "\nGenerated first line\nsecond")))
        assertEquals("Generated app", NativeOriginalDetail.title(JSONObject().put("appName", "Generated app")))
        assertEquals("记录", NativeOriginalDetail.title(JSONObject()))
    }
}
