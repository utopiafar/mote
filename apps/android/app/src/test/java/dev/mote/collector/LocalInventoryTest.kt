package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class LocalInventoryTest {
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes
        override fun open(bytes: ByteArray) = bytes
    }
    private fun event(source: String = "screen") = JSONObject().put("id", UUID.randomUUID().toString()).put("source", source)
        .put("capturedAt", "2026-09-15T00:00:00Z").put("privacy", JSONObject().put("excluded", false))
    @Test fun inventoryCountsImagesRecordsAndSharedFilesSeparatelyAndTracksOcr() {
        val dir = Files.createTempDirectory("inventory").toFile()
        try {
            val queue = DurableQueue(dir, cipher)
            val a = event().put("ocr", JSONObject().put("status", "pending")); val b = event()
            queue.enqueue(a, byteArrayOf(1), 10000000); queue.enqueue(b, byteArrayOf(1), 10000000)
            queue.enqueue(event("note"), null, 10000000)
            val duplicate = event().put("ocr", JSONObject().put("status", "disabled")).put("ocrText", "")
                .put("metadata", JSONObject().put("capture", JSONObject().put("deduplication", JSONObject().put("mode", "exact").put("duplicate", true))))
            queue.enqueue(duplicate, null, 10000000)
            val first = queue.inventory()
            assertEquals(4, first.records); assertEquals(2, first.images); assertEquals(1, first.imageFiles)
            assertEquals(4, first.pending); assertEquals(1, first.awaitingOcr)
            queue.acknowledge(a.getString("id"))
            assertEquals(3, queue.inventory().pending); assertEquals(2, queue.inventory().images)
            queue.completeOcr(a.getString("id"), "generated", "completed", 10000000)
            assertEquals(4, queue.inventory().pending); assertEquals(0, queue.inventory().awaitingOcr)
            queue.acknowledgeOcr(a.getString("id"))
            assertEquals(1, queue.inventory().images); assertEquals(1, queue.inventory().imageFiles)
        } finally { dir.deleteRecursively() }
    }
    @Test fun everyCommittedMutationInvalidatesButCapacityRejectionDoesNot() {
        val dir = Files.createTempDirectory("inventory-events").toFile()
        try {
            val signals = mutableListOf<Boolean>(); val queue = DurableQueue(dir, cipher).apply { onMutation = signals::add }
            val row = event()
            assertThrows(QueueFull::class.java) { queue.enqueue(row, byteArrayOf(2), 1) }
            assertTrue(signals.isEmpty())
            queue.enqueue(row, byteArrayOf(2), 1000000)
            assertTrue(signals.contains(true)); signals.clear()
            queue.cacheThumbnail(row.getString("id"), byteArrayOf(3), 1000000)
            assertEquals(listOf(false), signals); signals.clear()
            queue.acknowledge(row.getString("id")); assertEquals(listOf(true), signals)
            assertEquals(0, queue.inventory().images)
        } finally { dir.deleteRecursively() }
    }
    @Test fun missingImageFailsInventoryAndStateCanRepresentStaleCountsWithoutZeroing() {
        val dir = Files.createTempDirectory("inventory-missing").toFile()
        try {
            val queue = DurableQueue(dir, cipher); val row = event(); queue.enqueue(row, byteArrayOf(4), 1000000)
            val before = queue.inventory(); dir.listFiles()!!.single { it.extension == "blob" }.delete()
            assertThrows(IllegalStateException::class.java) { queue.inventory() }
            val state = LocalStateSnapshot(active = before, quarantine = before.copy(records = 0, images = 0), error = "unavailable")
            assertEquals(1, state.totalImages); assertTrue(state.imageLabel().contains("上次结果"))
        } finally { dir.deleteRecursively() }
    }
}
