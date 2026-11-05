package dev.mote.collector.recording

import java.io.File
import java.io.FileInputStream

/**
 * ADTS framing for raw AAC access units. ADTS repeats a fixed header before
 * every frame, so a file truncated by a killed process stays decodable up to
 * its last complete frame.
 */
internal object AdtsFrames {
    const val HEADER_BYTES = 7
    const val MAX_FRAME_BYTES = 0x1FFF
    const val DEFAULT_PROFILE = 1 // AAC LC, encoded as object type 2 minus 1.

    private val SAMPLE_RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

    /** Builds the 7-byte header for one payload. */
    fun header(payloadBytes: Int, sampleRate: Int, channels: Int, profile: Int = DEFAULT_PROFILE): ByteArray {
        require(payloadBytes in 0..MAX_FRAME_BYTES - HEADER_BYTES)
        require(profile in 0..3)
        require(channels in 1..7)
        val frameBytes = payloadBytes + HEADER_BYTES
        val frequency = sampleRateIndex(sampleRate)
        return byteArrayOf(
            0xFF.toByte(),
            0xF1.toByte(), // MPEG-4, layer 0, no CRC
            ((profile shl 6) or (frequency shl 2) or ((channels shr 2) and 1)).toByte(),
            (((channels and 3) shl 6) or ((frameBytes shr 11) and 3)).toByte(),
            ((frameBytes shr 3) and 0xFF).toByte(),
            (((frameBytes and 7) shl 5) or 0x1F).toByte(),
            0xFC.toByte(), // buffer fullness 0x7FF, one raw data block
        )
    }

    fun sampleRateIndex(sampleRate: Int): Int = SAMPLE_RATES.indexOf(sampleRate).takeIf { it >= 0 }
        ?: throw IllegalArgumentException("unsupported AAC sample rate: $sampleRate")

    fun frameLength(header: ByteArray, offset: Int = 0): Int =
        ((header[offset + 3].toInt() and 3) shl 11) or
            ((header[offset + 4].toInt() and 0xFF) shl 3) or
            ((header[offset + 5].toInt() and 0xFF) shr 5)

    fun isHeader(bytes: ByteArray, offset: Int): Boolean =
        offset >= 0 && offset + HEADER_BYTES <= bytes.size &&
            (bytes[offset].toInt() and 0xFF) == 0xFF &&
            (bytes[offset + 1].toInt() and 0xF6) == 0xF0

    /**
     * Returns every complete frame before [limit]. A partial trailing frame is
     * left out; earlier frames keep their original offsets and payloads.
     */
    fun parse(bytes: ByteArray, limit: Int = bytes.size): List<AdtsFrame> {
        require(limit in 0..bytes.size)
        val frames = ArrayList<AdtsFrame>()
        var offset = 0
        while (offset + HEADER_BYTES <= limit) {
            if (!isHeader(bytes, offset)) break
            val length = frameLength(bytes, offset)
            if (length < HEADER_BYTES || offset + length > limit) break
            frames += AdtsFrame(offset, length)
            offset += length
        }
        return frames
    }

    /** Reads only the first header, so recovery never loads a whole segment. */
    fun hasCompleteFrame(file: File): Boolean {
        if (file.length() < HEADER_BYTES) return false
        val header = ByteArray(HEADER_BYTES)
        FileInputStream(file).use { input ->
            var read = 0
            while (read < header.size) {
                val count = input.read(header, read, header.size - read)
                if (count < 0) return false
                read += count
            }
        }
        if (!isHeader(header, 0)) return false
        val length = frameLength(header)
        return length >= HEADER_BYTES && length <= file.length()
    }
}

internal data class AdtsFrame(val offset: Int, val length: Int) {
    val payloadOffset: Int get() = offset + AdtsFrames.HEADER_BYTES
    val payloadLength: Int get() = length - AdtsFrames.HEADER_BYTES
}
