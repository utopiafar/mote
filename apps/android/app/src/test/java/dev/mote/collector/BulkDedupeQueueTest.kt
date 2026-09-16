package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class BulkDedupeQueueTest {
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    @Test fun movesRestoreAndSharedBlobDeletionPreserveReferenceAndOcrState() {
        val dir = Files.createTempDirectory("bulk-queue").toFile()
        try {
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher)
            val pending = DurableQueue(java.io.File(dir, "pending"), cipher)
            fun add(): String {
                val id = UUID.randomUUID().toString()
                queue.enqueue(JSONObject().put("id", id).put("source", "screen").put("capturedAt", "2026-01-01T00:00:00Z")
                    .put("privacy", JSONObject().put("excluded", false)).put("ocr", JSONObject().put("status", "pending")), byteArrayOf(1, 2, 3), 10000000)
                return id
            }
            val reference = add(); val candidate = add()
            queue.completeOcr(candidate, "generated OCR", "completed", 10000000)
            queue.acknowledge(candidate)
            val hash = queue.dedupeRow(candidate)!!.getString("blob")
            assertFalse(queue.resolveDedupe(candidate, "bad", reference, hash, pending))
            assertFalse(queue.resolveDedupe(candidate, hash, UUID.randomUUID().toString(), hash, pending))
            assertTrue(queue.resolveDedupe(candidate, hash, reference, hash, pending))
            assertNull(queue.capture(candidate)); assertArrayEquals(byteArrayOf(1, 2, 3), queue.image(reference))
            assertEquals("generated OCR", pending.capture(candidate)!!.getString("ocrText"))
            assertTrue(pending.capture(candidate)!!.getBoolean("uploaded"))
            assertTrue(pending.resolveDedupe(candidate, hash, null, null, queue))
            assertEquals("generated OCR", queue.capture(candidate)!!.getString("ocrText"))
            assertTrue(queue.resolveDedupe(candidate, hash, reference, hash, null))
            assertArrayEquals(byteArrayOf(1, 2, 3), queue.image(reference))
            assertFalse(queue.resolveDedupe(candidate, hash, reference, hash, null))
        } finally { dir.deleteRecursively() }
    }
    @Test fun insufficientSpaceOrBrokenInterruptedDestinationNeverRemovesSource() {
        val dir = Files.createTempDirectory("bulk-failure").toFile()
        try {
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher)
            val targetDir = java.io.File(dir, "pending")
            val pending = DurableQueue(targetDir, cipher)
            val id = UUID.randomUUID().toString()
            val event = JSONObject().put("id", id).put("source", "screen").put("capturedAt", "2026-01-01T00:00:00Z")
                .put("privacy", JSONObject().put("excluded", false))
            queue.enqueue(event, byteArrayOf(4, 5), 10000000)
            val hash = queue.dedupeRow(id)!!.getString("blob")
            try { queue.resolveDedupe(id, hash, null, null, pending, 1); fail("capacity must reject") } catch (_: QueueFull) { }
            assertNotNull(queue.image(id)); assertEquals(0, pending.depth())
            pending.enqueue(event, byteArrayOf(4, 5), 10000000)
            assertTrue(java.io.File(targetDir, "$hash.blob").delete())
            try { queue.resolveDedupe(id, hash, null, null, pending); fail("missing destination image must reject") } catch (_: java.io.IOException) { }
            assertArrayEquals(byteArrayOf(4, 5), queue.image(id))
        } finally { dir.deleteRecursively() }
    }

}
