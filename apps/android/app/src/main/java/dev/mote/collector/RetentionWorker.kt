package dev.mote.collector

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class RetentionWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try {
        ConnectionGuard.sync {
            val historyAvailable = runCatching { applicationContext.captureUploadHistory().prune(UploadHistoryRetention.read(applicationContext)) }
                .onFailure { UploadHistoryRecovery.report(applicationContext) }.isSuccess
            applicationContext.queue().pruneUploaded()
            applicationContext.recordDraftStore().prune { applicationContext.queue().capture(it) != null }
            historyAvailable
        }?.let { if (it) Result.success() else Result.retry() } ?: Result.retry()
    } catch (_: Exception) {
        SupportEvents.record(applicationContext, EventStage.QUEUE, EventCode.STORAGE)
        Result.retry()
    }
    companion object {
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("mote-local-retention", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<RetentionWorker>(1, TimeUnit.HOURS).build())
        }
    }
}
