package dev.mote.collector

import android.content.Context
import android.os.Looper
import androidx.work.*
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One scheduling gate for screenshots, notes, source revisions and device heartbeats. */
object SyncSchedule {
    private data class Request(val context: Context, val intent: ScheduleIntent)
    private val dispatcher = CoalescingDispatcher<Request>(Executors.newSingleThreadExecutor(),
        merge = { old, next -> next.copy(intent = old.intent.merge(next.intent)) }, action = { request ->
            val app = request.context
            runCatching {
                val ran = ConnectionGuard.sync {
                    val current = Settings(app).read()
                    if (stamp(current) == request.intent.stamp) scheduleNow(app, current, request.intent.explicit)
                }
                if (ran == null && request.intent.explicit) reportBusy(app)
            }.onFailure {
                SupportEvents.record(app, EventStage.UPLOAD, EventCode.SCHEDULER)
                Settings(app).syncStatus("error", "同步调度暂不可用，记录保留在本机，请稍后重试")
            }
        })
    internal fun reportBusy(context: Context) {
        Settings(context).syncStatus("waiting", "正在应用设置，请完成后重试本次扫描或立即同步")
    }
    fun pending(context: Context): PendingSync {
        val captures = context.queue().pendingSync(); val sources = context.localSources().pendingSync(); val files = context.fileArchives().pendingSync()
        return PendingSync(captures.count + sources.count + files.count, listOfNotNull(captures.oldestAt, sources.oldestAt, files.oldestAt).minOrNull(), sources.pendingUpdates)
    }
    fun stamp(config: CollectorConfig) = SourceRules.hash(listOf(config.server, config.token, config.syncMode, config.syncIntervalMinutes, config.syncBatchSize, config.wifiOnly, config.syncChargingOnly, config.syncBatteryNotLow).joinToString("\u0000"))
    fun delay(context: Context, config: CollectorConfig, explicit: Boolean = false): Long? {
        if (!config.hasSyncConnection()) return null
        val pending = pending(context)
        return config.syncPolicy().delayMillis(System.currentTimeMillis(), pending.count, pending.oldestAt, Settings(context).lastSyncDispatch(), explicit, pending.pendingUpdates)
    }
    fun constraints(config: CollectorConfig) = Constraints.Builder()
        .setRequiredNetworkType(if (config.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(config.syncChargingOnly).setRequiresBatteryNotLow(config.syncBatteryNotLow).build()
    fun waitingReason(context: Context, config: CollectorConfig): String? {
        val battery = context.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val status = battery?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
        val charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING || status == android.os.BatteryManager.BATTERY_STATUS_FULL
        val low = battery?.getBooleanExtra(android.os.BatteryManager.EXTRA_BATTERY_LOW, false)
        return SyncConditions(config.syncChargingOnly, config.syncBatteryNotLow, config.wifiOnly)
            .waitingReason(charging, low, !config.wifiOnly || UploadWorker.isWifi(context))
    }

    fun schedule(context: Context, config: CollectorConfig, explicit: Boolean = false) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            val app = context.applicationContext
            // Pending counts can decrypt a large legacy queue or wait for storage recovery.
            // Service ticks and UI actions must never perform that work on the main looper.
            dispatcher.submit(Request(app, ScheduleIntent(stamp(config), explicit)))
            return
        }
        scheduleNow(context, config, explicit)
    }
    fun invalidate() { synchronized(this) { registeredStamp = null }; HeartbeatWorker.invalidate() }
    internal fun continueUpload(context: Context, config: CollectorConfig, explicit: Boolean) {
        val request = OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(constraints(config))
            .setInputData(workDataOf("manual" to explicit, "syncStamp" to stamp(config), "continuation" to true))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("mote-upload", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
    private var registeredStamp: String? = null
    @Synchronized private fun scheduleNow(context: Context, config: CollectorConfig, explicit: Boolean) {
        val manager = WorkManager.getInstance(context); val settings = Settings(context)
        if (!config.hasSyncConnection()) {
            HeartbeatWorker.configure(context, config)
            if (registeredStamp != stamp(config)) {
                listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload").forEach(manager::cancelUniqueWork)
                registeredStamp = stamp(config)
            }
            settings.syncStatus("unconfigured", "仅保存在本机 · 连接节点后可同步")
            return
        }
        HeartbeatWorker.configure(context, config)
        if (config.syncMode == "manual") {
            if (registeredStamp != stamp(config)) {
                manager.cancelUniqueWork("mote-upload-timer"); manager.cancelUniqueWork("mote-upload-recovery")
                registeredStamp = stamp(config)
            }
            if (!explicit) { if (settings.syncState() !in setOf("uploading", "error", "waiting")) settings.syncStatus("manual", "手动同步 · 记录持续保存在本机"); return }
        } else if (registeredStamp != stamp(config)) {
            val periodic = PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES).setConstraints(constraints(config))
                .setInputData(workDataOf("syncStamp" to stamp(config)))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            manager.enqueueUniquePeriodicWork("mote-upload-recovery", ExistingPeriodicWorkPolicy.UPDATE, periodic)
            registeredStamp = stamp(config)
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
