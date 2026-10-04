package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File

/** Generated transport receipts and bytes only; no device access, ASR or model calls. */
class FileSnapshotRecoveryTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 53).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private val source = LocalSource(id = "generated-recovery", name = "Generated recovery", kind = "local-files",
        retention = "snapshot", uri = "content://generated/tree/authorized", tree = true, extensions = "wav")
    private val bytes = "Generated recovery audio bytes".toByteArray()
    private fun item(id: String = "recording") = JSONObject().put("externalId", "content://generated/$id")
        .put("uri", "content://generated/$id").put("title", "$id.wav").put("_relativePath", "$id.wav")
        .put("kind", "file").put("layer", "snapshot").put("text", "").put("mimeType", "audio/wav")
        .put("observedAt", "2026-10-05T00:00:00Z")
        .put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", bytes.size)))
    private fun manifest(row: JSONObject) = row.getJSONObject("pending").getJSONObject("manifest")
    private val captureId = "35b8fadb-8f0a-4769-8545-cdad61c4041d"
    private fun request(row: JSONObject) = JSONArray().put(JSONObject().put("externalId", manifest(row).getJSONObject("item").getString("externalId"))
        .put("revision", manifest(row).getJSONObject("item").getString("revision")).put("captureId", captureId)
        .put("sha256", manifest(row).getString("sha256")).put("sizeBytes", manifest(row).getLong("sizeBytes"))
        .put("observedAt", manifest(row).getJSONObject("item").getString("observedAt")))
    private fun ack(row: JSONObject, duplicate: Boolean = false): JSONObject {
        val m = manifest(row); val item = m.getJSONObject("item"); val id = captureId
        val receipt = JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received")
            .put("duplicate", duplicate).put("sourceId", source.id).put("externalId", item.getString("externalId"))
            .put("revision", item.getString("revision"))
        return JSONObject(receipt.toString()).put("receipt", receipt).put("sha256", m.getString("sha256"))
            .put("sizeBytes", m.getLong("sizeBytes"))
    }
    private fun prepare(queue: FileArchiveQueue, selection: LocalSource = source) =
        queue.prepare(selection, { ByteArrayInputStream(bytes) }, { true }, 61000)!!
    private fun observed(queue: FileArchiveQueue, selection: LocalSource = source) {
        queue.observe(selection, item(), queue.configure(selection).getString("generation"), 0)
    }

    @Test fun exactAcknowledgedVersionRecoverySurvivesRestartWithoutReplacingRevisionOrTime() {
        val dir = folder.newFolder(); var queue = FileArchiveQueue(dir, cipher); observed(queue)
        val first = prepare(queue); val initialRevision = manifest(first).getJSONObject("item").getString("revision")
        queue.acknowledge(source.id, first, ack(first)); assertEquals(0, queue.pendingCount(source.id))
        assertFalse(File(dir, source.id + "/spool").exists())
        queue.requestSnapshotRecovery(source, request(first))
        assertTrue(queue.transportReady(source.id, 61000))
        queue = FileArchiveQueue(dir, cipher)
        val recovered = prepare(queue); val m = manifest(recovered)
        assertEquals(initialRevision, m.getJSONObject("item").getString("revision"))
        assertEquals(manifest(first).getJSONObject("item").getString("observedAt"), m.getJSONObject("item").getString("observedAt"))
        assertEquals(captureId, recovered.getJSONObject("pending").getString("recoveryCaptureId"))
        assertEquals(LocalFileIndex.hash(bytes), m.getString("sha256")); assertArrayEquals(bytes, queue.part(source.id, 0))
        assertEquals("central-pending", m.getJSONObject("item").getJSONObject("document").getJSONObject("fileIndex").getString("parser"))
        assertThrows(IllegalStateException::class.java) { queue.acknowledge(source.id, recovered, ack(recovered).put("sha256", "wrong")) }
        assertNotNull(queue.next(source.id)); queue.acknowledge(source.id, recovered, ack(recovered))
        queue.requestSnapshotRecovery(source, JSONArray()) // The completed pipeline no longer advertises missing input.
        assertEquals(0, queue.pendingCount(source.id)); assertFalse(queue.transportReady(source.id, 61000))
        assertNull(queue.prepare(source, { error("Completed recovery must not read again") }, { true }, 61000))
    }

    @Test fun recoveryDuringLostAcknowledgementRetainsTheExactPendingRevisionAndParts() {
        val dir = folder.newFolder(); val queue = FileArchiveQueue(dir, cipher); observed(queue)
        val pending = prepare(queue); val persisted = pending.toString()
        // The central write succeeded but its ACK was lost. A recovery list must
        // not replace the pending manifest or turn retry into a new capture.
        queue.requestSnapshotRecovery(source, request(pending))
        val reopened = FileArchiveQueue(dir, cipher)
        assertEquals(persisted, reopened.next(source.id).toString())
        assertEquals(persisted, reopened.prepare(source, { error("Lost ACK must reuse its spool") }, { true }, 61000).toString())
        assertArrayEquals(bytes, reopened.part(source.id, 0))
        reopened.acknowledge(source.id, pending, ack(pending, duplicate = true))
        assertEquals(0, reopened.pendingCount(source.id)); assertFalse(File(dir, source.id + "/spool").exists())
    }

    @Test fun unknownAndObsoleteRemoteIdsCannotCreateWorkOrOpenRemotePaths() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); observed(queue); val first = prepare(queue)
        queue.acknowledge(source.id, first, ack(first))
        val requests = JSONArray().put(JSONObject().put("externalId", "file:///outside/generated-private.wav").put("revision", "untrusted"))
            .put(JSONObject().put("externalId", manifest(first).getJSONObject("item").getString("externalId")).put("revision", "obsolete"))
        queue.requestSnapshotRecovery(source, requests)
        assertEquals(0, queue.pendingCount(source.id)); assertEquals(1, queue.rows(source.id).size)
        assertNull(queue.prepare(source, { error("Remote IDs cannot open a path") }, { true }, 61000))
    }

    @Test fun changedExclusionsAndNewOnlyBaselineCannotBeOverriddenByRecovery() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); observed(queue); val first = prepare(queue)
        queue.acknowledge(source.id, first, ack(first))
        val excluded = source.copy(excluded = "recording.wav")
        queue.requestSnapshotRecovery(excluded, request(first))
        assertEquals(0, queue.pendingCount(source.id))
        assertNull(queue.prepare(excluded, { error("Revoked file must not open") }, { true }, 61000))

        val baseline = source.copy(id = "generated-baseline", initialSync = "new_only")
        observed(queue, baseline); queue.finish(baseline, queue.state(baseline.id).getString("generation")) { false }
        queue.requestSnapshotRecovery(baseline, JSONArray().put(JSONObject().put("externalId", item().getString("externalId")).put("revision", "")))
        assertEquals(0, queue.pendingCount(baseline.id))
        assertNull(queue.prepare(baseline, { error("Baseline must not become an upload") }, { true }, 61000))
        assertThrows(IllegalArgumentException::class.java) { queue.requestSnapshotRecovery(source.copy(retention = "reference"), request(first)) }
    }

    @Test fun recoveryRevalidatesTheCurrentFileBeforeReadingBytes() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); observed(queue); val first = prepare(queue)
        queue.acknowledge(source.id, first, ack(first)); queue.requestSnapshotRecovery(source, request(first))
        var opens = 0
        assertThrows(IllegalStateException::class.java) { queue.prepare(source, { opens++; ByteArrayInputStream(bytes) }, { false }, 61000) }
        assertEquals(0, opens); assertNull(queue.next(source.id))
    }

    @Test fun narrowerReadPolicyCannotRestoreThePriorGrantEvenWhenBytesAreIdentical() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher)
        val wide = source.copy(allowRead = true)
        observed(queue, wide); val first = prepare(queue, wide)
        val revision = manifest(first).getJSONObject("item").getString("revision")
        queue.acknowledge(source.id, first, ack(first))
        val narrow = source.copy(allowRead = false)
        observed(queue, narrow); queue.requestSnapshotRecovery(narrow, request(first))
        val pending = queue.prepare(narrow, { ByteArrayInputStream(bytes) }, { true }, 61000, anchor = { revision })!!
        val m = manifest(pending); val index = m.getJSONObject("item").getJSONObject("document").getJSONObject("fileIndex")
        assertNotEquals(revision, m.getJSONObject("item").getString("revision"))
        assertEquals(revision, m.getString("previousRevision")); assertEquals(manifest(first).getString("sha256"), m.getString("sha256"))
        assertFalse(index.getBoolean("allowRead")); assertEquals(100000, index.getInt("maxIndexCharacters"))
        assertFalse(pending.getJSONObject("pending").has("recoveryCaptureId"))
    }

    @Test fun changedDocumentMetadataCannotBorrowTheExpiredVersionEvenWhenBytesAndDocumentIdAreIdentical() {
        val queue = FileArchiveQueue(folder.newFolder(), cipher); observed(queue)
        val first = prepare(queue); val oldItem = manifest(first).getJSONObject("item")
        val revision = oldItem.getString("revision")
        queue.acknowledge(source.id, first, ack(first)); queue.requestSnapshotRecovery(source, request(first))
        // A document provider may retain the URI/document ID across a rename.
        // The recovery was discovered before the authorized local rescan.
        val renamed = item().put("title", "renamed-recording.wav").put("_relativePath", "renamed-recording.wav")
            .put("mimeType", "audio/x-wav").put("observedAt", "2026-10-05T00:02:00Z")
        queue.observe(source, renamed, queue.configure(source).getString("generation"), 0)
        var opens = 0
        val pending = queue.prepare(source, { current ->
            opens++; assertEquals(renamed.getString("uri"), current.getString("uri"))
            assertEquals("renamed-recording.wav", current.getString("title")); ByteArrayInputStream(bytes)
        }, { true }, 61000)!!
        val m = manifest(pending); val currentItem = m.getJSONObject("item")
        assertEquals(1, opens); assertEquals(oldItem.getString("externalId"), currentItem.getString("externalId"))
        assertEquals(oldItem.getString("uri"), currentItem.getString("uri"))
        assertEquals("renamed-recording.wav", currentItem.getString("title"))
        assertEquals("renamed-recording.wav", m.getString("relativePath")); assertEquals("audio/x-wav", currentItem.getString("mimeType"))
        assertEquals("2026-10-05T00:02:00Z", currentItem.getString("observedAt"))
        assertNotEquals(revision, currentItem.getString("revision")); assertEquals(revision, m.getString("previousRevision"))
        assertEquals(manifest(first).getString("sha256"), m.getString("sha256"))
        assertFalse(pending.getJSONObject("pending").has("recoveryCaptureId")); assertArrayEquals(bytes, queue.part(source.id, 0))
    }
}
