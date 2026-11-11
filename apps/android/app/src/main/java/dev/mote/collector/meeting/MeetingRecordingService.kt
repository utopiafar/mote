package dev.mote.collector.meeting

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import dev.mote.collector.MoteI18n
import dev.mote.collector.R
import java.io.File
import java.time.Instant

class MeetingRecordingService : Service() {
    private var capture: MeetingAudioCapture? = null
    private var projection: MediaProjection? = null
    private var sessionId: String? = null
    private var startedAt = 0L
    private var stopping = false
    private val handler = Handler(Looper.getMainLooper())
    private val callback = object : MediaProjection.Callback() {
        override fun onStop() { finish(MoteI18n.text("系统音频授权已结束，会议录音没有继续。")) }
    }
    private val tick = object : Runnable {
        override fun run() {
            if (capture == null || stopping) return
            // 16 kHz mono 16-bit stays below Central's 512 MiB file limit for four hours.
            if (startedAt > 0 && System.currentTimeMillis() - startedAt >= MAX_DURATION_MS) { finish(null); return }
            publish()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> if (capture == null) start(intent) else Unit
            ACTION_STOP -> finish(null)
            else -> if (capture == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        val id = intent.getStringExtra(EXTRA_SESSION) ?: return stopSelf()
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        @Suppress("DEPRECATION") val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA) ?: return stopSelf()
        val store = applicationContext.meetingRecordings()
        val session = store.sessions().firstOrNull { it.id == id } ?: return stopSelf()
        sessionId = id
        try {
            startForeground(NOTIFICATION_ID, notification(session.startedAt), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            val manager = getSystemService(MediaProjectionManager::class.java)
            val projection = manager.getMediaProjection(resultCode, data) ?: error(MoteI18n.text("系统音频授权无效"))
            projection.registerCallback(callback, handler)
            this.projection = projection
            val directory = File(applicationContext.filesDir, "meeting-recordings").apply { mkdirs() }
            val file = File(directory, "meeting-${session.id}.wav")
            val capture = MeetingAudioCapture(projection, file)
            capture.start()
            this.capture = capture
            runningSession = id
            startedAt = System.currentTimeMillis()
            handler.post(tick)
        } catch (error: Exception) {
            stopping = true
            store.fail(id, error.message ?: MoteI18n.text("会议录音没有开始。"))
            runCatching { projection?.stop() }
            projection = null
            File(File(applicationContext.filesDir, "meeting-recordings"), "meeting-$id.wav").delete()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun finish(failure: String?) {
        if (stopping) return
        stopping = true
        handler.removeCallbacks(tick)
        val id = sessionId
        val active = capture
        capture = null
        runCatching { projection?.unregisterCallback(callback) }
        runCatching { projection?.stop() }
        projection = null
        val app = applicationContext
        Thread({
            val store = app.meetingRecordings()
            if (id != null) {
                val result = active?.let { runCatching { it.stop() } }
                if (failure != null) {
                    File(File(app.filesDir, "meeting-recordings"), "meeting-$id.wav").delete()
                    store.fail(id, failure)
                } else if (result != null) {
                    result.onSuccess { value ->
                        val file = File(File(app.filesDir, "meeting-recordings"), "meeting-$id.wav")
                        if (file.isFile && file.length() > MeetingWaveWriter.HEADER_BYTES) {
                            store.complete(id, Instant.now(), value.durationMs, value.microphone, value.systemAudio, file.name, value.warnings)
                            MeetingRecordingUploadWorker.schedule(app)
                        } else store.fail(id, MoteI18n.text("会议录音没有生成可上传的音频"))
                    }.onFailure { store.fail(id, it.message ?: MoteI18n.text("会议录音未完成。")) }
                } else store.fail(id, failure ?: MoteI18n.text("会议录音未完成。"))
            }
            handler.post {
                runningSession = null
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }, "mote-meeting-finish").start()
    }

    override fun onDestroy() {
        if (!stopping) finish(MoteI18n.text("应用停止了会议录音。"))
        super.onDestroy()
    }

    private fun publish() {
        val id = sessionId ?: return
        val session = applicationContext.meetingRecordings().sessions().firstOrNull { it.id == id } ?: return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(session.startedAt))
    }

    private fun notification(startedAt: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("会议录音"), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 4301, Intent(this, MeetingRecordingActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 4302, Intent(this, MeetingRecordingService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val began = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
        return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_mote)
            .setContentTitle(MoteI18n.text("本机会议录音"))
            .setContentText(MoteI18n.text("麦克风与系统音频 · 由你结束"))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setWhen(began).setShowWhen(true).setUsesChronometer(true)
            .addAction(Notification.Action.Builder(null, MoteI18n.text("结束"), stop).build())
            .build()
    }

    companion object {
        private const val CHANNEL = "mote_meeting"
        private const val NOTIFICATION_ID = 4211
        private const val MAX_DURATION_MS = 4L * 60 * 60 * 1000
        private const val ACTION_START = "dev.mote.collector.meeting.START"
        private const val ACTION_STOP = "dev.mote.collector.meeting.STOP"
        private const val EXTRA_SESSION = "session"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        @Volatile internal var runningSession: String? = null

        internal fun start(context: Context, sessionId: String, resultCode: Int, data: Intent) {
            context.startForegroundService(Intent(context, MeetingRecordingService::class.java).setAction(ACTION_START)
                .putExtra(EXTRA_SESSION, sessionId).putExtra(EXTRA_RESULT_CODE, resultCode).putExtra(EXTRA_RESULT_DATA, data))
        }

        internal fun stop(context: Context) {
            context.startService(Intent(context, MeetingRecordingService::class.java).setAction(ACTION_STOP))
        }
    }
}
