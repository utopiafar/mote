package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.json.JSONObject
import java.util.UUID

/** Count alone never proves what changed; only mutation events equaling the inventory delta prove pure inserts. */
class LibraryRefreshPolicyTest {
    @get:Rule val folder = TemporaryFolder()
    @Test fun physicalQueueBatchNotifiesEveryInsertDeleteAndRewrite() {
        var revision = 0L
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        val queue = DurableQueue(folder.newFolder(), cipher, initialOnMutation = { if (it) revision++ })
        fun note() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "note").put("capturedAt", "2026-01-01T00:00:00Z")
            .put("platform", "android").put("durationMs", 0).put("ocrText", "Generated queue contract").put("privacy", JSONObject().put("excluded", false))
        val first = note(); val second = note()
        queue.enqueue(first, null, 16_000_000); queue.enqueue(second, null, 16_000_000)
        val policy = LibraryRefreshPolicy(revision, queue.inventory().records)
        val baseline = revision
        queue.withDeferredIndexWrites {
            repeat(3) { queue.enqueue(note(), null, 16_000_000) }
            queue.acknowledge(first.getString("id")); queue.archiveMissing(second.getString("id"))
        }
        assertEquals(5L, revision - baseline)
        assertEquals(4, queue.inventory().records)
        assertEquals("net +2 is not pure insertion", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(revision, queue.inventory().records))
        repeat(5) { queue.enqueue(note(), null, 16_000_000) }
        assertEquals(LibraryRefreshPolicy.Action.INCREMENTAL, policy.recordsChanged(revision, queue.inventory().records))
    }
    @Test fun aFirstPageMustCoverEveryInsertionBeforeKeepingDeeperPages() {
        val policy = LibraryRefreshPolicy()
        assertFalse("backdated insert outside page one needs a full refresh", policy.firstPageCovers(5, 4))
        assertFalse("a larger burst cannot fit in one page", policy.firstPageCovers(21, 20))
        assertTrue(policy.firstPageCovers(5, 5))
    }
    @Test fun remotePrefixMustReachTheOldCursorNotMerelyOverlapItsHead() {
        val policy = LibraryRefreshPolicy()
        val boundary = LibraryRefreshPolicy.Position("2026-01-01T00:00:00Z", "c")
        assertFalse(policy.centralRangeCovers(boundary, true, LibraryRefreshPolicy.Position("2026-01-02T00:00:00Z", "a"), true))
        assertFalse("same-time UUIDs use descending order", policy.centralRangeCovers(boundary, true, boundary.copy(id = "d"), true))
        assertTrue(policy.centralRangeCovers(boundary, true, boundary.copy(id = "b"), true))
        assertTrue(policy.centralRangeCovers(boundary, true, boundary, true))
        assertTrue(policy.centralRangeCovers(boundary, true, boundary.copy(at = "2025-12-31T00:00:00Z"), true))
        assertFalse("a formerly complete domain with a truncated new prefix is unknown", policy.centralRangeCovers(null, false, boundary, true))
        assertTrue("an untruncated response proves the whole filtered domain", policy.centralRangeCovers(null, false, boundary, false))
    }
    @Test fun pureInsertBurstTakesTheIncrementalPath() {
        val policy = LibraryRefreshPolicy()
        assertEquals(LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(0, 100))
        assertEquals(LibraryRefreshPolicy.Action.INCREMENTAL, policy.recordsChanged(5, 105))
        assertEquals(LibraryRefreshPolicy.Action.INCREMENTAL, policy.recordsChanged(6, 106))
    }
    @Test fun decreaseSameCountReplacementAndMixedBurstsStayFull() {
        val policy = LibraryRefreshPolicy()
        policy.recordsChanged(10, 100)
        assertEquals("A deletion lowers the count", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(11, 99))
        assertEquals("A same-count rewrite keeps the count", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(12, 99))
        assertEquals("Insert and delete in one burst", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(15, 100))
    }
    @Test fun unknownOrUnpairedSignalsStayFull() {
        val policy = LibraryRefreshPolicy()
        assertEquals("First sighting has no baseline", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(3, 50))
        assertEquals("Unknown inventory cannot prove inserts", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(5, null))
        assertEquals(LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(6, 51))
        assertEquals("Coalesced unreported writes move more than the revision", LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(7, 53))
        assertEquals(LibraryRefreshPolicy.Action.INCREMENTAL, policy.recordsChanged(9, 55))
    }
    @Test fun debounceCoalescesAtLeastFiveSeconds() {
        assertEquals(5_000L, LibraryRefreshPolicy.DEBOUNCE_MILLIS)
    }
}
