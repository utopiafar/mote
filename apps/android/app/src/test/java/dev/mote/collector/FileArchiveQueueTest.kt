package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.util.UUID

class FileArchiveQueueTest {
    @Test fun missingTranscriptionNeverBlocksMetadataOrAnotherFileAndRetrySurvivesRestart() {
        val dir = folder.newFolder(); var queue = FileArchiveQueue(dir, cipher); val source = source("snapshot")
        val generation = queue.configure(source).getString("generation")
        for (id in listOf("a", "b", "c")) queue.observe(source, item(id, "snapshot"), generation, 0)
        repeat(3) {
            val pending = queue.prepare(source, { error("Transport must not open snapshot content") }, { true }, 61000)!!
            assertEquals("pending", pending.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getJSONObject("document").getJSONObject("fileIndex").getString("status"))
            queue.acknowledge(source.id, pending, ack(pending))
        }
        assertEquals(0, queue.pendingCount(source.id)); assertEquals(3, queue.processingCount(source.id))
        queue.processOne(source, { ByteArrayInputStream(byteArrayOf(1)) }, { true }, now = 62000, index = { value, _, s -> LocalFileIndex.pending(value, "a".repeat(64), s) })
        queue = FileArchiveQueue(dir, cipher)
        assertEquals(0, queue.pendingCount(source.id)); assertEquals(3, queue.processingCount(source.id))
        assertTrue(queue.processingReady(source.id, 62001)) // The failed file backs off, others remain runnable.
    }
    @Test fun derivedResultIsANewVersionAndLostAckDoesNotInvokeProcessingAgain() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); val s = source("snapshot")
        queue.observe(s, item(layer = "snapshot"), queue.configure(s).getString("generation"), 0)
        val metadata = queue.prepare(s, { error("Must not decode") }, { true }, 61000)!!; queue.acknowledge(s.id, metadata, ack(metadata))
        queue.processOne(s, { ByteArrayInputStream("Generated transcript".toByteArray()) }, { true }, now = 62000, index = { value, bytes, source ->
            LocalFileIndex.pending(value, LocalFileIndex.hash(bytes), source)
            value.put("text", "Generated transcript"); value.getJSONObject("document").getJSONObject("fileIndex").put("status", "ready").put("parser", "fixture").put("coverage", "full").put("length", 20).put("totalCharacters", 20)
        })
        assertEquals(0, queue.processingCount(s.id)); assertEquals(1, queue.pendingCount(s.id))
        val result = queue.prepare(s, { error("Must not decode twice") }, { true }, 63000)!!
        val manifest = result.getJSONObject("pending").getJSONObject("manifest")
        assertEquals(metadata.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"), manifest.getString("previousRevision"))
        assertFalse(manifest.has("sha256")); assertEquals("Generated transcript", manifest.getJSONObject("item").getString("text"))
        val restarted = FileArchiveQueue(dir, cipher); assertEquals(result.toString(), restarted.next(s.id).toString())
        restarted.acknowledge(s.id, result, ack(result)); assertEquals(0, restarted.pendingCount(s.id))
    }
    @Test fun retiredTransportStateIsRejectedWithoutChangingPendingManifest() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); val source = source("snapshot")
        queue.observe(source, item(layer = "snapshot"), queue.configure(source).getString("generation"), 0)
        val pending = queue.prepare(source, { error("Must not decode") }, { true }, 61000)!!
        val stateFile = java.io.File(java.io.File(dir, source.id), "state.enc")
        val state = JSONObject(String(cipher.open(stateFile.readBytes()))).apply { remove("transportQueueVersion") }
        stateFile.writeBytes(cipher.seal(state.toString().toByteArray()))
        val before = stateFile.readBytes()
        assertThrows(Exception::class.java) { FileArchiveQueue(dir, cipher).next(source.id) }
        assertArrayEquals(before, stateFile.readBytes())
        assertEquals(pending.toString(), queue.rows(source.id).single().toString())
    }
    @Test fun sourceChangeDuringLocalProcessingRejectsStalePublication() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val s = source("snapshot"); val g = queue.configure(s).getString("generation")
        queue.observe(s,item(layer="snapshot"),g,0); val pending=queue.prepare(s,{error("No parse")},{true},61000)!!;queue.acknowledge(s.id,pending,ack(pending))
        queue.processOne(s,{ByteArrayInputStream(byteArrayOf(1))},{true},now=62000,index={ _, _, _ -> queue.observe(s,item(layer="snapshot",size=99),g,62000) })
        assertEquals(1,queue.pendingCount(s.id));assertEquals(0,queue.processingCount(s.id));assertFalse(queue.rows(s.id).single().has("indexResult"))
    }
    @Test fun responseReaderHandlesShortReadsAndExactLimit() {
        val expected = ByteArray(1024 * 1024) { (it % 251).toByte() }
        val input = object : ByteArrayInputStream(expected) {
            override fun read(buffer: ByteArray, offset: Int, count: Int): Int = super.read(buffer, offset, minOf(count, 13))
        }
        assertArrayEquals(expected, FileUpload.readResponse(input))
        assertArrayEquals(byteArrayOf(), FileUpload.readResponse(ByteArrayInputStream(byteArrayOf())))
    }
    @Test fun oversizedResponseIsRejectedWithoutConsumingItsTail() {
        val input = ByteArrayInputStream(ByteArray(2 * 1024 * 1024))
        assertThrows(IllegalStateException::class.java) { FileUpload.readResponse(input) }
        assertEquals(1024 * 1024 - 1, input.available())
    }

    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray(); override fun open(bytes: ByteArray) = seal(bytes) }
    private fun source(mode: String = "archive", initial: String = "all") = LocalSource(id = "file-test", name = "Generated", kind = "local-files", retention = mode, uri = "content://fixture/tree/root", tree = true, extensions = "wav,txt", initialSync = initial)
    private fun item(id: String = "a", layer: String = "original", size: Long = 200000) = JSONObject().put("externalId", "content://fixture/$id").put("uri", "content://fixture/$id").put("title", "$id.wav").put("kind", "file").put("layer", layer).put("text", "").put("mimeType", "audio/wav").put("observedAt", "2026-09-15T00:00:00Z").put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", size)))
    private fun ack(pending: JSONObject): JSONObject {
        val m = pending.getJSONObject("pending").getJSONObject("manifest"); val i = m.getJSONObject("item")
        val id = UUID.randomUUID().toString(); val sourceId = m.getString("sourceId"); val externalId = i.getString("externalId"); val revision = i.getString("revision")
        return JSONObject().put("id", id).put("sourceId", sourceId).put("externalId", externalId).put("revision", revision)
            .put("duplicate", false).put("sha256", m.optString("sha256")).put("sizeBytes", m.getLong("sizeBytes"))
            .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received")
                .put("duplicate", false).put("sourceId", sourceId).put("externalId", externalId).put("revision", revision))
    }

    @Test fun changedExclusionsDiscardCandidatesAndRevokeAlreadyPreparedBytes() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val s = source()
        val generation = queue.configure(s).getString("generation")
        queue.observe(s, item().put("_relativePath", "private/a.wav"), generation, 0)
        val pending = queue.prepare(s, { ByteArrayInputStream(byteArrayOf(1, 2)) }, { true }, 61000)!!
        val changed = s.copy(excluded = "private")
        queue.configure(changed)
        assertNull(queue.next(s.id)); assertEquals(0, queue.pendingCount(s.id))
        assertNull(queue.prepare(changed, { error("Excluded content must never open") }, { true }, 62000))
        assertThrows(IllegalStateException::class.java) { queue.assertCurrent(s, pending) }
    }

    @Test fun exclusionsPreserveAllowedNewOnlyBaselines() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); val s = source(initial = "new_only")
        val generation = queue.configure(s).getString("generation")
        queue.observe(s, item("old"), generation, 0); queue.finish(s, generation) { false }
        val changed = s.copy(excluded = "private")
        val next = queue.configure(changed).getString("generation")
        queue.observe(changed, item("old"), next, 0)
        assertEquals(0, queue.pendingCount(s.id))
        assertNull(queue.prepare(changed, { error("Baseline must not upload") }, { true }, 62000))
    }

    @Test fun immutablePartsSurviveRestartAndBadAckDoesNotReleaseThem() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); val s = source(); val state = queue.configure(s)
        val bytes = ByteArray(FileArchiveQueue.PART_BYTES + 19) { (it % 253).toByte() }
        queue.observe(s, item(size = bytes.size.toLong()), state.getString("generation"), 0)
        assertNull(queue.prepare(s, { ByteArrayInputStream(bytes) }, { true }, 50000))
        val pending = queue.prepare(s, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
        val restarted = FileArchiveQueue(dir, cipher); assertEquals(pending.toString(), restarted.next(s.id).toString())
        assertArrayEquals(bytes.copyOfRange(0, FileArchiveQueue.PART_BYTES), restarted.part(s.id, 0))
        assertArrayEquals(bytes.copyOfRange(FileArchiveQueue.PART_BYTES, bytes.size), restarted.part(s.id, 1))
        assertThrows(IllegalStateException::class.java) { restarted.acknowledge(s.id, pending, ack(pending).put("sha256", "wrong")) }
        assertNotNull(restarted.next(s.id)); restarted.acknowledge(s.id, pending, ack(pending)); assertEquals(0, restarted.pendingCount(s.id))
        assertFalse(java.io.File(dir, s.id + "/spool").exists())
    }

    @Test fun rejectedV2FileWriteAndForgottenHeadRetainTheImmutableManifestAndParts() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); val s = source()
        val bytes = ByteArray(FileArchiveQueue.PART_BYTES + 7) { (it % 251).toByte() }
        val generation = queue.configure(s).getString("generation")
        queue.observe(s, item(size = bytes.size.toLong()), generation, 0)
        val pending = queue.prepare(s, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
        for (status in listOf(409, 410, 426)) {
            val rejection = assertThrows(FileIngressRejection::class.java) { FileUpload.requireAccepted(status) }
            assertEquals(status, rejection.httpStatus)
            val restarted = FileArchiveQueue(dir, cipher)
            assertEquals(pending.toString(), restarted.next(s.id).toString())
            assertArrayEquals(bytes.copyOfRange(0, FileArchiveQueue.PART_BYTES), restarted.part(s.id, 0))
        }
        val forgotten = assertThrows(FileIngressRejection::class.java) { FileUpload.requireCurrentHead(JSONObject().put("forgotten", true)) }
        assertEquals(410, forgotten.httpStatus)
        assertNotNull(FileArchiveQueue(dir, cipher).next(s.id))
        FileUpload.requireCurrentHead(JSONObject().put("forgotten", false))
        FileUpload.requireAccepted(200)
    }

    @Test fun newOnlyBaselineSpansPartialScansAndCanLaterBeBackfilled() {
        val dir = folder.newFolder(); var q = FileArchiveQueue(dir, cipher); val s = source(initial = "new_only"); val g = q.configure(s).getString("generation")
        q.observe(s, item("old1"), g, 0); q = FileArchiveQueue(dir, cipher); q.observe(s, item("old2"), g, 0); assertEquals(0, q.pendingCount(s.id))
        q.finish(s, g) { false }; val next = q.state(s.id).getString("generation"); q.observe(s, item("new"), next, 0)
        assertEquals(1, q.pendingCount(s.id)); q.configure(s.copy(initialSync = "all")); assertEquals(3, q.pendingCount(s.id))
    }

    @Test fun referenceNeverOpensOrHashesEvenHugeFiles() {
        val q = FileArchiveQueue(folder.newFolder(), cipher); val s = source("reference"); val g = q.configure(s).getString("generation")
        q.observe(s, item(layer = "reference", size = 1000000000000), g)
        val pending = q.prepare(s, { error("must not open") }, { error("must not read") })!!
        assertFalse(pending.getJSONObject("pending").getJSONObject("manifest").has("sha256")); q.acknowledge(s.id, pending, ack(pending))
    }

    @Test fun changingFileDuringStagingIsRetriedWithoutAnImmutableManifest() {
        val q = FileArchiveQueue(folder.newFolder(), cipher); val s = source(); val g = q.configure(s).getString("generation"); q.observe(s, item(size = 2), g, 0)
        var checks = 0
        assertThrows(IllegalStateException::class.java) { q.prepare(s, { ByteArrayInputStream(byteArrayOf(1, 2)) }, { ++checks == 1 }, 61000) }
        assertNull(q.next(s.id)); assertEquals(1, q.pendingCount(s.id))
    }

    @Test fun localRemovalCreatesARevisionOnlyWhenAbsenceWasConfirmed() {
        val q = FileArchiveQueue(folder.newFolder(), cipher); val s = source("reference"); val g = q.configure(s).getString("generation"); q.observe(s, item(layer = "reference"), g)
        val original = q.prepare(s, { error("no read") }, { true })!!; q.acknowledge(s.id, original, ack(original)); q.finish(s, g) { false }
        val next = q.state(s.id).getString("generation"); q.finish(s, next) { false }; assertEquals(0, q.pendingCount(s.id))
        q.finish(s, q.state(s.id).getString("generation")) { true }; val deletion = q.prepare(s, { error("no read") }, { true })!!
        assertTrue(deletion.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getBoolean("deleted"))
        assertEquals(original.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"), deletion.getJSONObject("pending").getJSONObject("manifest").getString("previousRevision"))
    }

    @Test fun acknowledgingAnOlderPendingCopyPreservesALaterObservationAndItsRevisionAnchor() {
        val q = FileArchiveQueue(folder.newFolder(), cipher); val s = source("reference"); val g = q.configure(s).getString("generation")
        q.observe(s, item(layer = "reference"), g)
        val pending = q.prepare(s, { error("no read") }, { true }, anchor = { "legacy-reference" })!!
        assertEquals("legacy-reference", pending.getJSONObject("pending").getJSONObject("manifest").getString("previousRevision"))
        q.observe(s, item(layer = "reference", size = 1234), g)
        q.acknowledge(s.id, pending, ack(pending)); assertEquals(1, q.pendingCount(s.id))
        val next = q.prepare(s, { error("no read") }, { true })!!
        assertEquals(1234, next.getJSONObject("pending").getJSONObject("manifest").getLong("sizeBytes"))
        assertEquals(ack(pending).getString("revision"), next.getJSONObject("pending").getJSONObject("manifest").getString("previousRevision"))
    }
}
