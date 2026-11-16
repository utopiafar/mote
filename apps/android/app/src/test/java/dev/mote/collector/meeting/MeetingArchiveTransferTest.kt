package dev.mote.collector.meeting

import dev.mote.collector.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class MeetingArchiveTransferTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = "https://generated.invalid"
    private val device = "generated-meeting-device"
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun recorded(root: File, cipher: ByteCipher = plain): Pair<MeetingRecordingStore, File> {
        val store = MeetingRecordingStore(root, cipher)
        val at = Instant.parse("2026-11-17T01:00:00Z")
        val notice = store.acknowledgeNotice(at.minusSeconds(60)); val id = UUID.randomUUID().toString()
        store.begin(id, at, notice, origin)
        val audio = File(root, "meeting-$id.wav")
        MeetingWaveWriter(audio, 16000, 1).apply { write(ShortArray(8000) { (it % 100).toShort() }, 8000); finish() }
        store.complete(id, at.plusSeconds(1), 1000, true, false, audio.name, emptyList())
        return store to audio
    }
    private inner class Central : CentralUploadClient {
        val captureId = UUID.randomUUID().toString(); val uploadId = UUID.randomUUID().toString()
        var manifest: JSONObject? = null; var savedAck: JSONObject? = null
        var begins = 0; var parts = 0; var commits = 0; var registrations = 0
        var beginAck = false; var alterAck: (JSONObject) -> Unit = {}; var afterCommit: () -> Unit = {}; var alterPart: (JSONObject) -> Unit = {}
        private fun ack(): JSONObject {
            val m = checkNotNull(manifest); val item = m.getJSONObject("item")
            val receipt = JSONObject().put("version", 2).put("id", captureId).put("kind", "file-revision").put("state", "received").put("duplicate", false)
                .put("sourceId", m.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision"))
            return JSONObject().put("id", captureId).put("captureId", captureId).put("receipt", receipt)
                .put("sourceId", m.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision"))
                .put("sha256", m.getString("sha256")).put("sizeBytes", m.getLong("sizeBytes")).also(alterAck)
        }
        override fun post(path: String, body: JSONObject): JSONObject = when {
            path == "/api/sources" -> { registrations++; JSONObject().put("id", body.getString("id")).put("enabled", true) }
            path == "/api/file-sync/v1/uploads" -> {
                begins++; manifest = JSONObject(body.toString())
                if (beginAck || savedAck != null) JSONObject().put("ack", savedAck ?: ack())
                else JSONObject().put("uploadId", uploadId).put("partBytes", FileTransfer.PART_BYTES).put("parts", JSONArray()).put("nextPart", JSONObject.NULL)
            }
            path == "/api/file-sync/v1/uploads/$uploadId/commit" -> { commits++; ack().also { savedAck = it; afterCommit() } }
            else -> error("Unexpected generated request $path")
        }
        override fun bytes(method: String, path: String, body: ByteArray?, mime: String): JSONObject {
            check(method == "PUT" && path == "/api/file-sync/v1/uploads/$uploadId/parts/0")
            parts++; val bytes = checkNotNull(body)
            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            return JSONObject().put("part", 0).put("bytes", bytes.size).put("hash", hash).also(alterPart)
        }
    }
    private fun transfer(store: MeetingRecordingStore, root: File, central: Central, current: () -> Unit = {}) =
        MeetingArchiveTransfer(store, root, device, origin, central, current) { action -> current(); action() }

    @Test fun exactConfirmationRetainsFormalAudioAndArchiveIdentityWithoutResendingAfterRestart() {
        val root = folder.newFolder(); val (store, audio) = recorded(root); val before = audio.readBytes(); val central = Central()
        assertTrue(transfer(store, root, central).flush())
        val saved = MeetingRecordingStore(root, plain).sessions().single()
        assertEquals("uploaded", saved.state); assertEquals(origin, saved.origin); assertEquals(central.captureId, saved.captureId)
        assertEquals(MeetingRecordingItems.digest(audio), saved.archiveSha256); assertEquals(audio.length(), saved.archiveSizeBytes)
        assertNotNull(saved.archiveFingerprint); assertArrayEquals(before, audio.readBytes()); assertFalse(store.hasPendingConnectionWork())
        assertTrue(transfer(MeetingRecordingStore(root, plain), root, central).flush())
        assertEquals(1, central.registrations); assertEquals(1, central.begins); assertEquals(1, central.parts); assertEquals(1, central.commits)
    }

    @Test fun wrongBeginOrCommitAckAndWrongPartReceiptKeepCompletedOriginalPending() {
        val alterations: List<(JSONObject) -> Unit> = listOf(
            { it.put("id", "invalid") }, { it.put("sourceId", "another-source") }, { it.put("externalId", "another-item") },
            { it.put("revision", "another-revision") }, { it.put("sha256", "b".repeat(64)) }, { it.put("sizeBytes", 1) },
            { it.getJSONObject("receipt").put("id", UUID.randomUUID().toString()) }, { it.remove("receipt") })
        for (begin in listOf(false, true)) for (alter in alterations) {
            val root = folder.newFolder(); val (store, audio) = recorded(root); val bytes = audio.readBytes()
            val central = Central().apply { beginAck = begin; alterAck = alter }
            assertThrows(Exception::class.java) { transfer(store, root, central).flush() }
            assertEquals("completed", MeetingRecordingStore(root, plain).sessions().single().state)
            assertTrue(store.hasPendingConnectionWork()); assertArrayEquals(bytes, audio.readBytes())
            assertEquals(if (begin) 0 else 1, central.parts)
        }
        val root = folder.newFolder(); val (store, audio) = recorded(root)
        val central = Central().apply { alterPart = { it.put("hash", "a".repeat(64)) } }
        assertThrows(IllegalStateException::class.java) { transfer(store, root, central).flush() }
        assertEquals(0, central.commits); assertEquals("completed", store.sessions().single().state); assertTrue(audio.isFile)
    }

    @Test fun realRenameFailureCannotProjectSuccessAndRestartUsesBeginAckWithoutSendingBytesAgain() {
        val root = folder.newFolder(); val state = File(root, "state.enc"); val preserved = File(root, "state-before-failure.enc")
        var fail = false
        val cipher = object : ByteCipher {
            override fun open(bytes: ByteArray) = bytes
            override fun seal(bytes: ByteArray): ByteArray {
                if (fail && JSONObject(String(bytes)).getJSONArray("sessions").optJSONObject(0)?.optString("state") == "uploaded") {
                    check(state.renameTo(preserved)); check(state.mkdir()) // EISDIR at the production rename.
                }
                return bytes
            }
        }
        val (store, audio) = recorded(root, cipher); val original = audio.readBytes(); val before = state.readBytes(); val central = Central()
        fail = true
        try { assertThrows(IllegalStateException::class.java) { transfer(store, root, central).flush() } }
        finally { check(state.delete()); check(preserved.renameTo(state)); fail = false }
        assertArrayEquals(before, state.readBytes()); assertEquals("completed", store.sessions().single().state)
        assertNull(store.sessions().single().captureId); assertTrue(store.hasPendingConnectionWork()); assertArrayEquals(original, audio.readBytes())
        assertTrue(transfer(MeetingRecordingStore(root, cipher), root, central).flush())
        assertEquals(2, central.begins); assertEquals(1, central.parts); assertEquals(1, central.commits)
        assertEquals("uploaded", store.sessions().single().state); assertArrayEquals(original, audio.readBytes())
    }

    @Test fun heldAcknowledgmentWriteKeepsDiskCompletedAndOtherHandlesCannotObserveAnEarlySuccess() {
        val root = folder.newFolder(); val entered = CountDownLatch(1); val release = CountDownLatch(1); var hold = false
        val cipher = object : ByteCipher {
            override fun open(bytes: ByteArray) = bytes
            override fun seal(bytes: ByteArray): ByteArray {
                if (hold && JSONObject(String(bytes)).getJSONArray("sessions").optJSONObject(0)?.optString("state") == "uploaded") {
                    entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                }
                return bytes
            }
        }
        val (store, audio) = recorded(root, cipher); val central = Central(); val executor = Executors.newFixedThreadPool(2)
        try {
            hold = true; val upload = executor.submit<Boolean> { transfer(store, root, central).flush() }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertEquals("completed", JSONObject(File(root, "state.enc").readText()).getJSONArray("sessions").getJSONObject(0).getString("state"))
            val observed = executor.submit<MeetingSession> { MeetingRecordingStore(root, cipher).sessions().single() }
            assertThrows(TimeoutException::class.java) { observed.get(100, TimeUnit.MILLISECONDS) }
            release.countDown(); assertTrue(upload.get(5, TimeUnit.SECONDS)); assertEquals("uploaded", observed.get(5, TimeUnit.SECONDS).state)
            assertTrue(audio.isFile)
        } finally { release.countDown(); executor.shutdownNow(); assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS)) }
    }

    @Test fun revokedGenerationAfterRemoteAckPreservesPendingAudioAndUnknownLegacyOriginIsQuarantined() {
        val root = folder.newFolder(); val (store, audio) = recorded(root); val central = Central(); var current = true
        central.afterCommit = { current = false }
        assertThrows(IllegalStateException::class.java) { transfer(store, root, central) { check(current) }.flush() }
        assertEquals("completed", store.sessions().single().state); assertNull(store.sessions().single().captureId); assertTrue(audio.isFile)
        val state = File(root, "state.enc"); val raw = JSONObject(state.readText()); raw.getJSONArray("sessions").getJSONObject(0).remove("origin"); state.writeText(raw.toString())
        val unknown = MeetingRecordingStore(root, plain); val other = Central()
        assertFalse(transfer(unknown, root, other).flush()); assertTrue(unknown.sessions().single().quarantined); assertEquals(0, other.begins)
        assertTrue(unknown.hasPendingConnectionWork()); assertTrue(audio.isFile)
        assertFalse(transfer(unknown, root, other).flush()); assertEquals(1, other.registrations); assertEquals(0, other.begins)
    }
}
