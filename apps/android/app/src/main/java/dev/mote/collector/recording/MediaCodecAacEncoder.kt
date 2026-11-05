package dev.mote.collector.recording

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Android AAC-LC encoder. It feeds the framework encoder from the PCM buffer
 * supplied by the recording service and emits raw access units; ADTS framing
 * belongs to [SegmentedAudioWriter].
 */
internal class MediaCodecAacEncoder(
    private val sampleRate: Int,
    private val channels: Int,
    bitRate: Int = 64_000,
) : AacFrameEncoder {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val bufferInfo = MediaCodec.BufferInfo()
    private var started = false
    private var inputEnded = false
    private var queuedSamples = 0L

    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        started = true
    }

    override fun encode(pcm: ShortArray, count: Int, emit: (ByteArray) -> Unit) {
        check(started && !inputEnded) { "AAC encoder is not recording" }
        require(count in 0..pcm.size)
        if (count == 0) return
        val pending = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (index in 0 until count) pending.putShort(pcm[index])
        pending.flip()
        var attempts = 0
        while (pending.hasRemaining()) {
            if (!feed(pending, emit) && ++attempts > 1_000) {
                throw IllegalStateException("AAC encoder did not accept input")
            }
        }
        drain(emit)
    }

    override fun finish(emit: (ByteArray) -> Unit) {
        if (!started || inputEnded) return
        inputEnded = true
        var attempts = 0
        while (true) {
            val index = codec.dequeueInputBuffer(10_000)
            if (index >= 0) {
                codec.queueInputBuffer(index, 0, 0, presentationTimeUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                break
            }
            drain(emit)
            if (++attempts > 1_000) throw IllegalStateException("AAC encoder did not accept the end of stream")
        }
        val deadline = System.nanoTime() + 2_000_000_000L
        while (System.nanoTime() < deadline) {
            val index = codec.dequeueOutputBuffer(bufferInfo, 10_000)
            if (index >= 0) {
                emitOutput(index, emit)
                if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            } else if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                continue
            }
        }
    }

    override fun close() {
        if (!started) return
        started = false
        runCatching { codec.stop() }
        codec.release()
    }

    private fun feed(pending: ByteBuffer, emit: (ByteArray) -> Unit): Boolean {
        val index = codec.dequeueInputBuffer(10_000)
        if (index < 0) {
            drain(emit)
            return false
        }
        val input = checkNotNull(codec.getInputBuffer(index))
        input.clear()
        val size = minOf(input.remaining(), pending.remaining())
        val chunk = pending.slice().apply { limit(size) }
        input.put(chunk)
        pending.position(pending.position() + size)
        codec.queueInputBuffer(index, 0, size, presentationTimeUs(), 0)
        queuedSamples += size / (2L * channels)
        drain(emit)
        return true
    }

    private fun drain(emit: (ByteArray) -> Unit) {
        while (true) {
            val index = codec.dequeueOutputBuffer(bufferInfo, 0)
            if (index < 0) {
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
                return
            }
            emitOutput(index, emit)
        }
    }

    private fun emitOutput(index: Int, emit: (ByteArray) -> Unit) {
        val buffer = checkNotNull(codec.getOutputBuffer(index))
        if (bufferInfo.size > 0 && bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
            val frame = ByteArray(bufferInfo.size)
            buffer.position(bufferInfo.offset)
            buffer.limit(bufferInfo.offset + bufferInfo.size)
            buffer.get(frame)
            emit(frame)
        }
        codec.releaseOutputBuffer(index, false)
    }

    private fun presentationTimeUs(): Long = queuedSamples * 1_000_000L / sampleRate
}
