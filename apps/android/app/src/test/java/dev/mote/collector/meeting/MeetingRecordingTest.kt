package dev.mote.collector.meeting

import dev.mote.collector.LocalContentCipher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.UUID

class MeetingRecordingTest {
    private val roots = mutableListOf<File>()
    @org.junit.After fun cleanup() { roots.forEach { it.deleteRecursively() } }
    private fun directory(): File = Files.createTempDirectory("mote-meeting-test").toFile().also { roots += it }
    private fun store(root: File) = MeetingRecordingStore(root, LocalContentCipher())

    @Test fun idleStoreNeverCreatesASessionOrNotice() {
        val store = store(directory())
        assertTrue(store.sessions().isEmpty())
        assertNull(store.noticeAcknowledgedAt())
        assertTrue(store.recovery().isEmpty())
        assertTrue(store.sessions().isEmpty())
    }

    @Test fun firstSessionRequiresTheNoticeConfirmation() {
        val directory = directory(); val store = store(directory)
        val id = UUID.randomUUID().toString()
        try { store.begin(id, Instant.parse("2026-11-11T09:00:00Z"), "2026-11-11T08:59:00Z"); fail("unconfirmed notice must not start") }
        catch (_: IllegalArgumentException) { }
        assertTrue(store.sessions().isEmpty())
        val acknowledged = store.acknowledgeNotice(Instant.parse("2026-11-11T08:59:00Z"))
        val session = store.begin(id, Instant.parse("2026-11-11T09:00:00Z"), acknowledged)
        assertEquals("recording", session.state)
        assertEquals(1, store.sessions().size)
    }

    @Test fun stopProducesOneCompletedAudioSessionWhoseManifestUsesTheLocalMeetingSource() {
        val root = directory(); val store = store(root)
        val acknowledged = store.acknowledgeNotice(Instant.parse("2026-11-11T08:59:00Z"))
        val id = UUID.randomUUID().toString()
        store.begin(id, Instant.parse("2026-11-11T09:00:00Z"), acknowledged)
        val session = store.complete(id, Instant.parse("2026-11-11T09:30:00Z"), 1_800_000, true, true, "meeting-$id.wav", listOf("Generated test warning"))
        assertEquals("completed", session.state)
        assertEquals(1, store.sessions().size)
        val manifest = MeetingRecordingItems.manifest("android-generated", session, 32000, "a".repeat(64))
        assertEquals("local-meeting-" + dev.mote.collector.SourceRules.hash("android-generated").take(24), manifest.getString("sourceId"))
        assertEquals("audio/wav", manifest.getJSONObject("item").getString("mimeType"))
        assertEquals("original", manifest.getJSONObject("item").getString("layer"))
        assertEquals("meeting:$id", manifest.getJSONObject("item").getString("externalId"))
        val meeting = manifest.getJSONObject("item").getJSONObject("document").getJSONObject("originalMetadata").getJSONObject("meeting")
        assertEquals("android", meeting.getString("platform"))
        assertTrue(meeting.getBoolean("microphone"))
        assertTrue(meeting.getBoolean("systemAudio"))
        store.markUploaded(id, "capture-generated")
        assertEquals("uploaded", store.sessions().single().state)
        assertEquals("capture-generated", store.sessions().single().captureId)
    }

    @Test fun interruptedRecordingIsMarkedFailedAndNeverResumed() {
        val root = directory(); val store = store(root)
        val acknowledged = store.acknowledgeNotice(Instant.parse("2026-11-11T08:59:00Z"))
        val id = UUID.randomUUID().toString()
        store.begin(id, Instant.parse("2026-11-11T09:00:00Z"), acknowledged)
        val pending = store.recovery()
        assertTrue(pending.isEmpty())
        assertEquals("failed", store.sessions().single().state)
        assertFalse(store.sessions().any { it.state == "recording" })
    }

    @Test fun waveWriterProducesOneBoundedMonoFile() {
        val file = File(directory(), "meeting.wav")
        val writer = MeetingWaveWriter(file, 16_000, 1)
        writer.write(ShortArray(320) { 1000 }, 320)
        writer.write(ShortArray(320) { -1000 }, 320)
        val bytes = writer.finish()
        assertEquals(1280, bytes)
        assertEquals(44 + 1280, file.length())
        val header = file.readBytes()
        assertEquals("RIFF", String(header, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(header, 8, 4, Charsets.US_ASCII))
        assertEquals(16_000, java.nio.ByteBuffer.wrap(header, 24, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int)
        assertEquals(1280, java.nio.ByteBuffer.wrap(header, 40, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int)
    }
}
