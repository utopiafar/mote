package dev.mote.collector.meeting

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile

/** One meeting, one WAV. The header is finalized on stop; every write reaches
 * the file immediately so a killed process leaves a bounded partial recording. */
internal class MeetingWaveWriter(private val file: File, private val sampleRate: Int = 44_100, private val channels: Int = 1) : Closeable {
    private val output = RandomAccessFile(file, "rw")
    private var dataBytes = 0L
    private var closed = false

    init {
        require(channels in 1..2)
        output.setLength(0)
        output.write(ByteArray(HEADER_BYTES))
    }

    fun write(pcm: ShortArray, count: Int) {
        check(!closed) { "meeting audio is closed" }
        require(count in 0..pcm.size)
        if (count == 0) return
        val bytes = ByteArray(count * 2)
        for (index in 0 until count) {
            val value = pcm[index].toInt()
            bytes[index * 2] = (value and 0xff).toByte()
            bytes[index * 2 + 1] = ((value shr 8) and 0xff).toByte()
        }
        output.write(bytes)
        dataBytes += bytes.size
    }

    fun finish(): Long {
        if (closed) return dataBytes
        closed = true
        writeHeader()
        output.fd.sync()
        output.close()
        return dataBytes
    }

    override fun close() { finish() }

    private fun writeHeader() {
        val byteRate = sampleRate * channels * 2
        val header = java.nio.ByteBuffer.allocate(HEADER_BYTES).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt((36 + dataBytes).toInt())
        header.put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16); header.putShort(1); header.putShort(channels.toShort())
        header.putInt(sampleRate); header.putInt(byteRate); header.putShort((channels * 2).toShort()); header.putShort(16)
        header.put("data".toByteArray(Charsets.US_ASCII)); header.putInt(dataBytes.toInt())
        output.seek(0); output.write(header.array())
    }

    companion object { const val HEADER_BYTES = 44 }
}
