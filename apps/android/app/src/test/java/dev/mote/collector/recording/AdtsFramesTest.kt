package dev.mote.collector.recording

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

class AdtsFramesTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun `header carries profile sample rate channels and exact frame length`() {
        val header = AdtsFrames.header(1000, 44_100, 2)
        assertArrayEquals(
            byteArrayOf(0xFF.toByte(), 0xF1.toByte(), 0x50, 0x80.toByte(), 0x7D, 0xFF.toByte(), 0xFC.toByte()),
            header,
        )
        assertEquals(1007, AdtsFrames.frameLength(header))
        assertEquals(4, AdtsFrames.sampleRateIndex(44_100))
        assertEquals(0, AdtsFrames.sampleRateIndex(96_000))
        assertEquals(12, AdtsFrames.sampleRateIndex(7350))
    }

    @Test fun `parser stops at a partial trailing frame and keeps earlier offsets`() {
        val writer = SegmentedAudioWriter(folder.newFolder(), 44_100, 1)
        repeat(4) { writer.write(ByteArray(100) { index -> index.toByte() }) }
        val file = checkNotNull(writer.openFile)
        val complete = AdtsFrames.parse(file.readBytes())
        assertEquals(4, complete.size)
        assertEquals(listOf(0, 107, 214, 321), complete.map { it.offset })
        assertTrue(complete.all { it.length == 107 && it.payloadLength == 100 })

        RandomAccessFile(file, "rw").use { it.setLength(file.length() - 20L) }
        val truncated = AdtsFrames.parse(file.readBytes())
        assertEquals(3, truncated.size)
        assertEquals(complete.take(3), truncated)
        writer.finish()
    }

    @Test fun `recovery reads only the first complete header`() {
        val writer = SegmentedAudioWriter(folder.newFolder(), 48_000, 2)
        val empty = folder.newFile("empty.aac")
        assertFalse(AdtsFrames.hasCompleteFrame(empty))
        writer.write(ByteArray(10))
        val produced = checkNotNull(writer.openFile)
        assertTrue(AdtsFrames.hasCompleteFrame(produced))
        RandomAccessFile(produced, "rw").use { it.setLength((AdtsFrames.HEADER_BYTES + 3).toLong()) }
        assertFalse(AdtsFrames.hasCompleteFrame(produced))
        writer.finish()
    }
}
