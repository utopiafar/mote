package dev.mote.collector.recording

import java.io.Closeable

/**
 * Encodes interleaved 16-bit PCM into raw AAC access units. The recorder owns
 * the write loop; implementations only hand frames back as they become ready.
 */
internal interface AacFrameEncoder : Closeable {
    /** Encodes [count] shorts from [pcm]. May emit zero or more access units. */
    fun encode(pcm: ShortArray, count: Int, emit: (ByteArray) -> Unit)

    /** Flushes the encoder tail before the final segment is closed. */
    fun finish(emit: (ByteArray) -> Unit)
}
