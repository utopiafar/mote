package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class InsightPresentationTest {
    private fun report(id: String = UUID.randomUUID().toString(), text: String = "Generated conclusion", cited: Boolean = true) = JSONObject()
        .put("runId", id).put("answer", text).put("citations", JSONArray().apply { if (cited) put(JSONObject().put("id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")) })
    @Test fun `featured finding is the first actual cited result and retains its exact identity`() {
        val chosen = report(); val next = report()
        val items = JSONArray().put(report(cited = false)).put(report(text = " ")).put(report(id = "../other")).put(chosen).put(next)
        assertSame(chosen, InsightPresentation.featured(items)); assertEquals(chosen.getString("runId"), InsightPresentation.id(chosen))
        assertNull(InsightPresentation.featured(JSONArray())); assertNull(InsightPresentation.featured(JSONArray().put(report(cited = false))))
    }
    @Test fun `summary hides only actual citation markers and never breaks a Unicode character`() {
        val value = report(text = "🐾🐾 [aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa] [user bracket]  preserved")
        assertEquals("🐾🐾…", InsightPresentation.preview(value, 2))
        assertEquals("🐾🐾 [user bracket] preserved", InsightPresentation.preview(value))
    }
}
