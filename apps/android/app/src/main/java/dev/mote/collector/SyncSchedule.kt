package dev.mote.collector

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

/** One scheduling gate for screenshots, notes, source revisions and device heartbeats. */
object SyncSchedule {
    fun pending(context: Context): PendingSync {
        val captures = context.queue().pendingSync(); val sources = context.localSources().pendingSync()
        return PendingSync(captures.count + sources.count, listOfNotNull(captures.oldestAt, sources.oldestAt).minOrNull(), sources.pendingUpdates)
    }
    fun stamp(config: CollectorConfig) = SourceRules.hash(listOf(config.server, config.token, config.syncMode, config.syncIntervalMinutes, config.syncBatchSize, config.wifiOnly).joinToString("\u0000"))
    fun delay(context: Context, config: CollectorConfig, explicit: Boolean = false): Long? {
        if (!config.hasSyncConnection()) return null
        val pending = pending(context)
        return config.syncPolicy().delayMillis(System.currentTimeMillis(), pending.count, pending.oldestAt, Settings(context).lastSyncDispatch(), explicit, pending.pendingUpdates)
    }
    fun constraints(config: CollectorConfig) = Constraints.Builder()
        .setRequiredNetworkType(if (config.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build()
    fun schedule(context: Context, config: CollectorConfig, explicit: Boolean = false) {
        val manager = WorkManager.getInstance(context); val settings = Settings(context)
        if (!config.hasSyncConnection()) {
            listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload").forEach(manager::cancelUniqueWork)
            settings.syncStatus("unconfigured", "仅保存在本机 · 连接节点后可同步")
            return
        }
        if (config.syncMode == "manual") {
            manager.cancelUniqueWork("mote-upload-timer"); manager.cancelUniqueWork("mote-upload-recovery")
            if (!explicit) { if (settings.syncState() !in setOf("uploading", "error", "waiting")) settings.syncStatus("manual", "手动同步 · 记录持续保存在本机"); return }
        } else {
            val periodic = PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES).setConstraints(constraints(config))
                .setInputData(workDataOf("syncStamp" to stamp(config)))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            manager.enqueueUniquePeriodicWork("mote-upload-recovery", ExistingPeriodicWorkPolicy.UPDATE, periodic)
        }
        val wait = delay(context, config, explicit) ?: return
        val request = OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(constraints(config))
            .setInputData(workDataOf("manual" to explicit, "syncStamp" to stamp(config)))
            .setInitialDelay(wait, TimeUnit.MILLISECONDS).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        if (wait == 0L) {
            manager.cancelUniqueWork("mote-upload-timer")
            manager.enqueueUniqueWork("mote-upload", if (explicit) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
        } else {
            if (settings.syncState() != "uploading") settings.syncStatus("waiting", "等待约定同步时间 · 系统省电可能推迟后台运行")
            manager.enqueueUniqueWork("mote-upload-timer", ExistingWorkPolicy.KEEP, request)
        }
    }
}
