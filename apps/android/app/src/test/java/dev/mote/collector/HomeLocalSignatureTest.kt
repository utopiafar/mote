package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Drives the same `HomeLocalCaptures.collect` call `MainActivity.loadHomeContent` issues each
 * refresh cycle: the queue is opened for the existence check only when the local-records
 * revision changed; drafts, the saved receipt and the source rows pass through every cycle.
 */
class HomeLocalSignatureTest {

    private fun collect(cache: RevisionCache, revision: Long, draft: JSONObject = JSONObject(), receipt: JSONObject? = null, exists: () -> Boolean) =
        HomeLocalCaptures.collect(cache, revision, draft, receipt, exists)

    @Test fun anUnchangedRecordsRevisionNeverReopensTheQueue() {
        val cache = RevisionCache()
        var reads = 0
        val exists = { reads++; true }
        repeat(5) {
            assertTrue(collect(cache, 7, exists = exists).getBoolean("hasAnyRecords"))
        }
        assertEquals("five refresh cycles issue exactly one existence query", 1, reads)
    }

    @Test fun deletingEveryRecordRechecksFirstUse() {
        val cache = RevisionCache()
        var records = 3
        var reads = 0
        val exists = { reads++; records > 0 }
        assertTrue(collect(cache, 4, exists = exists).getBoolean("hasAnyRecords"))
        assertTrue(collect(cache, 4, exists = exists).getBoolean("hasAnyRecords"))
        assertEquals(1, reads)
        records = 0
        assertFalse("a full deletion bumps the revision and flips the answer", collect(cache, 5, exists = exists).getBoolean("hasAnyRecords"))
        assertEquals(2, reads)
        records = 1
        assertTrue("records arriving later recheck again", collect(cache, 6, exists = exists).getBoolean("hasAnyRecords"))
        assertEquals(3, reads)
    }

    @Test fun theDraftFlagFollowsAnyDraftContent() {
        val cache = RevisionCache()
        assertFalse(collect(cache, 1) { true }.getBoolean("hasDraft"))
        assertTrue(collect(cache, 1, JSONObject().put("text", "a note")) { true }.getBoolean("hasDraft"))
        assertTrue(collect(cache, 1, JSONObject().put("description", "desc")) { true }.getBoolean("hasDraft"))
        assertTrue(collect(cache, 1, JSONObject().put("attachments", JSONArray().put("a.jpg"))) { true }.getBoolean("hasDraft"))
        assertTrue(collect(cache, 1, JSONObject().put("origin", JSONObject().put("text", "source"))) { true }.getBoolean("hasDraft"))
        assertFalse("a draft of empty fields is not a draft", collect(cache, 1, JSONObject().put("text", "  ").put("description", "")) { true }.getBoolean("hasDraft"))
    }

    @Test fun theSavedReceiptPassesThroughWhenPresent() {
        val cache = RevisionCache()
        val receipt = JSONObject().put("id", "r-1").put("capturedAt", "2026-10-31T10:00:00Z")
        val withReceipt = collect(cache, 1, receipt = receipt) { true }
        assertEquals("r-1", withReceipt.getJSONObject("savedReceipt").getString("id"))
        assertNull("no receipt leaves no card key", collect(cache, 1, receipt = null) { true }.optJSONObject("savedReceipt"))
    }

    @Test fun anUnsetSourceSignatureNeverMatchesAnEmptyList() {
        // Mirrors the activity's nullable initial signature: an empty first render must still
        // build so the "no folders yet" guidance is not skipped.
        var rendered: String? = null
        val first = HomeLocalSignature.sources(emptyList())
        assertTrue("an empty list must still build its guidance row", first != rendered)
        rendered = first
        assertFalse("the same empty list does not rebuild", HomeLocalSignature.sources(emptyList()) != rendered)
    }

    @Test fun sourceSignaturesTrackOnlyRenderedContent() {
        val rows = listOf(Triple("s1", "Photos", "已同步"), Triple("s2", "Docs", "扫描中\n12/40"))
        val signature = HomeLocalSignature.sources(rows)
        assertEquals(signature, HomeLocalSignature.sources(rows))
        assertNotEquals(signature, HomeLocalSignature.sources(rows.reversed()))
        assertNotEquals("progress text is part of the row", signature, HomeLocalSignature.sources(listOf(Triple("s1", "Photos", "已同步"), Triple("s2", "Docs", "扫描中\n13/40"))))
        assertNotEquals("a removed row changes the list", signature, HomeLocalSignature.sources(rows.drop(1)))
        assertNotEquals(
            "separators inside a value cannot collide with boundaries",
            HomeLocalSignature.sources(listOf(Triple("a\u0001b", "c", "d"))),
            HomeLocalSignature.sources(listOf(Triple("a", "b\u0001c", "d"))),
        )
    }

    @Test fun receiptSignaturesCoverTheWholeCard() {
        val base = HomeLocalSignature.receipt("r1", "preview", "10:00", connected = true)
        assertEquals(base, HomeLocalSignature.receipt("r1", "preview", "10:00", true))
        assertNotEquals(base, HomeLocalSignature.receipt("r2", "preview", "10:00", true))
        assertNotEquals(base, HomeLocalSignature.receipt("r1", "preview 2", "10:00", true))
        assertNotEquals(base, HomeLocalSignature.receipt("r1", "preview", "10:01", true))
        assertNotEquals("the Central link toggle changes the card", base, HomeLocalSignature.receipt("r1", "preview", "10:00", false))
        assertNotEquals(
            "separators inside the preview cannot collide with boundaries",
            HomeLocalSignature.receipt("a\u0002b", "c", "d", true),
            HomeLocalSignature.receipt("a", "b\u0002c", "d", true),
        )
    }
}
