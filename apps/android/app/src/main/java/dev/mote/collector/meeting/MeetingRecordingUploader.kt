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
import dev.mote.collector.CentralClient
import dev.mote.collector.Settings
import dev.mote.collector.SyncConditionsUnavailable
import dev.mote.collector.SyncSchedule
import dev.mote.collector.UnifiedCentralSession
import dev.mote.collector.localContentCipher
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

internal fun Context.meetingRecordings(): MeetingRecordingStore = MeetingRecordingStore(File(filesDir, "meeting-recordings"), localContentCipher())

/** The collector identity may upload finished audio, but no central token or MCP
 * route can create, start or stop a meeting session. */
internal object MeetingRecordingUploader {
    fun flush(context: Context): Boolean {
        val settings = Settings(context)
        val config = settings.read()
        if (!config.hasSyncConnection() || config.syncPaused) return false
        SyncSchedule.requireConditions(context, config)
        val client = UnifiedCentralSession(context).client(config.server.trim().trimEnd('/')) ?: return false
        if (MeetingRecordingService.runningSession != null) return false
        val store = context.meetingRecordings()
        val pending = store.recovery()
        if (pending.isEmpty()) return true
        client.post("/api/sources", MeetingRecordingItems.registration(settings.deviceId))
        for (session in pending) {
            val name = session.audioFile ?: continue
            val file = File(File(context.filesDir, "meeting-recordings"), name).takeIf { it.isFile } ?: continue
            if (file.length() !in 1..MAX_BYTES) { store.fail(session.id, "会议录音音频超出中央单文件上限或不可读"); continue }
            val digest = MeetingRecordingItems.digest(file)
            val manifest = MeetingRecordingItems.manifest(settings.deviceId, session, file.length(), digest)
            val begun = client.post("/api/file-sync/v1/uploads", manifest)
            val existingCapture = begun.optJSONObject("ack")?.optString("id").orEmpty()
            if (existingCapture.isNotBlank()) { finish(store, session, existingCapture, file); continue }
            val uploadId = begun.getString("uploadId"); UUID.fromString(uploadId)
            check(begun.getInt("partBytes") == PART_BYTES)
            val parts = begun.optJSONArray("parts") ?: JSONArray()
            val received = (0 until parts.length()).map { parts.getJSONObject(it).getInt("part") }.toSet()
            val total = ((file.length() + PART_BYTES - 1) / PART_BYTES).toInt()
            file.inputStream().use { input ->
                repeat(total) { part ->
                    val length = minOf(PART_BYTES.toLong(), file.length() - part.toLong() * PART_BYTES).toInt()
                    val bytes = ByteArray(length)
                    var offset = 0
                    while (offset < bytes.size) { val count = input.read(bytes, offset, bytes.size - offset); check(count > 0); offset += count }
                    if (part !in received) {
                        val response = client.bytes("PUT", "/api/file-sync/v1/uploads/$uploadId/parts/$part", bytes, "application/octet-stream")
                        check(response.getInt("part") == part && response.getInt("bytes") == bytes.size)
                    }
                }
            }
            val committed = client.post("/api/file-sync/v1/uploads/$uploadId/commit", JSONObject())
            val captureId = committed.optString("id")
            check(captureId.isNotBlank()) { "中央未确认会议录音入库" }
            finish(store, session, captureId, file)
        }
        return true
    }

    private fun finish(store: MeetingRecordingStore, session: MeetingSession, captureId: String, file: File) {
        store.markUploaded(session.id, captureId)
        file.delete()
    }

    private const val PART_BYTES = 4 * 1024 * 1024
    private const val MAX_BYTES = 512L * 1024 * 1024
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
