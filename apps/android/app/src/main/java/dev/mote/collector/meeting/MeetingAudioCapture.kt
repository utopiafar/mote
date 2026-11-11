package dev.mote.collector.meeting

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import androidx.core.content.ContextCompat
import dev.mote.collector.MoteI18n
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal data class MeetingCaptureResult(val durationMs: Long, val microphone: Boolean, val systemAudio: Boolean, val warnings: List<String>)

/** Microphone and device playback are mixed as 16 kHz mono PCM into one WAV.
 * A missing playback stream fails the session instead of silently recording one
 * side while the owner believes both are present. */
internal class MeetingAudioCapture(
    private val mediaProjection: MediaProjection,
    private val file: File,
) {
    private val running = AtomicBoolean(false)
    private val warnings = java.util.Collections.synchronizedList(mutableListOf<String>())
    private val microphoneQueue = ArrayBlockingQueue<ShortArray>(64)
    private val systemQueue = ArrayBlockingQueue<ShortArray>(64)
    private var microphone: AudioRecord? = null
    private var system: AudioRecord? = null
    private val readers = mutableListOf<Thread>()
    private var mixer: Thread? = null
    private val writer = MeetingWaveWriter(file, SAMPLE_RATE, 1)

    fun start() {
        val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(min > 0) { MoteI18n.text("麦克风缓冲不可用") }
        val microphone = AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, min * 2)
        if (microphone.state != AudioRecord.STATE_INITIALIZED) { microphone.release(); error(MoteI18n.text("麦克风不可用")) }
        val system = try {
            val configuration = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            AudioRecord.Builder()
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
                .setAudioPlaybackCaptureConfig(configuration)
                .setBufferSizeInBytes(min * 2)
                .build()
        } catch (error: Exception) { microphone.release(); throw error }
        if (system.state != AudioRecord.STATE_INITIALIZED) { microphone.release(); system.release(); error(MoteI18n.text("系统音频不可用")) }
        this.microphone = microphone
        this.system = system
        try {
            microphone.startRecording()
            system.startRecording()
        } catch (error: Exception) {
            microphone.release(); system.release(); this.microphone = null; this.system = null
            throw error
        }
        running.set(true)
        readers += Thread({ read(microphone, microphoneQueue, MoteI18n.text("麦克风读取失败")) }, "mote-meeting-microphone").apply { start() }
        readers += Thread({ read(system, systemQueue, MoteI18n.text("系统音频读取失败")) }, "mote-meeting-system").apply { start() }
        mixer = Thread(::mix, "mote-meeting-mixer").apply { start() }
    }

    private fun read(record: AudioRecord, queue: ArrayBlockingQueue<ShortArray>, failure: String) {
        val pcm = ShortArray(CHUNK)
        try {
            while (running.get()) {
                val count = record.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
                if (count < 0) { warnings += failure; break }
                if (count == 0) continue
                queue.offer(pcm.copyOf(count))
            }
        } catch (error: Exception) {
            warnings += failure
        }
    }

    private fun mix() {
        try {
            while (running.get() || microphoneQueue.isNotEmpty() || systemQueue.isNotEmpty()) {
                val mic = microphoneQueue.poll(50, TimeUnit.MILLISECONDS)
                val sys = systemQueue.poll(50, TimeUnit.MILLISECONDS)
                if (mic == null && sys == null) continue
                val count = maxOf(mic?.size ?: 0, sys?.size ?: 0)
                if (count == 0) continue
                val mixed = ShortArray(count)
                for (index in 0 until count) {
                    val value = (mic?.getOrNull(index)?.toInt() ?: 0) + (sys?.getOrNull(index)?.toInt() ?: 0)
                    mixed[index] = value.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
                }
                writer.write(mixed, mixed.size)
            }
        } catch (error: Exception) {
            warnings += MoteI18n.text("会议音频写入失败")
        }
    }

    fun stop(): MeetingCaptureResult {
        running.set(false)
        runCatching { microphone?.stop() }
        runCatching { system?.stop() }
        readers.forEach { it.join(2_000) }
        mixer?.join(3_000)
        val bytes = writer.finish()
        microphone?.release(); system?.release()
        microphone = null; system = null
        val durationMs = bytes / 2 * 1000 / SAMPLE_RATE
        return MeetingCaptureResult(durationMs, microphone = true, systemAudio = true, warnings = warnings.toList())
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        private const val CHUNK = 320
    }
}

internal fun android.content.Context.microphoneGranted(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
