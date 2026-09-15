package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

class QueueStatsTest {
    private class CountingCipher : ByteCipher {
        var opens = 0
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        override fun open(bytes: ByteArray): ByteArray { opens++; return seal(bytes) }
    }
    private fun screen(pending: Boolean = false) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("source", "screen").put("capturedAt", "2026-09-14T00:00:00Z")
        .put("privacy", JSONObject().put("excluded", false)).put("imageMime", "image/jpeg").put("ocrText", "generated fixture")
        .apply { if (pending) put("ocr", JSONObject().put("status", "pending")) }

    private fun fixture(test: (File, CountingCipher) -> Unit) {
        val directory = Files.createTempDirectory("mote-queue-stats").toFile()
        try { test(directory, CountingCipher()) } finally { directory.deleteRecursively() }
    }

    @Test fun browsingOtherPagesDecryptsOnlyTheirDisplayRecordsAfterIndexWarmup() = fixture { directory, cipher ->
        val queue = DurableQueue(directory, cipher)
        repeat(65) { queue.enqueue(screen(), byteArrayOf(1), 2_000_000) }
        queue.stats()
        val before = cipher.opens
        val first = queue.capturePage("2026-09-14T00:00:00Z", "2026-09-15T00:00:00Z")
        assertEquals(65, first.getInt("totalCount")); assertEquals(before + 20, cipher.opens)
        val second = DurableQueue(directory, cipher).capturePage("2026-09-14T00:00:00Z", "2026-09-15T00:00:00Z", first.getString("nextCursor"))
        assertEquals(20, second.getJSONArray("items").length()); assertEquals(before + 40, cipher.opens)
    }

    @Test fun legacyScreenshotBacklogIsDecryptedOnceAcrossQueueHandlesAndStatisticsCalls() = fixture { directory, cipher ->
        // Write the 0.0.1 format directly: no deferred OCR or upload flags, no location pointer.
        // All data is generated; the shared blob must never be opened for numeric statistics.
        val image = byteArrayOf(1, 2, 3, 4)
        val hash = MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it) }
        File(directory, "$hash.blob").writeBytes(cipher.seal(image))
        repeat(250) { index ->
            val event = screen().put("_blob", hash)
            File(directory, "${event.getString("id")}.event").apply {
                writeBytes(cipher.seal(event.toString().toByteArray()))
                assertTrue(setLastModified(1_700_000_000_000L + index * 1000L))
            }
        }
        val queue = DurableQueue(directory, cipher)
        assertEquals(250, queue.depth()); assertTrue(queue.diskBytes() > 0)
        assertEquals(0, cipher.opens) // These inexpensive APIs stay free of decryption.
        val first = queue.stats()
        assertEquals(250, cipher.opens); assertEquals(250, first.depth)
        assertEquals(250, first.pendingSync.count); assertEquals(1_700_000_000_000L, first.pendingSync.oldestAt)
        assertEquals(0L, first.reservedOcrBytes); assertEquals(queue.diskBytes(), first.bytes)
        repeat(3) {
            val reopened = DurableQueue(directory, cipher)
            assertEquals(first, reopened.stats()); assertEquals(first.pendingSync, reopened.pendingSync())
            assertEquals(first.bytes, reopened.bytes()); assertEquals(0L, reopened.reservedOcrBytes())
        }
        assertEquals(250, cipher.opens)
        queue.verifyIntegrity()
        assertEquals(501, cipher.opens) // Cached statistics never replace full event/blob verification.
    }

    @Test fun sharedStatisticsFollowEnqueueDeferredOcrAcknowledgementsAndConflictChanges() = fixture { directory, cipher ->
        val queue = DurableQueue(directory, cipher)
        val first = screen(true); val second = screen(); val id = first.getString("id")
        queue.enqueue(first, byteArrayOf(1), 2_000_000)
        queue.enqueue(second, byteArrayOf(2), 2_000_000)
        val initial = queue.stats(); assertEquals(2, initial.pendingSync.count); assertTrue(initial.reservedOcrBytes >= 600_000)
        val reopened = DurableQueue(directory, cipher)
        reopened.acknowledge(id)
        var before = cipher.opens
        val waiting = queue.stats()
        assertEquals(before + 1, cipher.opens); assertEquals(1, waiting.pendingSync.count)
        assertEquals(initial.reservedOcrBytes, waiting.reservedOcrBytes)
        reopened.completeOcr(id, "generated completed OCR", "completed", 2_000_000)
        before = cipher.opens
        val completed = queue.stats()
        assertEquals(before + 1, cipher.opens); assertEquals(2, completed.pendingSync.count); assertEquals(0L, completed.reservedOcrBytes)
        reopened.ocrConflict(id)
        before = cipher.opens
        assertEquals(1, queue.stats().pendingSync.count); assertEquals(before + 1, cipher.opens)
        reopened.acknowledgeOcr(id)
        val remaining = queue.stats()
        assertEquals(1, remaining.depth); assertEquals(1, remaining.pendingSync.count)
        assertNull(queue.image(id)); assertNotNull(queue.image(second.getString("id")))
        reopened.acknowledge(second.getString("id"))
        assertEquals(QueueStats(0, 0, 0, PendingSync(0, null)), queue.stats())
    }

    @Test fun migrationUsesIndependentStatisticsAndNewWritesInvalidateTheTargetCache() = fixture { root, cipher ->
        val control = File(root, "control").apply { mkdirs() }
        val legacy = File(root, "queue").apply { mkdirs() }
        val card = File(root, "card").apply { mkdirs() }
        val store = QueueLocationStore(control, legacy, cipher)
        val source = store.current()
        val queue = DurableQueue(legacy, cipher).apply { assertCurrent = { store.assertCurrent(source) } }
        val item = screen(true); val id = item.getString("id")
        queue.enqueue(item, byteArrayOf(9), 2_000_000)
        val initial = queue.stats()
        val target = store.migrate("card", card)
        val moved = DurableQueue(File(target.path), cipher)
        val before = cipher.opens
        val migrated = moved.stats()
        assertEquals(initial.depth, migrated.depth); assertEquals(initial.bytes, migrated.bytes)
        assertEquals(initial.reservedOcrBytes, migrated.reservedOcrBytes); assertEquals(initial.pendingSync.count, migrated.pendingSync.count)
        assertEquals(before + 1, cipher.opens)
        assertThrows(IllegalStateException::class.java) { queue.stats() }
        moved.archiveMissing(id)
        val unavailable = DurableQueue(File(target.path), cipher).stats()
        assertEquals(1, unavailable.depth); assertEquals(0, unavailable.pendingSync.count); assertEquals(0L, unavailable.reservedOcrBytes)
        assertArrayEquals(byteArrayOf(9), moved.image(id))
    }

    @Test fun unreadableRecordIsNeverCountedAsAnEmptyQueueOrDiscarded() = fixture { directory, cipher ->
        val queue = DurableQueue(directory, cipher)
        val item = screen(); queue.enqueue(item, byteArrayOf(1), 2_000_000)
        queue.stats()
        val file = File(directory, "${item.getString("id")}.event")
        file.writeBytes(cipher.seal("corrupted fixture".toByteArray()))
        assertThrows(Exception::class.java) { queue.stats() }
        assertThrows(Exception::class.java) { DurableQueue(directory, cipher).bytes() }
        assertThrows(Exception::class.java) { queue.verifyIntegrity() }
        assertEquals(1, queue.depth()); assertTrue(file.isFile)
        assertEquals(1, directory.listFiles()!!.count { it.extension == "blob" })
    }

    @Test fun sameSizeAndTimestampReplacementInvalidatesStatisticsAndIntegrityStillReadsFiles() = fixture { directory, cipher ->
        val queue = DurableQueue(directory, cipher)
        val item = screen(true); val id = item.getString("id")
        queue.enqueue(item, byteArrayOf(1), 2_000_000)
        queue.recordOcrFailure(id); queue.stats()
        val file = File(directory, "$id.event")
        val length = file.length(); val timestamp = file.lastModified()
        DurableQueue(directory, cipher).recordOcrFailure(id)
        assertEquals(length, file.length()); assertTrue(file.setLastModified(timestamp))
        val before = cipher.opens
        queue.stats(); assertEquals(before + 1, cipher.opens)

        // Metadata fingerprints are an optimization, not an integrity decision. Even a replacement
        // whose metadata is identical is fully decrypted and verified by the integrity path.
        file.writeBytes(ByteArray(length.toInt()))
        assertTrue(file.setLastModified(timestamp))
        assertThrows(Exception::class.java) { queue.verifyIntegrity() }
        assertTrue(file.isFile)
    }
}
