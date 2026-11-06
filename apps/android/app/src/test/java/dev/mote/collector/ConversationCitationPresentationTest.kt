package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class ConversationCitationPresentationTest {
    private fun file(page: Int? = null, row: Int? = null, sheet: String? = null, startMs: Long? = null) = JSONObject().put(
        "fileEvidence",
        JSONObject().apply {
            page?.let { put("documentLocation", JSONObject().put("pageNumber", it).put("offset", 0).put("length", 12)) }
            row?.let {
                put("documentLocation", JSONObject().put("rowNumber", it).put("offset", 0).put("length", 12).apply {
                    sheet?.let { name -> put("sheetName", name) }
                })
            }
            startMs?.let { put("startMs", it).put("endMs", it + 4000) }
        },
    )

    private fun at(offsetDays: Long): String =
        Instant.now().atZone(ZoneId.systemDefault()).toLocalDate().minusDays(offsetDays)
            .atTime(14, 20).atZone(ZoneId.systemDefault()).toInstant().toString()

    @Test fun `document citation shows the file name and page`() {
        val citation = file(page = 4).put("id", "evidence-1").put("excerpt", "押金是两个月租金")
            .put("provenance", JSONObject().put("document", JSONObject().put("path", "租房合同 2026.pdf")))
        val shown = ConversationCitationPresentation.read(citation)
        assertEquals("租房合同 2026.pdf", shown.name)
        assertEquals(MoteI18n.text("第 {0} 页", 4), shown.detail)
        assertEquals("押金是两个月租金", shown.excerpt)
        assertEquals("evidence-1", shown.targetId)
    }

    @Test fun `sheet citation keeps the sheet name and row`() {
        val citation = file(row = 7, sheet = "账单").put("id", "evidence-2").put("excerpt", "已付")
            .put("provenance", JSONObject().put("document", JSONObject().put("path", "账单.xlsx")))
        assertEquals("账单 · " + MoteI18n.text("第 {0} 行", 7), ConversationCitationPresentation.read(citation).detail)
    }

    @Test fun `a stored position wins over the generic record label`() {
        val citation = JSONObject().put("id", "evidence-4").put("appName", "租房合同 2026.pdf")
            .put("title", "租房合同 2026.pdf").put("location", "第 4 页").put("capturedAt", at(0))
        val shown = ConversationCitationPresentation.read(citation)
        assertEquals("租房合同 2026.pdf", shown.name)
        assertEquals("第 4 页", shown.detail)
    }

    @Test fun `audio citation shows its position inside the recording`() {
        val citation = file(startMs = 62000).put("id", "evidence-3").put("excerpt", "约定")
        assertEquals(MoteI18n.text("录音") + " · 1:02", ConversationCitationPresentation.read(citation).detail)
    }

    @Test fun `record citation names the day it was captured`() {
        val today = JSONObject().put("id", "e1").put("appName", "微信").put("capturedAt", at(0))
        assertEquals(MoteI18n.text("记录") + " · " + MoteI18n.text("今天") + " 14:20", ConversationCitationPresentation.read(today).detail)
        val yesterday = JSONObject().put("id", "e2").put("appName", "微信").put("capturedAt", at(1))
        assertEquals(MoteI18n.text("记录") + " · " + MoteI18n.text("昨天") + " 14:20", ConversationCitationPresentation.read(yesterday).detail)
    }

    @Test fun `citation without a title falls back to its excerpt first line`() {
        val citation = JSONObject().put("id", "e1").put("appName", "微信").put("capturedAt", at(0))
            .put("excerpt", "\n  暖气费按实际用量分摊，月底前给账单照片\n第二行")
        assertEquals("暖气费按实际用量分摊，月底前给账单照片", ConversationCitationPresentation.read(citation).name)
    }

    @Test fun `citation without title or excerpt uses the app name`() {
        val citation = JSONObject().put("id", "e1").put("appName", "微信").put("capturedAt", at(0))
        assertEquals("微信", ConversationCitationPresentation.read(citation).name)
    }

    @Test fun `locate finds the exact excerpt and tolerates reader whitespace`() {
        val text = "按实际用量分摊，月底前把账单照片发给房东；押金下个月退，需要收据。"
        assertEquals(0 until 7, ConversationCitationPresentation.locate(text, "按实际用量分摊"))
        assertEquals(8 until 16, ConversationCitationPresentation.locate(text, "\n月底前把账单照片 "))
        assertNull(ConversationCitationPresentation.locate(text, "没有出现"))
        assertNull(ConversationCitationPresentation.locate(text, ""))
        assertNull(ConversationCitationPresentation.locate("", "按实际"))
    }
}
