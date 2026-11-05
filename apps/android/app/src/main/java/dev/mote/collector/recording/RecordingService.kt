package dev.mote.collector.recording

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import dev.mote.collector.plugins.NotesPlugin
import dev.mote.collector.recordDraftStore
import dev.mote.collector.recordingNotification
import org.json.JSONArray
import java.io.File
import java.util.UUID

internal enum class RecordingPhase { IDLE, STARTING, RECORDING, PAUSED, STOPPING }

/** Focus returning is not consent to restart the microphone. */
internal class RecordingStateMachine {
    var phase = RecordingPhase.IDLE
        private set
    var interrupted = false
        private set

    fun prepare() { check(phase == RecordingPhase.IDLE); phase = RecordingPhase.STARTING; interrupted = false }
    fun started(focusGranted: Boolean) {
        if (phase != RecordingPhase.STARTING) return
        phase = if (focusGranted) RecordingPhase.RECORDING else RecordingPhase.PAUSED
        interrupted = !focusGranted
    }
    fun pause(byInterruption: Boolean) {
        if (phase != RecordingPhase.RECORDING && phase != RecordingPhase.STARTING) return
        phase = RecordingPhase.PAUSED
        interrupted = byInterruption
    }
    fun resume(focusGranted: Boolean) {
        if (phase != RecordingPhase.PAUSED) return
        if (focusGranted) { phase = RecordingPhase.RECORDING; interrupted = false }
        else interrupted = true
    }
    fun stop() { if (phase != RecordingPhase.IDLE) phase = RecordingPhase.STOPPING }
    fun finished() { phase = RecordingPhase.IDLE; interrupted = false }
}

internal data class RecordingSnapshot(val phase: RecordingPhase, val elapsedMs: Long, val interrupted: Boolean, val error: String?) {
    val active: Boolean get() = phase != RecordingPhase.IDLE
}

/** Map the captured PCM peak to a visible meter without inventing sound in silence. */
internal fun recordingLevel(pcm: ShortArray, count: Int): Float {
    require(count in 0..pcm.size)
    val peak = (0 until count).maxOfOrNull { kotlin.math.abs(pcm[it].toInt()) } ?: 0
    return kotlin.math.sqrt((peak / 9000f).coerceIn(0f, 1f))
}

/** Process-local state is observable by any editor without binding its lifetime to capture. */
internal object RecordingSession {
    val lock = Object()
    val machine = RecordingStateMachine()
    var directory: File? = null
    var input: AudioRecord? = null
    var recorder: SegmentedAudioRecorder? = null
    var accumulatedMs = 0L
    var runningSince = 0L
    var error: String? = null
    val levels = ArrayDeque<Float>()
    var lastLevelAt = 0L
    @Volatile var segmentIds: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    private val observers = mutableSetOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun snapshot(): RecordingSnapshot = synchronized(lock) {
        val elapsed = accumulatedMs + if (machine.phase == RecordingPhase.RECORDING) SystemClock.elapsedRealtime() - runningSince else 0L
        RecordingSnapshot(machine.phase, elapsed, machine.interrupted, error)
    }
    fun observe(observer: () -> Unit) { observers.add(observer); observer() }
    fun remove(observer: () -> Unit) { observers.remove(observer) }
    fun changed() { main.post { observers.toList().forEach { it() } } }
    fun addLevel(pcm: ShortArray, count: Int) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastLevelAt < 180) return
        lastLevelAt = now
        if (levels.size == 21) levels.removeFirst()
        levels.addLast(recordingLevel(pcm, count))
    }
    fun startClock() { runningSince = SystemClock.elapsedRealtime() }
    fun stopClock() { if (machine.phase == RecordingPhase.RECORDING) accumulatedMs += SystemClock.elapsedRealtime() - runningSince }
}

/** Preserve rotated segments when a queued edit used an older attachment snapshot. */
internal fun mergeRecordedAttachments(files: JSONArray, current: JSONArray, ids: Set<String>): JSONArray {
    val result = JSONArray(files.toString())
    val present = (0 until result.length()).map { result.getJSONObject(it).getString("id") }.toMutableSet()
    for (i in 0 until current.length()) {
        val item = current.getJSONObject(i)
        if (item.getString("id") in ids && present.add(item.getString("id"))) result.put(item)
    }
    return result
}

/** The live file must not be moved while its writer still owns it. */
internal fun recoverAbandonedRecordings(root: File, active: File?, sink: RecordingDraftSink) {
    root.listFiles().orEmpty().filter { it.isDirectory && it != active }.sortedBy { it.name }.forEach { dir ->
        sink.recover(dir)
        if (dir.listFiles().isNullOrEmpty()) dir.delete()
    }
}

/** Microphone ownership begins only from a visible editor and survives its destruction. */
class RecordingService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var audioManager: AudioManager
    private lateinit var focusRequest: AudioFocusRequest
    private var worker: Thread? = null

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AudioManager::class.java)
        focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener({ change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) pause(true)
            }, main).build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!RecordingSession.snapshot().active) { stopSelf(startId); return START_NOT_STICKY }
        if (RecordingSession.snapshot().phase == RecordingPhase.STOPPING && worker == null) {
            finishSession(null)
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_START -> if (synchronized(RecordingSession.lock) { RecordingSession.machine.phase == RecordingPhase.STARTING } && worker == null) {
                try {
                    startForeground(NOTIFICATION_ID, recordingNotification(this, RecordingSession.snapshot()), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                    val granted = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                    synchronized(RecordingSession.lock) {
                        RecordingSession.machine.started(granted)
                        if (RecordingSession.machine.phase == RecordingPhase.RECORDING) RecordingSession.startClock()
                    }
                    publish()
                    worker = Thread(::capture, "mote-recording").also { it.start() }
                } catch (failure: Exception) { finishSession(failure) }
            }
            ACTION_PAUSE -> pause(false)
            ACTION_RESUME -> resumeRecording()
            ACTION_STOP -> stopRecording()
            else -> if (!RecordingSession.snapshot().active) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun pause(interrupted: Boolean) {
        synchronized(RecordingSession.lock) {
            if (RecordingSession.machine.phase !in setOf(RecordingPhase.RECORDING, RecordingPhase.STARTING)) return
            RecordingSession.stopClock()
            RecordingSession.machine.pause(interrupted)
            RecordingSession.recorder?.pause()
            runCatching { RecordingSession.input?.stop() }
        }
        audioManager.abandonAudioFocusRequest(focusRequest)
        publish()
    }

    private fun resumeRecording() {
        if (RecordingSession.snapshot().phase != RecordingPhase.PAUSED) return
        val granted = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        synchronized(RecordingSession.lock) {
            RecordingSession.machine.resume(granted)
            if (RecordingSession.machine.phase == RecordingPhase.RECORDING) {
                RecordingSession.recorder?.resume()
                RecordingSession.startClock()
                RecordingSession.lock.notifyAll()
            }
        }
        publish()
    }

    private fun stopRecording() {
        if (RecordingSession.snapshot().phase == RecordingPhase.IDLE) return
        signalStop()
        audioManager.abandonAudioFocusRequest(focusRequest)
        publish()
        if (worker == null) finishSession(null)
    }

    @Suppress("MissingPermission")
    private fun capture() {
        var source: AudioRecord? = null
        var encoder: SegmentedAudioRecorder? = null
        var failure: Throwable? = null
        try {
            val directory = synchronized(RecordingSession.lock) { checkNotNull(RecordingSession.directory) }
            val sink = RecordingDraftSink(recordDraftStore())
            val writer = SegmentedAudioWriter(directory, SAMPLE_RATE, 1, onSegment = { segment ->
                NotesPlugin.io.submit {
                    val item = sink.commit(segment)
                    RecordingSession.segmentIds.add(item.getString("id"))
                }.get()
            })
            encoder = SegmentedAudioRecorder(MediaCodecAacEncoder(SAMPLE_RATE, 1), writer)
            val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(bufferSize > 0) { "Microphone buffer unavailable" }
            source = AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize * 2)
            check(source.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable" }
            val ownedSource = source
            source.registerAudioRecordingCallback(mainExecutor, object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>) {
                    if (configs.any { it.clientAudioSessionId == ownedSource.audioSessionId && it.isClientSilenced }) pause(true)
                }
            })
            synchronized(RecordingSession.lock) { RecordingSession.input = source; RecordingSession.recorder = encoder }
            val pcm = ShortArray(maxOf(1024, bufferSize / 2))
            while (true) {
                val running = synchronized(RecordingSession.lock) {
                    while (RecordingSession.machine.phase == RecordingPhase.PAUSED || RecordingSession.machine.phase == RecordingPhase.STARTING) RecordingSession.lock.wait()
                    if (RecordingSession.machine.phase == RecordingPhase.RECORDING) {
                        if (source.recordingState != AudioRecord.RECORDSTATE_RECORDING) source.startRecording()
                        true
                    } else false
                }
                if (!running) break
                val count = source.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
                if (source.activeRecordingConfiguration?.isClientSilenced == true) { main.post { pause(true) }; continue }
                synchronized(RecordingSession.lock) {
                    if (RecordingSession.machine.phase == RecordingPhase.RECORDING) {
                        if (count < 0) error("Microphone read failed: $count")
                        if (count > 0) { encoder.writePcm(pcm, count); RecordingSession.addLevel(pcm, count) }
                    }
                }
            }
        } catch (problem: Throwable) { failure = problem }
        finally {
            synchronized(RecordingSession.lock) {
                RecordingSession.input = null
                RecordingSession.recorder = null
            }
            runCatching { source?.stop() }
            source?.release()
            try { encoder?.close() } catch (problem: Throwable) { if (failure == null) failure = problem }
            synchronized(RecordingSession.lock) { RecordingSession.directory?.takeIf { it.listFiles().isNullOrEmpty() }?.delete() }
            main.post { finishSession(failure) }
        }
    }

    private fun finishSession(failure: Throwable?) {
        synchronized(RecordingSession.lock) {
            RecordingSession.stopClock()
            RecordingSession.machine.finished()
            RecordingSession.directory = null
            RecordingSession.error = failure?.let { "录音失败" }
        }
        audioManager.abandonAudioFocusRequest(focusRequest)
        RecordingSession.changed()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun publish() {
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIFICATION_ID, recordingNotification(this, RecordingSession.snapshot()))
        RecordingSession.changed()
    }

    override fun onDestroy() { stopRecording(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val ACTION_START = "dev.mote.collector.recording.START"
        const val ACTION_PAUSE = "dev.mote.collector.recording.PAUSE"
        const val ACTION_RESUME = "dev.mote.collector.recording.RESUME"
        const val ACTION_STOP = "dev.mote.collector.recording.STOP"
        const val NOTIFICATION_ID = 4201
        private const val SAMPLE_RATE = 44_100
        private const val DIRECTORY = "recording-pending"

        /** Call only from a resumed editor after microphone permission is granted. */
        internal fun startFromEditor(context: Context, ownerAvailable: () -> Boolean) {
            synchronized(RecordingSession.lock) {
                if (!ownerAvailable() || RecordingSession.machine.phase != RecordingPhase.IDLE) return
                RecordingSession.machine.prepare()
                RecordingSession.directory = File(File(context.filesDir, DIRECTORY), UUID.randomUUID().toString())
                RecordingSession.accumulatedMs = 0; RecordingSession.error = null; RecordingSession.levels.clear(); RecordingSession.lastLevelAt = 0; RecordingSession.segmentIds = java.util.concurrent.ConcurrentHashMap.newKeySet()
            }
            RecordingSession.changed()
            try { context.startForegroundService(Intent(context, RecordingService::class.java).setAction(ACTION_START)) }
            catch (failure: Exception) {
                synchronized(RecordingSession.lock) { RecordingSession.machine.finished(); RecordingSession.directory = null; RecordingSession.error = "录音失败" }
                RecordingSession.changed()
            }
        }
        internal fun command(context: Context, action: String) {
            if (RecordingSession.snapshot().active) context.startService(Intent(context, RecordingService::class.java).setAction(action))
        }
        /** Fence microphone reads synchronously when the owning plugin is revoked;
         * the service then flushes and retains the finished segment. */
        internal fun stopForScope(context: Context) {
            if (signalStop()) {
                RecordingSession.changed()
                command(context, ACTION_STOP)
            }
        }
        private fun signalStop(): Boolean = synchronized(RecordingSession.lock) {
            if (RecordingSession.machine.phase in setOf(RecordingPhase.IDLE, RecordingPhase.STOPPING)) return@synchronized false
            RecordingSession.stopClock()
            RecordingSession.machine.stop()
            runCatching { RecordingSession.input?.stop() }
            RecordingSession.lock.notifyAll()
            true
        }
        /** Recover only abandoned sessions; never read or move the live segment. */
        internal fun recover(context: Context) {
            val active = synchronized(RecordingSession.lock) { RecordingSession.directory }
            val sink = RecordingDraftSink(context.recordDraftStore())
            recoverAbandonedRecordings(File(context.filesDir, DIRECTORY), active, sink)
        }
    }
}
