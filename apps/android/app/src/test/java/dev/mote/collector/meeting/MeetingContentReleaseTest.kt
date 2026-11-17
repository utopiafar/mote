package dev.mote.collector.meeting

import dev.mote.collector.ByteCipher
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.UUID

class MeetingContentReleaseTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private val device = "generated-device"
    private fun uploaded(root: File): Pair<MeetingRecordingStore, MeetingSession> {
        val store = MeetingRecordingStore(root, cipher); val at = Instant.parse("2026-11-17T01:00:00Z"); val id = UUID.randomUUID().toString()
        val notice = store.acknowledgeNotice(at); store.begin(id, at, notice, "https://generated.invalid")
        val audio = File(root, "meeting-$id.wav"); MeetingWaveWriter(audio, 8000, 1).apply { write(ShortArray(160), 160); finish() }
        val completed = store.complete(id, at.plusSeconds(1), 1000, true, false, audio.name, listOf("Generated private warning"))
        val manifest = MeetingRecordingItems.manifest(device, completed, audio.length(), MeetingRecordingItems.digest(audio))
        return store to requireNotNull(store.markUploaded(completed, UUID.randomUUID().toString(), "https://generated.invalid", manifest))
    }
    @Test fun exactReceiptReleasesAudioAndKeepsLightSessionAcrossRestartWithoutUploadRecovery() {
        val root = folder.newFolder(); val (store, session) = uploaded(root)
        store.releaseContent(session.id, device) {}
        val reopened = MeetingRecordingStore(root, cipher); val light = reopened.sessions().single()
        assertEquals("uploaded", light.state); assertEquals(session.captureId, light.captureId); assertEquals(session.archiveSha256, light.archiveSha256)
        assertNull(light.audioFile); assertTrue(light.warnings.isEmpty()); assertFalse(light.localContentRelease!!.pending)
        assertFalse(File(root, session.audioFile!!).exists()); assertTrue(reopened.recovery().isEmpty()); assertFalse(reopened.hasPendingConnectionWork())
    }
    @Test fun incompleteReceiptAndWrongDeviceCannotDestroyAnAcceptedExistingRecording() {
        for (missing in listOf("archiveFingerprint", "archiveSha256", "archiveSizeBytes", "wrong-device")) {
            val root = folder.newFolder(); val (store, session) = uploaded(root); val file = File(root, session.audioFile!!); val before = file.readBytes()
            if (missing != "wrong-device") {
                val state = store.read(); state.getJSONArray("sessions").getJSONObject(0).remove(missing); File(root, "state.enc").writeText(state.toString())
            }
            assertThrows(Exception::class.java) { MeetingRecordingStore(root, cipher).releaseContent(session.id, if (missing == "wrong-device") "another-generated-device" else device) {} }
            assertArrayEquals(before, file.readBytes()); assertNull(MeetingRecordingStore(root, cipher).sessions().single().localContentRelease)
        }
    }
    @Test fun realUnlinkErrorRemainsIncompleteAndRestartRetryNeverQueuesAnotherUpload() {
        val root = folder.newFolder(); val (store, session) = uploaded(root); val audio = File(root, session.audioFile!!); var injected = false
        assertThrows(IllegalStateException::class.java) { store.releaseContent(session.id, device) {
            if (!injected && store.sessions().single().localContentRelease != null) {
                injected = true; check(audio.delete()); check(audio.mkdir()); File(audio, "generated-child").writeText("generated")
            }
        } }
        val reopened = MeetingRecordingStore(root, cipher)
        assertTrue(reopened.sessions().single().localContentRelease!!.pending); assertTrue(reopened.recovery().isEmpty()); assertTrue(audio.exists())
        check(audio.deleteRecursively()); reopened.releaseContent(session.id, device) {}
        assertFalse(MeetingRecordingStore(root, cipher).sessions().single().localContentRelease!!.pending)
    }
}
