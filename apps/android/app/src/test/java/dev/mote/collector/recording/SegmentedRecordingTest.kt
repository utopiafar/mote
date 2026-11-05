package dev.mote.collector.recording

import dev.mote.collector.ByteCipher
import dev.mote.collector.CentralAttachments
import dev.mote.collector.QueueFull
import dev.mote.collector.RecordDraftStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import kotlin.math.PI
import kotlin.math.sin

class SegmentedRecordingTest {
    @get:Rule val folder = TemporaryFolder()

    private val cipher = object : ByteCipher {
        private fun xor(bytes: ByteArray) = ByteArray(bytes.size) { (bytes[it].toInt() xor 0x5A).toByte() }
        override fun seal(bytes: ByteArray): ByteArray = xor(bytes)
        override fun open(bytes: ByteArray): ByteArray = xor(bytes)
        override fun seal(input: InputStream, output: OutputStream) {
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                output.write(xor(buffer.copyOf(count)))
            }
        }
    }

    @Test fun `truncated segment still parses and recovery stages it into the draft`() {
        val pending = folder.newFolder("pending")
        val writer = SegmentedAudioWriter(pending, 44_100, 1)
        val recorder = SegmentedAudioRecorder(GeneratedEncoder(frameSamples = 512, payloadBytes = 400), writer)
        repeat(6) { assertTrue(recorder.writePcm(generatedPcm(512))) }
        val file = checkNotNull(writer.openFile)
        val complete = AdtsFrames.parse(file.readBytes())
        assertEquals(6, complete.size)

        // A killed process never closes the file; only the last frame is partial.
        RandomAccessFile(file, "rw").use { it.setLength(file.length() - 120L) }
        val truncated = AdtsFrames.parse(file.readBytes())
        assertEquals(5, truncated.size)
        assertEquals(complete.take(5), truncated)

        val store = RecordDraftStore(folder.newFolder("draft"), cipher)
        val recovered = RecordingDraftSink(store).recover(pending)
        assertEquals(1, recovered.size)
        val attachment = store.draft().getJSONArray("attachments").getJSONObject(0)
        assertEquals(RecordingDraftSink.MIME, attachment.getString("mime"))
        assertEquals("record-microphone-0000.aac", attachment.getString("name"))
        assertTrue(attachment.getLong("size") > 0)
        assertEquals(5, AdtsFrames.parse(store.bytes(attachment.getString("id"))).size)
        assertTrue(pending.listFiles().orEmpty().isEmpty())
    }

    @Test fun `pause keeps the current segment unchanged until resumed`() {
        val writer = SegmentedAudioWriter(folder.newFolder(), 44_100, 1)
        val recorder = SegmentedAudioRecorder(GeneratedEncoder(frameSamples = 512, payloadBytes = 200), writer)
        val pcm = generatedPcm(512)
        assertTrue(recorder.writePcm(pcm))
        val file = checkNotNull(writer.openFile)
        val written = writer.openBytes
        assertTrue(written > 0)
        assertEquals(written, file.length())

        recorder.pause()
        assertTrue(recorder.isPaused)
        repeat(5) { assertFalse(recorder.writePcm(pcm)) }
        assertEquals(written, writer.openBytes)
        assertEquals(written, file.length())

        recorder.resume()
        assertTrue(recorder.writePcm(pcm))
        assertTrue(writer.openBytes > written)
        assertTrue(file.length() > written)
        assertEquals(1, recorder.finish().size)
    }

    @Test fun `rotates at fifty mebibytes and both segments enter the draft`() {
        assertEquals(CentralAttachments.MAX_BYTES.toLong(), SegmentedAudioWriter.MAX_SEGMENT_BYTES)
        val pending = folder.newFolder("long")
        val store = RecordDraftStore(folder.newFolder("long-draft"), cipher)
        val sink = RecordingDraftSink(store)
        val writer = SegmentedAudioWriter(pending, 44_100, 1, onSegment = sink::commit)
        val payloadBytes = AdtsFrames.MAX_FRAME_BYTES - AdtsFrames.HEADER_BYTES
        val recorder = SegmentedAudioRecorder(GeneratedEncoder(frameSamples = 1024, payloadBytes = payloadBytes), writer)
        val pcm = generatedPcm(1024)

        while (writer.bytesWritten <= SegmentedAudioWriter.MAX_SEGMENT_BYTES) assertTrue(recorder.writePcm(pcm))
        val segments = recorder.finish()

        assertEquals(2, segments.size)
        assertTrue(segments.all { it.bytes <= SegmentedAudioWriter.MAX_SEGMENT_BYTES })
        assertTrue(segments[0].bytes > SegmentedAudioWriter.MAX_SEGMENT_BYTES - (payloadBytes + AdtsFrames.HEADER_BYTES))
        assertTrue(segments[1].bytes > 0)
        assertTrue(segments[1].bytes < segments[0].bytes)
        assertTrue(pending.listFiles().orEmpty().isEmpty())

        val attachments = store.draft().getJSONArray("attachments")
        assertEquals(2, attachments.length())
        assertEquals(segments.map { it.bytes }, (0 until attachments.length()).map { attachments.getJSONObject(it).getLong("size") })
        assertTrue((0 until attachments.length()).all { attachments.getJSONObject(it).getString("mime") == RecordingDraftSink.MIME })
        val first = store.bytes(attachments.getJSONObject(0).getString("id"))
        assertEquals(AdtsFrames.HEADER_BYTES + payloadBytes, AdtsFrames.parse(first, AdtsFrames.HEADER_BYTES + payloadBytes).single().length)
    }

    @Test fun `stageFile streams through the cipher and enforces attachment and disk limits`() {
        val directory = folder.newFolder("stream-draft")
        var available = Long.MAX_VALUE
        val store = RecordDraftStore(directory, cipher) { available }
        val source = File(folder.root, "record-microphone-0000.aac").apply { writeBytes(ByteArray(4096) { it.toByte() }) }
        val item = store.stageFile(source, source.name, RecordingDraftSink.MIME)
        assertEquals(4096L, item.getLong("size"))
        assertArrayEquals(source.readBytes(), store.bytes(item.getString("id")))
        assertFalse(File(directory, item.getString("id") + ".enc").readBytes().contentEquals(source.readBytes()))

        available = store.diskBytes() + 100
        val overQuota = File(folder.root, "over-quota.aac").apply { writeBytes(ByteArray(101)) }
        assertThrows(QueueFull::class.java) {
            store.stageFile(overQuota, overQuota.name, RecordingDraftSink.MIME)
        }

        val oversized = File(folder.root, "oversized.aac")
        RandomAccessFile(oversized, "rw").use { it.setLength(CentralAttachments.MAX_BYTES + 1L) }
        assertThrows(IllegalArgumentException::class.java) {
            store.stageFile(oversized, oversized.name, RecordingDraftSink.MIME)
        }
        assertNotEquals(0L, oversized.length())
    }

    @Test fun `recovery does not duplicate a segment staged before a kill`() {
        val pending = folder.newFolder("recover-once")
        val writer = SegmentedAudioWriter(pending, 44_100, 2)
        writer.write(ByteArray(300))
        writer.write(ByteArray(200))
        val file = checkNotNull(writer.openFile)
        val store = RecordDraftStore(folder.newFolder("recover-draft"), cipher)
        val sink = RecordingDraftSink(store)

        // Simulate a kill after staging and attaching but before deleting the source.
        val item = store.stageFile(file, file.name, RecordingDraftSink.MIME, RecordingDraftSink.stagedId(file))
        store.attach(item)

        assertEquals(1, sink.recover(pending).size)
        assertEquals(1, store.draft().getJSONArray("attachments").length())
        assertFalse(file.exists())
        assertEquals(0, sink.recover(pending).size)
        writer.finish()
    }
}

private class GeneratedEncoder(
    private val frameSamples: Int,
    private val payloadBytes: Int,
) : AacFrameEncoder {
    override fun encode(pcm: ShortArray, count: Int, emit: (ByteArray) -> Unit) {
        var offset = 0
        while (offset < count) {
            val samples = minOf(frameSamples, count - offset)
            val payload = ByteArray(payloadBytes)
            payload[0] = (samples shr 8).toByte()
            payload[1] = samples.toByte()
            if (payloadBytes > 2) payload[2] = (pcm[offset].toInt() shr 8).toByte()
            if (payloadBytes > 3) payload[3] = (pcm[offset + samples - 1].toInt() shr 8).toByte()
            emit(payload)
            offset += samples
        }
    }

    override fun finish(emit: (ByteArray) -> Unit) = Unit
    override fun close() = Unit
}

private fun generatedPcm(count: Int): ShortArray = ShortArray(count) { index ->
    (sin(2 * PI * 440.0 * index / 44_100.0) * 12_000).toInt().toShort()
}
