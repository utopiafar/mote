package dev.mote.collector.recording

import java.io.Closeable

/**
 * Pulls generated or captured PCM through an [AacFrameEncoder] into a
 * [SegmentedAudioWriter]. Pausing stops both encoding and writing, so a paused
 * recording never grows its current segment.
 */
internal class SegmentedAudioRecorder(
    private val encoder: AacFrameEncoder,
    private val writer: SegmentedAudioWriter,
) : Closeable {
    @Volatile private var paused = false
    @Volatile private var finished = false

    val segments: List<SegmentedAudioWriter.Segment> get() = writer.segments
    val bytesWritten: Long get() = writer.bytesWritten
    val isPaused: Boolean get() = paused
    val isFinished: Boolean get() = finished

    fun pause() { paused = true }

    fun resume() {
        if (!finished) paused = false
    }

    /** Encodes one PCM buffer. Returns false when paused or already finished. */
    fun writePcm(pcm: ShortArray, count: Int = pcm.size): Boolean {
        if (paused || finished) return false
        require(count in 0..pcm.size)
        if (count == 0) return false
        encoder.encode(pcm, count) { frame -> if (!paused && !finished) writer.write(frame) }
        return true
    }

    /** Flushes the encoder tail, closes the open segment and returns all segments. */
    fun finish(): List<SegmentedAudioWriter.Segment> {
        if (finished) return writer.segments
        finished = true
        val encoded = runCatching { encoder.finish { writer.write(it) } }
        val segments = writer.finish()
        encoded.getOrThrow()
        return segments
    }

    override fun close() {
        try { finish() } finally { encoder.close() }
    }
}
