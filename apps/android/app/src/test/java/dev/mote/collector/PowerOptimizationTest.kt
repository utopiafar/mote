package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.util.zip.GZIPInputStream

class PowerOptimizationTest {
    @Test fun ocrDefaultsToOneEngineAndOnlyExplicitOverridesRunTwo() {
        assertEquals(listOf("chinese"), OcrPolicy.engines("chinese", "{}", "fixture.app"))
        assertEquals(listOf("latin"), OcrPolicy.engines("chinese", "{\"fixture.app\":\"latin\"}", "fixture.app"))
        assertEquals(listOf("chinese", "latin"), OcrPolicy.engines("dual", "{}", null))
        assertThrows(IllegalArgumentException::class.java) { OcrPolicy.validate("auto", "{}") }
        assertThrows(IllegalArgumentException::class.java) { OcrPolicy.validate("chinese", "{\"fixture.app\":\"unknown\"}") }
    }
    @Test fun partialReceiptsCannotClearMissingOrForeignRecords() {
        fun response(vararg entries: Pair<String, Int>) = JSONObject().put("results", JSONArray(entries.map { JSONObject().put("id", it.first).put("status", it.second) }))
        val expected = setOf("a", "b", "c")
        assertEquals(mapOf("a" to 201, "b" to 507), BatchUpload.receipts(expected, response("a" to 201, "b" to 507)))
        assertThrows(IllegalArgumentException::class.java) { BatchUpload.receipts(expected, response("other" to 201)) }
        assertThrows(IllegalArgumentException::class.java) { BatchUpload.receipts(expected, response("a" to 201, "a" to 201)) }
        assertThrows(IllegalArgumentException::class.java) { BatchUpload.receipts(expected, response("a" to 202)) }
    }
    @Test fun newInstallUsesActivityWhileLegacyDefaultRemainsContent() {
        assertEquals(AppCollectionMode.ACTIVITY, AppCollectionRules.parse(AppCollectionRules.DEFAULT).defaultMode)
        assertEquals(AppCollectionMode.CONTENT, AppCollectionRules.parse(AppCollectionRules.LEGACY_DEFAULT).defaultMode)
    }
    @Test fun captureBundleIsOneGzipJsonlStream() {
        val events = listOf(JSONObject().put("id", "a"), JSONObject().put("id", "b"))
        val raw = GZIPInputStream(ByteArrayInputStream(CaptureBundle.encode(events))).bufferedReader().readText()
        assertEquals("{\"id\":\"a\"}\n{\"id\":\"b\"}\n", raw)
    }
}
