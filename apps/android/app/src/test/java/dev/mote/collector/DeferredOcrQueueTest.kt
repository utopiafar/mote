package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class DeferredOcrQueueTest {
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun event(at: String, pending: Boolean = true) = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", at).put("privacy", JSONObject().put("excluded", false)).put("imageMime", "image/jpeg").put("ocrText", "")
        .put("ocr", JSONObject().put("status", if (pending) "pending" else "completed").apply { if (pending) put("reason", "charging") })

    @Test fun acknowledgedPendingImageSurvivesRestartWithoutBlockingLaterUploadsAndKeepsOriginalWireEvent() {
        val directory = Files.createTempDirectory("mote-ocr-queue").toFile()
        try {
            val queue = DurableQueue(directory, cipher); val first = event("2026-09-14T00:00:00Z"); val second = event("2026-09-14T00:01:00Z", false)
            val id = first.getString("id"); val bytes = byteArrayOf(1, 2, 3)
            queue.enqueue(first, bytes, 1000000); val original = queue.peek()!!.toString()
            assertEquals(1, queue.recordOcrFailure(id)); assertEquals(2, DurableQueue(directory, cipher).recordOcrFailure(id))
            assertEquals(original, queue.peek()!!.toString())
            queue.completeOcr(id, "generated text 👋", "completed", 100000)
            assertEquals(original, queue.peek()!!.toString())
            assertNull(queue.nextOcrUpdate()) // Cannot patch before the original event has an ACK.
            queue.acknowledge(id)
            val restarted = DurableQueue(directory, cipher)
            assertArrayEquals(bytes, restarted.image(id)); assertEquals(1, restarted.depth()); assertNull(restarted.peek())
            restarted.enqueue(second, bytes, 100000)
            assertEquals(second.getString("id"), restarted.peek()!!.getString("id"))
            assertTrue(restarted.peek()!!.keys().asSequence().none { it.startsWith("_") })
            restarted.acknowledge(second.getString("id"))
            assertEquals("generated text 👋", restarted.nextOcrUpdate()!!.getString("ocrText"))
            assertEquals("completed", restarted.capture(id)!!.getJSONObject("ocr").getString("status"))
            restarted.enqueue(first, bytes, 100000) // Original retry remains idempotent after local OCR changes.
            restarted.acknowledgeOcr(id); restarted.acknowledgeOcr(id)
            assertEquals(0, restarted.depth()); assertEquals(0, restarted.bytes())
        } finally { directory.deleteRecursively() }
    }
    @Test fun pendingOcrIsRetainedWithinQuotaAndMissingArchiveIsVisibleWithoutReupload() {
        val directory = Files.createTempDirectory("mote-ocr-quota").toFile()
        try {
            val queue = DurableQueue(directory, cipher); val first = event("2026-09-14T00:00:00Z"); val id = first.getString("id")
            queue.enqueue(first, ByteArray(800), 1000000); queue.acknowledge(id)
            assertFalse(queue.pendingSync().hasWork); assertNotNull(queue.pendingOcr())
            val reserved = queue.bytes(); assertTrue(queue.reservedOcrBytes() >= 600_000)
            assertThrows(QueueFull::class.java) { queue.enqueue(event("2026-09-14T00:01:00Z"), byteArrayOf(2), reserved + 1000) }
            assertThrows(IllegalArgumentException::class.java) { queue.completeOcr(id, "x".repeat(100001), "completed", 1) }
            assertNotNull(queue.pendingOcr()); assertArrayEquals(ByteArray(800), queue.image(id))
            // Worst-case JSON escaping consumes the reservation even after the limit is reduced to one byte.
            DurableQueue(directory, cipher).completeOcr(id, "\u0001".repeat(100000), "completed", 1)
            assertTrue(queue.bytes() <= reserved); assertEquals(0L, queue.reservedOcrBytes()); assertTrue(queue.pendingSync().hasWork)
            queue.archiveMissing(id)
            assertFalse(queue.pendingSync().hasWork); assertNull(queue.peek()); assertNull(queue.nextOcrUpdate()); assertNull(queue.pendingOcr())
            assertEquals("archive_missing", queue.capture(id)!!.getString("syncError"))
            assertEquals("failed", queue.capture(id)!!.getJSONObject("ocr").getString("status"))
            assertArrayEquals(ByteArray(800), queue.image(id))
        } finally { directory.deleteRecursively() }
    }
    @Test fun permanentOcrConflictDoesNotBlockHealthyCapturesOrOtherUpdates() {
        val directory = Files.createTempDirectory("mote-ocr-conflict").toFile()
        try {
            val queue = DurableQueue(directory, cipher)
            val first = event("2026-09-14T00:00:00Z"); val second = event("2026-09-14T00:01:00Z"); val healthy = event("2026-09-14T00:02:00Z", false)
            for (item in listOf(first, second)) { queue.enqueue(item, byteArrayOf(1), 3000000); queue.completeOcr(item.getString("id"), "Generated", "completed", 3000000); queue.acknowledge(item.getString("id")) }
            queue.ocrConflict(first.getString("id")); queue.enqueue(healthy, byteArrayOf(1), 3000000)
            assertEquals(second.getString("id"), queue.nextOcrUpdate()!!.getString("id")); assertEquals(healthy.getString("id"), queue.peek()!!.getString("id"))
            assertEquals("ocr_conflict", queue.capture(first.getString("id"))!!.getString("syncError")); assertNotNull(queue.image(first.getString("id")))
        } finally { directory.deleteRecursively() }
    }
    @Test fun localBrowserPaginatesByActualCaptureTimeAndPreservesDayBoundaries() {
        val directory = Files.createTempDirectory("mote-capture-browser").toFile()
        try {
            val queue = DurableQueue(directory, cipher)
            val after = "2026-09-13T16:00:00Z"; val before = "2026-09-14T16:00:00Z"
            val events = (0..21).map { event("2026-09-14T00:00:${it.toString().padStart(2, '0')}Z", false) }
            events.reversed().forEach { queue.enqueue(it, byteArrayOf(1), 100000) }
            queue.enqueue(event("2026-09-14T16:00:00Z", false), byteArrayOf(1), 100000)
            val first = queue.screenPage(after, before); assertEquals(22, first.getInt("totalCount")); assertEquals(20, first.getJSONArray("items").length())
            assertEquals(events.last().getString("id"), first.getJSONArray("items").getJSONObject(0).getString("id"))
            val second = queue.screenPage(after, before, first.getString("nextCursor")); assertEquals(2, second.getJSONArray("items").length()); assertTrue(second.isNull("nextCursor"))
            assertEquals(events.first().getString("id"), second.getJSONArray("items").getJSONObject(1).getString("id"))
        } finally { directory.deleteRecursively() }
    }
}
