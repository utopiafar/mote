package dev.mote.collector.meeting

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.mote.collector.Settings
import dev.mote.collector.SyncConditionsUnavailable
import dev.mote.collector.SyncSchedule
import dev.mote.collector.UnifiedCentralSession
import dev.mote.collector.localContentCipher
import java.io.File
import java.util.concurrent.TimeUnit

internal fun Context.meetingRecordings(): MeetingRecordingStore = MeetingRecordingStore(File(filesDir, "meeting-recordings"), localContentCipher())

/** The collector identity may upload finished audio, but no central token or MCP
 * route can create, start or stop a meeting session. */
internal object MeetingRecordingUploader {
    internal val active = java.util.concurrent.atomic.AtomicBoolean(false)
    fun flush(context: Context): Boolean {
        if (!active.compareAndSet(false, true)) return false
        try {
            val settings = Settings(context); val config = settings.read()
            if (!config.hasSyncConnection() || config.syncPaused || MeetingRecordingService.runningSession != null) return false
            val lease = dev.mote.collector.ConnectionLease(context, config)
            lease.requireCurrent()
            val client = UnifiedCentralSession(context).client(config.server.trim().trimEnd('/')) ?: return false
            val directory = File(context.filesDir, "meeting-recordings")
            return MeetingArchiveTransfer(context.meetingRecordings(), directory, settings.deviceId, config.server.trim().trimEnd('/'),
                client, lease::requireCurrent, lease::commit).flush()
        } finally { active.set(false) }
    }
}

class MeetingRecordingUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        MeetingRecordingUploader.flush(applicationContext)
        Result.success()
    } catch (_: SyncConditionsUnavailable) {
        Result.retry()
    } catch (_: Exception) {
        if (runAttemptCount >= 8) Result.failure() else Result.retry()
    }

    companion object {
        private const val WORK = "mote-meeting-recording-upload"
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<MeetingRecordingUploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP, request)
        }

        fun scheduleIfPending(context: Context) {
            if (context.meetingRecordings().sessions().any { it.state == "recording" || it.state == "completed" }) schedule(context)
        }
    }
}
