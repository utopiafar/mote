package dev.mote.collector.recording

import dev.mote.collector.CentralAttachments
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream

/**
 * Streams encoded AAC access units into ADTS segment files. Each write reaches
 * the file immediately, so a crash leaves every already written frame playable
 * and a new segment starts before the attachment cap would be crossed.
 */
internal class SegmentedAudioWriter(
    private val directory: File,
    private val sampleRate: Int,
    private val channels: Int,
    private val maxSegmentBytes: Long = MAX_SEGMENT_BYTES,
    private val onSegment: (Segment) -> Unit = {},
) : Closeable {
    internal data class Segment(val index: Int, val file: File, val bytes: Long, val frames: Int)

    private val completed = ArrayList<Segment>()
    private var output: FileOutputStream? = null
    private var currentFile: File? = null
    private var currentIndex = -1
    private var currentBytes = 0L
    private var currentFrames = 0
    private var nextIndex = 0
    private var closed = false

    init {
        require(maxSegmentBytes in (AdtsFrames.HEADER_BYTES + 1).toLong()..CentralAttachments.MAX_BYTES.toLong()) {
            "segment size must stay within the attachment limit"
        }
        AdtsFrames.sampleRateIndex(sampleRate)
        require(channels in 1..7)
    }

    /** Segments closed so far, in recording order. */
    val segments: List<Segment> get() = completed.toList()
    val openFile: File? get() = currentFile
    val openBytes: Long get() = currentBytes
    val bytesWritten: Long get() = completed.sumOf { it.bytes } + currentBytes

    fun write(payload: ByteArray, offset: Int = 0, length: Int = payload.size) {
        check(!closed) { "recording writer is closed" }
        require(offset >= 0 && length >= 0 && offset + length <= payload.size)
        if (length == 0) return
        val frameBytes = length + AdtsFrames.HEADER_BYTES
        require(frameBytes <= maxSegmentBytes) { "AAC frame does not fit into a recording segment" }
        if (output == null || currentBytes + frameBytes > maxSegmentBytes) rotate()
        val stream = checkNotNull(output)
        stream.write(AdtsFrames.header(length, sampleRate, channels))
        stream.write(payload, offset, length)
        currentBytes += frameBytes
        currentFrames++
    }

    /** Closes the open segment and reports it; repeated calls are no-ops. */
    fun finish(): List<Segment> {
        if (closed) return segments
        closed = true
        closeCurrent()
        return segments
    }

    override fun close() { finish() }

    private fun rotate() {
        closeCurrent()
        directory.mkdirs()
        check(directory.isDirectory) { "recording directory is unavailable" }
        val index = nextIndex++
        val file = File(directory, SEGMENT_PREFIX + index.toString().padStart(4, '0') + ".aac")
        check(!file.exists()) { "recording segment already exists" }
        currentFile = file
        currentIndex = index
        output = FileOutputStream(file)
        currentBytes = 0
        currentFrames = 0
    }

    private fun closeCurrent() {
        val stream = output ?: return
        val file = checkNotNull(currentFile)
        val index = currentIndex
        val bytes = currentBytes
        val frames = currentFrames
        output = null
        currentFile = null
        currentIndex = -1
        currentBytes = 0
        currentFrames = 0
        runCatching { stream.flush(); stream.fd.sync() }
        stream.close()
        if (bytes == 0L) file.delete()
        else {
            val segment = Segment(index, file, bytes, frames)
            completed += segment
            onSegment(segment)
        }
    }

    internal companion object {
        val MAX_SEGMENT_BYTES: Long = CentralAttachments.MAX_BYTES.toLong()
        const val SEGMENT_PREFIX = "record-microphone-"
    }
}
