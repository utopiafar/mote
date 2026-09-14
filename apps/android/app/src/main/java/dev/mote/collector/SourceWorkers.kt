package dev.mote.collector

import android.content.Context
import android.os.CancellationSignal
import androidx.work.*
import java.time.Instant
import java.util.concurrent.TimeUnit

class SourceScanWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    private val cancellation = CancellationSignal()
    override fun onStopped() { cancellation.cancel(); super.onStopped() }
    override fun doWork(): Result = ConnectionGuard.sync { work() } ?: Result.retry()
    private fun work(): Result {
        val store = applicationContext.localSources(); val settings = Settings(applicationContext)
        return try {
            for (source in store.sources().filter { it.enabled }) {
                if (isStopped) return Result.retry()
                if (!SourceAccess.available(applicationContext, source)) { store.status(source.id, "permission"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.CONFIGURATION); continue }
                val last = store.state(source.id).optString("lastScan")
                if (!inputData.getBoolean("manual", false) && last.isNotEmpty() && Instant.parse(last).plusSeconds(source.intervalMinutes * 60L).isAfter(Instant.now())) continue
                try {
                    val scan = SourceProviders(applicationContext.contentResolver, cancellation).scan(source)
                    store.scan(source, scan, minOf(64L, settings.read().maxQueueMiB.toLong()) * 1024 * 1024)
                    SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.OK)
                } catch (_: SecurityException) { store.status(source.id, "permission"); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.PERMISSION) }
                catch (_: android.os.OperationCanceledException) { return Result.retry() }
                catch (_: Exception) { store.status(source.id, "provider"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.STORAGE); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.STORAGE) }
            }
            SourceWork.upload(applicationContext)
            Result.success()
        } catch (_: Exception) { SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.STORAGE); Result.retry() }
    }
}

class SourceUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = ConnectionGuard.sync { work() } ?: Result.retry()
    private fun work(): Result {
        val store = applicationContext.localSources(); val settings = Settings(applicationContext)
        var retry = false; var submitted = 0
        return try {
            val config = settings.read(); config.validate(); val target = SourceRules.target(config.server, config.token)
            if (config.wifiOnly && !UploadWorker.isWifi(applicationContext)) return Result.retry()
            for (source in store.sources().filter { it.enabled }) {
                if (isStopped) return Result.retry()
                if (!SourceAccess.available(applicationContext, source)) { store.status(source.id, "permission"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.CONFIGURATION); continue }
                try {
                    fun stillSelected(): Boolean = store.sources().any { it == source && it.enabled } && settings.read().let { SourceRules.target(it.server, it.token) == target }
                    if (!stillSelected()) return Result.retry()
                    store.selectTarget(source.id, target)
                    if (!store.state(source.id).optBoolean("registered")) {
                        val (code, registration) = HttpJson.post("${config.server}/api/sources", source.registration(settings.deviceId), config.token)
                        if (code !in 200..299 || registration?.optString("id") != source.id) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(code), httpStatus = code); store.status(source.id, "http"); retry = true; continue }
                        if (!registration.optBoolean("enabled", true)) { store.status(source.id, "paused"); continue }
                        if (!stillSelected()) return Result.retry()
                        val (patchCode, updated) = HttpJson.request("PATCH", "${config.server}/api/sources/${source.id}",
                            org.json.JSONObject().put("name", source.name).put("retention", source.retention), config.token)
                        if (patchCode !in 200..299 || updated?.optString("id") != source.id) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(patchCode), httpStatus = patchCode); store.status(source.id, "http"); retry = true; continue }
                        store.registered(source.id, target)
                    }
                    while (submitted < 20) {
                        if (isStopped || !stillSelected() || config.wifiOnly && !UploadWorker.isWifi(applicationContext)) return Result.retry()
                        val body = store.next(source.id, target) ?: break
                        val (code, ack) = HttpJson.request("PUT", "${config.server}/api/sources/${source.id}/items", body, config.token)
                        if (code == 409) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.HTTP, httpStatus = code); store.status(source.id, "paused"); break }
                        if (code !in 200..299 || !SourceRules.validAck(source.id, body, ack)) {
                            store.status(source.id, "ack"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(code), httpStatus = code); SupportEvents.record(applicationContext, EventStage.SOURCE, EventJournal.httpFailure(code), httpStatus = code); retry = true; break
                        }
                        store.acknowledge(source.id, target, body.getString("externalId"), body.getString("revision")); submitted++
                        Operations.record(applicationContext, OperationKind.SOURCE_ACK, httpStatus = code)
                        SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.OK, httpStatus = code)
                    }
                    if (store.next(source.id, target) == null) store.status(source.id, "synced")
                    else if (submitted >= 20) retry = true
                } catch (_: Exception) { store.status(source.id, "offline"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.NETWORK); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.NETWORK); retry = true }
            }
            if (retry) Result.retry() else Result.success()
        } catch (_: Exception) { SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.CONFIG_INVALID); Result.retry() }
    }
}

object SourceWork {
    fun schedule(context: Context, manual: Boolean = false) {
        val manager = WorkManager.getInstance(context)
        if (context.localSources().sources().none { it.enabled }) { manager.cancelUniqueWork("mote-source-scan"); manager.cancelUniqueWork("mote-source-periodic"); manager.cancelUniqueWork("mote-source-upload"); return }
        val request = OneTimeWorkRequestBuilder<SourceScanWorker>().setInputData(workDataOf("manual" to manual)).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        // Appends a manual follow-up so a save near the end of an active scan cannot be lost.
        manager.enqueueUniqueWork("mote-source-scan", if (manual) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
        val periodic = PeriodicWorkRequestBuilder<SourceScanWorker>(15, TimeUnit.MINUTES).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        manager.enqueueUniquePeriodicWork("mote-source-periodic", ExistingPeriodicWorkPolicy.UPDATE, periodic)
        upload(context)
    }
    fun upload(context: Context) {
        val config = Settings(context).read()
        if (config.server.isBlank() || config.token.length < 32) return
        val request = OneTimeWorkRequestBuilder<SourceUploadWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(if (config.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("mote-source-upload", ExistingWorkPolicy.KEEP, request)
    }
}
