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
            queue.enqueue(event, null); queue.acknowledge(event.getString("id"), retentionDays = 7)
            assertEquals(1, queue.depth()); assertEquals(0, queue.pendingSync().count)
            assertFalse("ACK-retained original must not block changing nodes", queue.hasPendingConnectionWork())
        } finally { dir.deleteRecursively() }
    }




    @Test fun pendingConflictsAndReviewHeldWorkBlockConnectionChanges() {
        val dir = Files.createTempDirectory("mote-origin-work").toFile()
        try {
            val queue = DurableQueue(dir, cipher); val event = note(); val id = event.getString("id")
            queue.enqueue(event, null)
            assertTrue(queue.hasPendingConnectionWork())
            assertThrows(IllegalStateException::class.java) { queue.pinRetainedOrigin("https://a.invalid") }
            queue.acknowledge(id, retentionDays = 7); assertFalse(queue.hasPendingConnectionWork())
            queue.uploadConflict(id); assertTrue(queue.hasPendingConnectionWork())
            assertThrows(IllegalStateException::class.java) { queue.pinRetainedOrigin("https://a.invalid") }
        } finally { dir.deleteRecursively() }
        val held = Files.createTempDirectory("mote-origin-held").toFile()
        try {
            val queue = DurableQueue(held, cipher)
            queue.enqueue(note(), null, reviewHeld = true)
            assertEquals(0, queue.pendingSync().count); assertTrue(queue.hasPendingConnectionWork())
        } finally { held.deleteRecursively() }
    }
    @Test fun retainedRecordsReplayOnlyAtTheirOriginalNodeAcrossRestarts() {
        val dir = Files.createTempDirectory("mote-origin-replay").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val queue = DurableQueue(dir, cipher).apply { archiveOrigin = a }; val event = note(); val id = event.getString("id")
            queue.enqueue(event, null); queue.acknowledge(id, retentionDays = 7); queue.pinRetainedOrigin(a)
            val pinned = queue.archiveRecord(id)!!.first.toString()
            queue.enqueue(event, null); assertEquals(pinned, queue.archiveRecord(id)!!.first.toString())
            val next = DurableQueue(dir, cipher).apply { archiveOrigin = b }
            assertFalse(next.hasPendingConnectionWork()); assertEquals(0, next.requeueRetained()); assertTrue(next.syncIds().isEmpty()); assertNull(next.peek())
            val fresh = note(); next.enqueue(fresh, null); next.acknowledge(fresh.getString("id"), retentionDays = 7); next.pinRetainedOrigin(b)
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
            queue.enqueue(event, null); queue.acknowledge(id, retentionDays = 7); queue.pinRetainedOrigin(a)
            val next = DurableQueue(dir, cipher).apply { archiveOrigin = b }
            val file = java.io.File(dir, "$id.event"); val changed = JSONObject(file.readText()).put("_uploaded", false)
            file.writeText(changed.toString()); file.setLastModified(System.currentTimeMillis() + 2000)
            assertNull(next.peek()); assertEquals(0, next.requeueRetained()); next.uploadConflict(id)
            assertFalse(next.retryConflict(id)); assertTrue(next.hasPendingConnectionWork())
            changed.put("_uploaded", true).remove("_uploadConflict"); file.writeText(changed.toString()); file.setLastModified(System.currentTimeMillis() + 4000)
            assertTrue(next.syncIds().isEmpty())
        } finally { dir.deleteRecursively() }
    }

    @Test fun mixedOriginBackupCannotStripBindingAndReplayOldRecords() {
        val dir = Files.createTempDirectory("mote-origin-backup").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher).apply { archiveOrigin = a }
            val event = note(); queue.enqueue(event, null); queue.acknowledge(event.getString("id"), retentionDays = 7)
            queue.pinRetainedOrigin(a)
            val output = java.io.ByteArrayOutputStream(); QueueArchive.export(queue, b, output)
            val prepared = QueueArchive.prepare(output.toByteArray().inputStream(), java.io.File(dir, "prepared"))
            val target = DurableQueue(java.io.File(dir, "target"), cipher).apply { archiveOrigin = b }
            assertThrows(IllegalArgumentException::class.java) { QueueArchive.restore(prepared, target, b) }
            assertEquals(0, target.depth())
            // A fresh backup made after returning to the owning node can be restored normally.
            val original = java.io.ByteArrayOutputStream(); QueueArchive.export(queue, a, original)
            val same = QueueArchive.prepare(original.toByteArray().inputStream(), java.io.File(dir, "same"))
            target.archiveOrigin = a
            assertEquals(1, QueueArchive.restore(same, target, a))
            assertNull(target.peek()); assertTrue(target.capture(event.getString("id"))!!.getBoolean("uploaded")); assertEquals(a, target.archiveRecord(event.getString("id"))!!.first.getJSONObject("_archiveAcknowledgment").getString("origin"))
        } finally { dir.deleteRecursively() }
    }
    @Test fun quarantineRestorePreservesOriginAndRejectsForeignDestination() {
        val dir = Files.createTempDirectory("mote-origin-quarantine").toFile()
        try {
            val queue = DurableQueue(java.io.File(dir, "queue"), cipher).apply { archiveOrigin = "https://a.invalid" }
            val pending = DurableQueue(java.io.File(dir, "quarantine"), cipher, role = DurableQueue.Role.QUARANTINE)
            val event = note().put("source", "screen").put("imageMime", "image/jpeg"); val id = event.getString("id")
            queue.enqueue(event, byteArrayOf(1, 2, 3))
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

    @Test fun foreignOrMalformedArchiveAckIsRejectedBeforeAnyRecordIsRestored() {
        val dir = Files.createTempDirectory("mote-ack-origin-preflight").toFile()
        try {
            val a = "https://a.invalid"; val b = "https://b.invalid"
            val source = DurableQueue(java.io.File(dir, "source"), cipher).apply { archiveOrigin = a }
            val event = note(); source.enqueue(event, null); source.acknowledge(event.getString("id"))
            val archived = source.archiveRecord(event.getString("id"))!!.first.apply { remove("_archiveOrigin") }
            fun archive(record: JSONObject): ByteArray = java.io.ByteArrayOutputStream().also { output ->
                java.util.zip.ZipOutputStream(output).use { zip ->
                    fun entry(name: String, value: JSONObject) { zip.putNextEntry(java.util.zip.ZipEntry(name)); zip.write(value.toString().toByteArray()); zip.closeEntry() }
                    entry("archive.json", JSONObject().put("format", "mote-android-records").put("version", LocalDataFormat.VERSION).put("origin", b))
                    entry("records/${event.getString("id")}.json", record)
                }
            }.toByteArray()
            val staged = QueueArchive.prepare(archive(archived).inputStream(), java.io.File(dir, "staged"))
            val target = DurableQueue(java.io.File(dir, "target"), cipher).apply { archiveOrigin = b }
            val earlier = note(); target.enqueue(earlier, null)
            assertThrows(IllegalArgumentException::class.java) { QueueArchive.restore(staged, target, b) }
            assertNull(target.capture(event.getString("id"))); assertEquals(1, target.depth()); assertEquals(earlier.getString("id"), target.peek()!!.getString("id"))
            val malformed = JSONObject(archived.toString()).put("_archiveAcknowledgment", "invalid")
            assertThrows(IllegalArgumentException::class.java) { QueueArchive.prepare(archive(malformed).inputStream(), java.io.File(dir, "malformed")) }
            assertEquals(1, target.depth())
        } finally { dir.deleteRecursively() }
    }

    @Test fun backupRestoreKeepsConflictHoldAndNeverAutomaticallyResendsAnAcknowledgedOriginal() {
        val dir = Files.createTempDirectory("mote-ack-hold-restore").toFile()
        try {
            val origin = "https://generated.invalid"
            val source = DurableQueue(java.io.File(dir, "source"), cipher).apply { archiveOrigin = origin }
            val event = note(); source.enqueue(event, byteArrayOf(1, 2, 3)); source.acknowledge(event.getString("id")); source.uploadConflict(event.getString("id"))
            val output = java.io.ByteArrayOutputStream(); QueueArchive.export(source, origin, output)
            val staged = QueueArchive.prepare(output.toByteArray().inputStream(), java.io.File(dir, "staged"))
            val target = DurableQueue(java.io.File(dir, "target"), cipher).apply { archiveOrigin = origin }
            assertEquals(1, QueueArchive.restore(staged, target, origin)); assertNull(target.peek()); assertTrue(target.hasPendingConnectionWork())
            assertEquals("upload_conflict", target.capture(event.getString("id"))!!.getString("syncError")); assertArrayEquals(byteArrayOf(1, 2, 3), target.image(event.getString("id")))
        } finally { dir.deleteRecursively() }
    }

    @Test fun pendingFailureKeepsCategoryAndUsesExistingUserExplanation() {
        val failure = ConnectionFailure("pending")
        assertEquals("pending", failure.category); assertNotEquals("pending", failure.message)
    }

}
