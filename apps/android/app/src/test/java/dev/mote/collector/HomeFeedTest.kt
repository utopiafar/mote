package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone

class HomeFeedTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-11-06T04:00:00Z") // 12:00 in the zone

    private fun row(id: String, at: String, source: String = "screen", extra: JSONObject.() -> Unit = {}) = JSONObject()
        .put("id", id).put("capturedAt", at).put("source", source)
        .put("deviceId", "device-1").put("windowTitle", "生成的窗口 $id")
        .put("appName", "生成应用").put("textPreview", "").put("hasImage", source == "screen")
        .apply(extra)

    private fun feed(vararg items: JSONObject) = items.map { HomeFeed.original(it) }

    @Test fun `page validates every row before it reaches the feed`() {
        val page = JSONObject().put("items", JSONArray()
            .put(row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z"))
            .put(row("4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-05T03:00:00Z", "media").put("durationMs", 76000)))
        val originals = HomeFeed.page { page }
        assertEquals(2, originals.size)
        assertEquals("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", originals[0].id)
        assertEquals(MoteI18n.text("录音") + " 1:16", originals[1].kind)
        assertTrue(originals[0].hasImage)
        assertFalse(originals[1].hasImage)
    }

    @Test fun `malformed rows fail the whole read instead of rendering partially`() {
        val bad = JSONArray().put(row("not-a-uuid", "2026-11-06T03:00:00Z"))
        assertThrows(IllegalArgumentException::class.java) { HomeFeed.page { JSONObject().put("items", bad) } }
        val missing = JSONObject(row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z").toString()).apply { remove("deviceId") }
        assertThrows(Exception::class.java) { HomeFeed.original(missing) }
        val wrongType = row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z").put("hasImage", "yes")
        assertThrows(IllegalArgumentException::class.java) { HomeFeed.original(wrongType) }
        val badDate = row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "not-a-date")
        assertThrows(Exception::class.java) { HomeFeed.original(badDate) }
    }

    @Test fun `days sorts newest first and groups by local calendar day`() {
        val originals = feed(
            row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-04T10:00:00Z"), // Nov 4 18:00 in zone
            row("4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T01:00:00Z"), // Nov 6 09:00
            row("5f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-05T16:30:00Z"), // Nov 6 00:30
            row("6f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-05T08:00:00Z"), // Nov 5 16:00
        )
        val days = HomeFeed.days(originals, zone, now)
        assertEquals(3, days.size)
        assertEquals(MoteI18n.text("今天"), days[0].label)
        assertEquals(listOf("4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "5f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"), days[0].items.map { it.id })
        assertEquals(MoteI18n.text("昨天"), days[1].label)
        assertEquals(listOf("6f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"), days[1].items.map { it.id })
        assertNotEquals(MoteI18n.text("今天"), days[2].label)
        assertNotEquals(MoteI18n.text("昨天"), days[2].label)
        assertEquals(listOf("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"), days[2].items.map { it.id })
    }

    @Test fun `equal timestamps keep the server order and older days get a date label`() {
        val tie = "2026-11-05T10:00:00Z"
        val originals = feed(
            row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", tie),
            row("4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", tie),
            row("5f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-01T10:00:00Z"),
        )
        val days = HomeFeed.days(originals, zone, now)
        assertEquals(2, days.size)
        assertEquals(MoteI18n.text("昨天"), days[0].label)
        assertEquals(listOf("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"), days[0].items.map { it.id })
        assertNotEquals(MoteI18n.text("今天"), days[1].label)
        assertNotEquals(MoteI18n.text("昨天"), days[1].label)
        assertTrue(days[1].label.isNotBlank())
    }

    @Test fun `day label falls back to a localized date beyond yesterday`() {
        val date = LocalDate.of(2026, 10, 20)
        val label = HomeFeed.dayLabel(date, LocalDate.of(2026, 11, 6))
        assertTrue(label.contains("2026"))
    }

    @Test fun `title prefers captured text then window title then app name`() {
        val withText = row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z")
            .put("textPreview", "第一行内容\n第二行被忽略")
        assertEquals("第一行内容", HomeFeed.title(withText))
        val noText = row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z")
            .put("textPreview", "  ").put("windowTitle", "")
        assertEquals("生成应用", HomeFeed.title(noText))
        val bare = JSONObject().put("source", "note")
        assertEquals(HomeFeed.kind(bare), HomeFeed.title(bare))
        val long = row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z")
            .put("textPreview", "长".repeat(200))
        assertEquals(80, HomeFeed.title(long).length)
    }

    @Test fun `kind mirrors the library type wording`() {
        fun kindOf(source: String, configure: JSONObject.() -> Unit = {}) =
            HomeFeed.kind(JSONObject().put("source", source).apply(configure))
        assertEquals(MoteI18n.text("照片"), kindOf("screen") { put("hasImage", true) })
        assertEquals(MoteI18n.text("截图"), kindOf("screen") { put("hasImage", false) })
        assertEquals(MoteI18n.text("通知"), kindOf("notification"))
        assertEquals(MoteI18n.text("网页"), kindOf("ui_page"))
        assertEquals(MoteI18n.text("应用活动"), kindOf("activity"))
        assertEquals(MoteI18n.text("设备事件"), kindOf("device_event"))
        assertEquals(MoteI18n.text("文件"), kindOf("note") { put("windowTitle", "报告.PDF") })
        assertEquals(MoteI18n.text("记录"), kindOf("note"))
        assertEquals(MoteI18n.text("采集记录"), kindOf("unknown_source"))
        assertEquals(MoteI18n.text("录音") + " 12:40", kindOf("media") { put("durationMs", 760000) })
        assertEquals(MoteI18n.text("录音"), kindOf("media"))
    }

    @Test fun `detail always carries time then type`() {
        val original = HomeFeed.original(row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-06T03:00:00Z"))
        val detail = HomeFeed.detail(original)
        assertTrue(detail.contains(" · "))
        assertTrue(detail.endsWith(" · " + MoteI18n.text("照片")))
    }

    @Test fun `original keeps the local day for the reader intent`() {
        val previous = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
            val original = HomeFeed.original(row("3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d", "2026-11-05T16:30:00Z"))
            assertEquals("2026-11-06", original.day)
        } finally {
            TimeZone.setDefault(previous)
        }
    }

    @Test fun `offline local original is a saved row and its central acknowledgement joins by exact identity`() {
        val id = "3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"
        val localRow = row(id, "2026-11-06T03:00:00Z", "note").put("textPreview", "生成的离线记录")
        val local = HomeFeed.localPage { JSONObject().put("items", JSONArray().put(localRow)) }
        assertFalse(local.single().remote)
        assertTrue(local.single().saved)
        assertTrue(HomeFeed.detail(local.single()).endsWith(" · " + MoteI18n.text("已保存")))

        val central = listOf(HomeFeed.original(localRow))
        val joined = HomeFeed.merge(local, mapOf(id to "https://central.invalid"), central, "https://central.invalid")
        assertEquals("the acknowledged id appears once", 1, joined.size)
        assertTrue(joined.single().remote)
        assertFalse(joined.single().saved)
    }

    @Test fun `connection switching never joins another origin or device and access loss keeps local rows`() {
        val id = "3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"
        val local = HomeFeed.localPage { JSONObject().put("items", JSONArray().put(row(id, "2026-11-06T03:00:00Z", "note"))) }
        val central = listOf(
            HomeFeed.original(row(id, "2026-11-06T03:00:00Z", "note")),
            HomeFeed.original(row(id, "2026-11-06T03:00:00Z", "note").put("deviceId", "other-device")),
        )
        val switched = HomeFeed.merge(local, mapOf(id to "https://old.invalid"), central, "https://new.invalid")
        assertEquals(3, switched.size)
        val revoked = HomeFeed.merge(local, mapOf(id to "https://old.invalid"), emptyList(), "")
        assertEquals(1, revoked.size)
        assertFalse(revoked.single().remote)
        assertTrue(revoked.single().saved)
    }
}
