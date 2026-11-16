package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class LocalInventoryTest {
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes
        override fun open(bytes: ByteArray) = bytes
    }
    private fun event(source: String = "screen") = JSONObject().put("id", UUID.randomUUID().toString()).put("source", source)
        .put("capturedAt", "2026-09-15T00:00:00Z").put("privacy", JSONObject().put("excluded", false))

    @Test fun unreadableSourceDoesNotReplaceFreshLocalAndQuarantineInventories() {
        val dir = Files.createTempDirectory("inventory-source-failure").toFile()
        try {
            val queue = DurableQueue(dir, cipher); queue.enqueue(event("note"), null)
            val current = queue.inventory(); val quarantine = current.copy(records = 0, pending = 0)
            val result = LocalStateSnapshot(active = current, quarantine = quarantine).withSources { error("generated unreadable source") }
            assertEquals(current, result.active); assertEquals(quarantine, result.quarantine)
            assertNull(result.error); assertTrue(result.sourceError); assertNull(result.sourcePending); assertNull(result.sourceIssues)
        } finally { dir.deleteRecursively() }
    }

    @Test fun everyCommittedMutationInvalidatesButFailedStorageDoesNotAndAckKeepsImage() {
        val dir = Files.createTempDirectory("inventory-events").toFile()
        try {
            val signals = mutableListOf<Boolean>(); val queue = DurableQueue(dir, cipher).apply { onMutation = signals::add }
            val row = event()
            val blocked = File(dir, ".capture-stages.inbox").apply { check(mkdir()) }
            assertThrows(java.io.IOException::class.java) { queue.enqueue(row, byteArrayOf(2)) }
            assertTrue(signals.isEmpty())
            check(blocked.delete())
            queue.enqueue(row, byteArrayOf(2))
            assertTrue(signals.contains(true)); signals.clear()
            queue.cacheThumbnail(row.getString("id"), byteArrayOf(3))
            assertEquals(listOf(false), signals); signals.clear()
            queue.acknowledge(row.getString("id")); assertEquals(listOf(true), signals)
            assertEquals(1, queue.inventory().images); assertNull(queue.peek())
        } finally { dir.deleteRecursively() }
    }
    @Test fun missingImageFailsInventoryAndStateCanRepresentStaleCountsWithoutZeroing() {
        val dir = Files.createTempDirectory("inventory-missing").toFile()
        try {
            val queue = DurableQueue(dir, cipher); val row = event(); queue.enqueue(row, byteArrayOf(4))
            val before = queue.inventory(); dir.listFiles()!!.single { it.extension == "blob" }.delete()
            assertThrows(IllegalStateException::class.java) { queue.inventory() }
            val state = LocalStateSnapshot(active = before, quarantine = before.copy(records = 0, images = 0), error = "unavailable")
            assertEquals(1, state.totalImages); assertTrue(state.imageLabel().contains("上次结果"))
        } finally { dir.deleteRecursively() }
    }

    @Test fun inventoryCountsImagesRecordsAndSharedFilesSeparatelyAcrossAcknowledgements() {
        val dir = Files.createTempDirectory("inventory").toFile()
        try {
            val queue = DurableQueue(dir, cipher)
            val a = event().put("ocr", JSONObject().put("status", "disabled")); val b = event()
            queue.enqueue(a, byteArrayOf(1)); queue.enqueue(b, byteArrayOf(1))
            queue.enqueue(event("note"), null)
            val duplicate = event().put("ocr", JSONObject().put("status", "disabled")).put("ocrText", "")
                .put("metadata", JSONObject().put("capture", JSONObject().put("deduplication", JSONObject().put("mode", "exact").put("duplicate", true))))
            queue.enqueue(duplicate, null)
            val first = queue.inventory()
            assertEquals(4, first.records); assertEquals(2, first.images); assertEquals(1, first.imageFiles)
            assertEquals(4, first.pending); assertEquals(0, first.awaitingOcr)
            queue.acknowledge(a.getString("id"), retentionDays = 7)
            assertEquals(3, queue.inventory().pending); assertEquals(2, queue.inventory().images)
            assertEquals(0, queue.inventory().awaitingOcr)
            queue.pruneUploaded(Long.MAX_VALUE)
            assertEquals(2, queue.inventory().images); assertEquals(1, queue.inventory().imageFiles)
            assertTrue(queue.capture(a.getString("id"))!!.getBoolean("uploaded")); assertArrayEquals(byteArrayOf(1), queue.image(a.getString("id")))
        } finally { dir.deleteRecursively() }
    }
}
