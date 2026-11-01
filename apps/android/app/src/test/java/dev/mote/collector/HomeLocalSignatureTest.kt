package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

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

    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    @Test fun aFutureDatedRecordStillCountsAsExisting() {
        // A record saved while the clock ran fast is stored the moment it arrives; the existence
        // check the home caches by revision must see it without waiting for the clock to pass.
        val queue = DurableQueue(folder.newFolder(), cipher)
        val cache = RevisionCache()
        assertFalse(collect(cache, 3) { HomeLocalCaptures.exists(queue) }.getBoolean("hasAnyRecords"))
        queue.enqueue(note().put("capturedAt", java.time.Instant.now().plusSeconds(3600).toString()), null, 16L * 1024 * 1024)
        assertTrue("a future-dated record is a stored record", collect(cache, 4) { HomeLocalCaptures.exists(queue) }.getBoolean("hasAnyRecords"))
    }

    @Test fun aFailedListingDoesNotCacheAsEmpty() {
        // A directory-listing failure must surface: it can neither report an empty archive nor
        // be retained by the revision cache once storage is readable again.
        val dir = folder.newFolder(); val queue = DurableQueue(dir, cipher)
        queue.enqueue(note(), null, 16L * 1024 * 1024)
        val cache = RevisionCache()
        assertTrue(collect(cache, 5) { HomeLocalCaptures.exists(queue) }.getBoolean("hasAnyRecords"))
        val hidden = java.io.File(dir.parentFile, dir.name + ".hidden")
        check(dir.renameTo(hidden)); check(java.io.File(dir.path).createNewFile())
        try {
            assertThrows(Exception::class.java) { collect(cache, 6) { HomeLocalCaptures.exists(queue) } }
        } finally {
            check(java.io.File(dir.path).delete()); check(hidden.renameTo(dir))
        }
        assertTrue("the failed read never cached, so the same revision rechecks", collect(cache, 6) { HomeLocalCaptures.exists(queue) }.getBoolean("hasAnyRecords"))
    }

    @Test fun anInterruptedCaptureRecoveredOnOpenAdvancesTheRecordRevision() {
        // enqueue crashes inside a stage, leaving its committed inbox; the next queue open
        // replays it before any mutation listener exists, and openQueue then reports the write
        // to the records revision — so a revision-keyed cache can never stay on "empty".
        var crash = true
        val stage = object : CaptureStage {
            override val id = "crash-fixture"; override val version = 1
            override fun consume(inputs: List<StageCapture>, checkpoint: JSONObject?, held: List<StageCapture>, flush: Boolean,
                                 deriveId: (List<String>, String) -> String): StageResult {
                if (crash) { crash = false; error("generated stage crash") }
                return StageResult(inputs)
            }
        }
        val registry = CaptureStageRegistry(listOf(stage))
        val dir = folder.newFolder()
        val cache = RevisionCache()
        val revisionBefore = LocalStateChanges.revisions.value.records
        assertFalse(collect(cache, revisionBefore) { HomeLocalCaptures.exists(DurableQueue(dir, cipher)) }.getBoolean("hasAnyRecords"))
        val queue = DurableQueue(dir, cipher, captureStages = registry)
        assertThrows(IllegalStateException::class.java) { queue.enqueue(note(), null, 1_000_000) }
        val recovered = DurableQueue(dir, cipher, captureStages = registry)
        assertTrue("the replay committed a record while no listener existed", recovered.unreportedRecordWrites)
        assertTrue(HomeLocalCaptures.exists(recovered))
        // The same wiring QueueStorage.openQueue performs after installing onMutation.
        if (recovered.unreportedRecordWrites) { recovered.unreportedRecordWrites = false; LocalStateChanges.changed(records = true) }
        val revisionAfter = LocalStateChanges.revisions.value.records
        assertTrue("recovery advanced the record revision", revisionAfter > revisionBefore)
        assertTrue("the recovered record is seen at the new revision", collect(cache, revisionAfter) { HomeLocalCaptures.exists(recovered) }.getBoolean("hasAnyRecords"))
    }

    private fun note() = JSONObject().put("id", UUID.randomUUID().toString())
        .put("capturedAt", "2026-01-01T00:00:00Z").put("platform", "android").put("durationMs", 1000)
        .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none")).put("source", "note")

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
