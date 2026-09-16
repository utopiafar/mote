package dev.mote.collector

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class RetentionWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try {
        ConnectionGuard.sync { applicationContext.queue().pruneUploaded() }?.let { Result.success() } ?: Result.retry()
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
