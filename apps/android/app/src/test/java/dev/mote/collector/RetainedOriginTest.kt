package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class RetainedOriginTest {
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun note() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "note").put("capturedAt", "2026-09-27T00:00:00Z").put("ocrText", "Generated retained note").put("privacy", JSONObject().put("excluded", false))
    @Test fun acknowledgedRetainedNoteIsNotPendingConnectionWork() {
        val dir = Files.createTempDirectory("mote-retained-origin").toFile()
        try {
            val queue = DurableQueue(dir, cipher); val event = note()
            queue.enqueue(event, null, 3_000_000); queue.acknowledge(event.getString("id"), retentionDays = 7)
            assertEquals(1, queue.depth()); assertEquals(0, queue.pendingSync().count)
            assertFalse("ACK-retained original must not block changing nodes", queue.hasPendingConnectionWork())
        } finally { dir.deleteRecursively() }
    }




    @Test fun pendingConflictsAndReviewHeldWorkBlockConnectionChanges() {
        val dir = Files.createTempDirectory("mote-origin-work").toFile()
        try {
            val queue = DurableQueue(dir, cipher); val event = note(); val id = event.getString("id")
            queue.enqueue(event, null, 3_000_000)
            assertTrue(queue.hasPendingConnectionWork())
            assertThrows(IllegalStateException::class.java) { queue.pinRetainedOrigin("https://a.invalid") }
            queue.acknowledge(id, retentionDays = 7); assertFalse(queue.hasPendingConnectionWork())
            queue.uploadConflict(id); assertTrue(queue.hasPendingConnectionWork())
            assertThrows(IllegalStateException::class.java) { queue.pinRetainedOrigin("https://a.invalid") }
        } finally { dir.deleteRecursively() }
        val held = Files.createTempDirectory("mote-origin-held").toFile()
        try {
            val queue = DurableQueue(held, cipher)
            queue.enqueue(note(), null, 3_000_000, reviewHeld = true)
            assertEquals(0, queue.pendingSync().count); assertTrue(queue.hasPendingConnectionWork())
        } finally { held.deleteRecursively() }
    }
    @Test fun retainedRecordsReplayOnlyAtTheirOriginalNodeAcrossRestarts() {
        val dir = Files.createTempDirectory("mote-origin-replay").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val queue = DurableQueue(dir, cipher).apply { archiveOrigin = a }; val event = note(); val id = event.getString("id")
            queue.enqueue(event, null, 3_000_000); queue.acknowledge(id, retentionDays = 7); queue.pinRetainedOrigin(a)
            val pinned = queue.archiveRecord(id)!!.first.toString()
            queue.enqueue(event, null, 3_000_000); assertEquals(pinned, queue.archiveRecord(id)!!.first.toString())
            val next = DurableQueue(dir, cipher).apply { archiveOrigin = b }
            assertFalse(next.hasPendingConnectionWork()); assertEquals(0, next.requeueRetained()); assertTrue(next.syncIds().isEmpty()); assertNull(next.peek())
            val fresh = note(); next.enqueue(fresh, null, 3_000_000); next.acknowledge(fresh.getString("id"), retentionDays = 7); next.pinRetainedOrigin(b)
            assertEquals(pinned, next.archiveRecord(id)!!.first.toString())
            val returned = DurableQueue(dir, cipher).apply { archiveOrigin = a }
            assertEquals(listOf(id), returned.syncIds()); assertEquals(1, returned.requeueRetained())
            assertEquals(id, returned.peek()!!.getString("id")); assertFalse(returned.peek()!!.has("_archiveOrigin")); assertTrue(returned.hasPendingConnectionWork())
            returned.acknowledge(id, retentionDays = 7); assertFalse(returned.hasPendingConnectionWork())
        } finally { dir.deleteRecursively() }
    }
    @Test fun publicUploadBoundaryRejectsForeignPendingRecords() {
        val dir = Files.createTempDirectory("mote-origin-boundary").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val queue = DurableQueue(dir, cipher).apply { archiveOrigin = a }; val event = note(); val id = event.getString("id")
            queue.enqueue(event, null, 3_000_000); queue.acknowledge(id, retentionDays = 7); queue.pinRetainedOrigin(a)
            val next = DurableQueue(dir, cipher).apply { archiveOrigin = b }
            val file = java.io.File(dir, "$id.event"); val changed = JSONObject(file.readText()).put("_uploaded", false)
            file.writeText(changed.toString()); file.setLastModified(System.currentTimeMillis() + 2000)
            assertNull(next.peek()); assertEquals(0, next.requeueRetained()); next.uploadConflict(id)
            assertFalse(next.retryConflict(id, 3_000_000)); assertTrue(next.hasPendingConnectionWork())
            changed.put("_uploaded", true).remove("_uploadConflict"); file.writeText(changed.toString()); file.setLastModified(System.currentTimeMillis() + 4000)
            assertTrue(next.syncIds().isEmpty())
        } finally { dir.deleteRecursively() }
    }

    @Test fun mixedOriginBackupCannotStripBindingAndReplayOldRecords() {
        val dir = Files.createTempDirectory("mote-origin-backup").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher).apply { archiveOrigin = a }
            val event = note(); queue.enqueue(event, null, 3_000_000); queue.acknowledge(event.getString("id"), retentionDays = 7)
            queue.pinRetainedOrigin(a)
            val output = java.io.ByteArrayOutputStream(); QueueArchive.export(queue, b, output)
            val prepared = QueueArchive.prepare(output.toByteArray().inputStream(), java.io.File(dir, "prepared"), 3_000_000)
            val target = DurableQueue(java.io.File(dir, "target"), cipher).apply { archiveOrigin = b }
            assertThrows(IllegalArgumentException::class.java) { QueueArchive.restore(prepared, target, b, 3_000_000) }
            assertEquals(0, target.depth())
            // A fresh backup made after returning to the owning node can be restored normally.
            val original = java.io.ByteArrayOutputStream(); QueueArchive.export(queue, a, original)
            val same = QueueArchive.prepare(original.toByteArray().inputStream(), java.io.File(dir, "same"), 3_000_000)
            target.archiveOrigin = a
            assertEquals(1, QueueArchive.restore(same, target, a, 3_000_000))
            assertFalse(target.peek()!!.has("_archiveOrigin"))
        } finally { dir.deleteRecursively() }
    }
    @Test fun quarantineRestorePreservesOriginAndRejectsForeignDestination() {
        val dir = Files.createTempDirectory("mote-origin-quarantine").toFile()
        try {
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher).apply { archiveOrigin = "https://a.invalid" }
            val pending = DurableQueue(java.io.File(dir, "quarantine"), cipher, role = DurableQueue.Role.QUARANTINE)
            val event = note().put("source", "screen").put("imageMime", "image/jpeg"); val id = event.getString("id")
            queue.enqueue(event, byteArrayOf(1, 2, 3), 3_000_000)
            val hash = queue.archiveRecord(id)!!.first.getString("_blob")
            assertTrue(queue.resolveDedupe(id, hash, null, null, pending))
            assertFalse(pending.hasUnboundRecords())
            queue.archiveOrigin = ""
            assertFalse("Disconnected active queue must not receive a foreign record", pending.resolveDedupe(id, hash, null, null, queue))
            assertEquals(1, pending.depth()); assertFalse(queue.hasPendingConnectionWork())
            queue.archiveOrigin = "https://b.invalid"
            assertFalse(pending.resolveDedupe(id, hash, null, null, queue))
            assertEquals(1, pending.depth()); assertNull(queue.peek())
            queue.archiveOrigin = "https://a.invalid"
            assertTrue(pending.resolveDedupe(id, hash, null, null, queue))
            assertEquals(id, queue.peek()!!.getString("id")); assertFalse(queue.peek()!!.has("_archiveOrigin"))
        } finally { dir.deleteRecursively() }
    }

    @Test fun pendingFailureKeepsCategoryAndUsesExistingUserExplanation() {
        val failure = ConnectionFailure("pending")
        assertEquals("pending", failure.category); assertNotEquals("pending", failure.message)
    }

}
