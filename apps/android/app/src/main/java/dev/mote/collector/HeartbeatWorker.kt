package dev.mote.collector

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

/** Independent low-frequency liveness. Never starts a data-upload session. */
class HeartbeatWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = ConnectionGuard.sync {
        val settings = Settings(applicationContext)
        val config = settings.read()
        if (!config.hasSyncConnection() || config.syncMode == "manual") return@sync Result.success()
        if (inputData.getString("syncStamp") != SyncSchedule.stamp(config)) return@sync Result.success()
        try {
            config.validateConnection()
            if (SyncSchedule.waitingReason(applicationContext, config) != null) return@sync Result.retry()
            val sent = SyncHeartbeat.send(applicationContext, settings, config, applicationContext.queue())
            if (!sent && inputData.getBoolean("stateChange", false)) Result.retry() else Result.success()
        } catch (_: Exception) { Result.retry() }
    } ?: Result.retry()

    companion object {
        private var configured: String? = null
        private var lastRequest = 0L
        private var requestedState: String? = null
        @Synchronized fun invalidate() { configured = null; requestedState = null; lastRequest = 0 }
        @Synchronized fun configure(context: Context, config: CollectorConfig) {
            val stamp = SyncSchedule.stamp(config)
            if (configured == stamp) return
            val work = WorkManager.getInstance(context)
            if (!config.hasSyncConnection() || config.syncMode == "manual") {
                work.cancelUniqueWork("mote-heartbeat"); work.cancelUniqueWork("mote-heartbeat-now")
            } else {
                val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(SyncSchedule.constraints(config)).setInputData(workDataOf("syncStamp" to stamp))
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
                work.enqueueUniquePeriodicWork("mote-heartbeat", ExistingPeriodicWorkPolicy.UPDATE, request)
            }
            configured = stamp
        }
        @Synchronized fun stateChanged(context: Context, config: CollectorConfig) {
            configure(context, config)
            if (!config.hasSyncConnection() || config.syncMode == "manual") return
            val settings = Settings(context)
            val state = "${settings.enabled}:${settings.state()}:${SyncSchedule.stamp(config)}"
            val now = android.os.SystemClock.elapsedRealtime()
            if (requestedState == state) return
            val request = OneTimeWorkRequestBuilder<HeartbeatWorker>().setConstraints(SyncSchedule.constraints(config))
                .setInputData(workDataOf("syncStamp" to SyncSchedule.stamp(config), "stateChange" to true))
                .setInitialDelay(if (lastRequest == 0L) 0 else (60_000 - (now - lastRequest)).coerceAtLeast(0), TimeUnit.MILLISECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("mote-heartbeat-now", ExistingWorkPolicy.REPLACE, request)
            requestedState = state; lastRequest = now
        }
    }
}
