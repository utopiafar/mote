package dev.mote.collector
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit
/** Pull durable, individually confirmed deliveries. No model, capture or unconfirmed write. */
class CalendarActionWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val config = Settings(applicationContext).read()
        if (!config.hasSyncConnection() || config.syncMode == "manual" || !CalendarActions(applicationContext).permissions()) return Result.success()
        if (SyncSchedule.waitingReason(applicationContext, config) != null) return Result.retry()
        return try { CalendarActions(applicationContext).deliver(); Result.success() } catch (_: Exception) { Result.retry() }
    }
    companion object {
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("mote-calendar-delivery", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<CalendarActionWorker>(15, TimeUnit.MINUTES).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        }
    }
}
