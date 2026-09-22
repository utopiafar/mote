package dev.mote.collector

import android.content.Context
import android.os.CancellationSignal
import android.os.Looper
import androidx.work.*
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SourceScanWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    private val cancellation = CancellationSignal()
    override fun onStopped() { cancellation.cancel(); super.onStopped() }
    override fun doWork(): Result = ConnectionGuard.sync { work() } ?: Result.retry()
    private fun work(): Result {
        val store = applicationContext.localSources(); val settings = Settings(applicationContext)
        return try {
            settings.ensureDataOrigin(settings.read())
            for (source in store.sources().filter { it.enabled && (inputData.getString("sourceId") == null || it.id == inputData.getString("sourceId")) }) {
                if (isStopped) return Result.retry()
                if (!SourceAccess.available(applicationContext, source)) { store.status(source.id, "permission"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.CONFIGURATION); continue }
                val last = (if (source.binaryFiles()) applicationContext.fileArchives().state(source.id) else store.state(source.id)).optString("lastScan")
                if (!inputData.getBoolean("manual", false) && last.isNotEmpty() && Instant.parse(last).plusSeconds(source.intervalMinutes * 60L).isAfter(Instant.now())) continue
                try {
                    if (source.binaryFiles()) {
                        val complete = FileSources(applicationContext, cancellation).scan(source)
                        store.status(source.id, if (complete) "scanned" else "partial")
                        if (!complete) SourceWork.continueScan(applicationContext, source.id, inputData.getBoolean("syncExplicit", false))
                        continue
                    }
                    val scan = SourceProviders(applicationContext.contentResolver, cancellation).scan(source)
                    store.scan(source, scan, minOf(64L, settings.read().maxQueueMiB.toLong()) * 1024 * 1024)
                    SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.OK)
                } catch (_: SecurityException) { store.status(source.id, "permission"); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.PERMISSION) }
                catch (_: android.os.OperationCanceledException) { return Result.retry() }
                catch (_: Exception) { store.status(source.id, "provider"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.STORAGE); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.STORAGE) }
            }
            SourceWork.upload(applicationContext, inputData.getBoolean("syncExplicit", false))
            Result.success()
        } catch (_: Exception) { SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.STORAGE); Result.retry() }
    }
}

class SourceUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = ConnectionGuard.sync { work() } ?: Result.retry()
    private fun work(): Result {
        val store = applicationContext.localSources(); val settings = Settings(applicationContext)
        var failed = false; var more = false; var delayedFiles = false
        val manualOnly = settings.read().syncMode == "manual" && inputData.getBoolean("manual", false)
        fun failure(): Result {
            settings.syncStatus("error", MoteI18n.text("部分来源尚未同步，记录保留在本机；{0}", if (manualOnly) MoteI18n.text("请再次点击立即同步") else MoteI18n.text("稍后自动重试")))
            return if (manualOnly) Result.failure() else Result.retry()
        }
        return try {
            val config = settings.read(); val explicit = inputData.getBoolean("manual", false)
            if (!config.hasSyncConnection() || (config.syncMode == "manual" && !explicit)) return Result.success()
            if (inputData.getString("syncStamp") != SyncSchedule.stamp(config)) return Result.success()
            config.validate(); config.validateConnection(); val target = SourceRules.target(config.server, config.token)
            SyncSchedule.waitingReason(applicationContext, config)?.let { settings.syncStatus("waiting", it); return Result.retry() }
            settings.syncStatus("uploading", MoteI18n.text("正在同步来源记录"))
            val rotation = applicationContext.getSharedPreferences("source-upload-turns", Context.MODE_PRIVATE)
            val after = if (rotation.getString("target", null) == target) rotation.getString("after", null) else null
            val dispatch = UploadSlice(maxBytes = 8L * 1024 * 1024, maxRequests = 128)
            for (source in rotateUploadSources(store.sources().filter { it.enabled }, after) { it.id }) {
                if (dispatch.exhausted) { more = true; break }
                val slice = UploadSlice(); var submitted = 0
                rotation.edit().putString("target", target).putString("after", source.id).apply()
                if (isStopped) return Result.retry()
                SyncSchedule.waitingReason(applicationContext, config)?.let { settings.syncStatus("waiting", it); return Result.retry() }
                if (!SourceAccess.available(applicationContext, source)) { store.status(source.id, "permission"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.CONFIGURATION); continue }
                try {
                    fun stillSelected(): Boolean = !isStopped && !ConnectionGuard.reconfiguring() && store.sources().any { it == source && it.enabled } && settings.read().let { SourceRules.target(it.server, it.token) == target }
                    if (!stillSelected()) return Result.retry()
                    store.selectTarget(source.id, target)
                    if (!store.state(source.id).optBoolean("registered")) {
                        val registrationBody = source.registration(settings.deviceId)
                        slice.record(registrationBody.toString().toByteArray(Charsets.UTF_8).size.toLong())
                        val (code, registration) = HttpJson.post("${config.server}/api/sources", registrationBody, config.token)
                        if (code !in 200..299 || registration?.optString("id") != source.id) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(code), httpStatus = code); store.status(source.id, "http"); failed = true; continue }
                        if (!registration.optBoolean("enabled", true)) { store.status(source.id, "paused"); continue }
                        if (!stillSelected()) return Result.retry()
                        val patch = org.json.JSONObject().put("name", source.name).put("initialSync", source.initialSync).put("retention", source.retention)
                        slice.record(patch.toString().toByteArray(Charsets.UTF_8).size.toLong())
                        val (patchCode, updated) = HttpJson.request("PATCH", "${config.server}/api/sources/${source.id}", patch, config.token)
                        if (patchCode !in 200..299 || updated?.optString("id") != source.id) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(patchCode), httpStatus = patchCode); store.status(source.id, "http"); failed = true; continue }
                        store.registered(source.id, target)
                    }
                    if (source.binaryFiles()) {
                        val finished = FileUpload.sync(applicationContext, source, config, slice, ::stillSelected)
                        if (!finished) { more = true; if (applicationContext.fileArchives().next(source.id) == null) delayedFiles = true }
                        store.status(source.id, if (finished) "synced" else "scanned")
                        if (finished) settings.syncStatus("uploading", if (source.retention == "archive") MoteI18n.text("文件原件已归档；手机原文件保留") else MoteI18n.text("文件索引或目录已同步；原件留本机"), uploaded = true)
                        continue
                    }
                    while (submitted < 20 && !slice.exhausted) {
                        if (isStopped || !stillSelected()) return Result.retry()
                        SyncSchedule.waitingReason(applicationContext, config)?.let { settings.syncStatus("waiting", it); return Result.retry() }
                        val body = store.next(source.id, target) ?: break
                        if (!slice.admit(body.toString().toByteArray(Charsets.UTF_8).size)) break
                        val (code, ack) = HttpJson.request("PUT", "${config.server}/api/sources/${source.id}/items", body, config.token)
                        if (code == 409) { Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.HTTP, httpStatus = code); store.status(source.id, "paused"); break }
                        if (code !in 200..299 || !SourceRules.validAck(source.id, body, ack)) {
                            store.status(source.id, "ack"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, Operations.httpReason(code), httpStatus = code); SupportEvents.record(applicationContext, EventStage.SOURCE, EventJournal.httpFailure(code), httpStatus = code); failed = true; break
                        }
                        store.acknowledge(source.id, target, body.getString("externalId"), body.getString("revision")); submitted++
                        settings.syncStatus("uploading", MoteI18n.text("正在同步来源记录"), uploaded = true)
                        Operations.record(applicationContext, OperationKind.SOURCE_ACK, httpStatus = code)
                        SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.OK, httpStatus = code)
                    }
                    if (store.next(source.id, target) == null) store.status(source.id, "synced")
                    else if (submitted >= 20 || slice.exhausted) more = true
                } catch (_: Exception) { store.status(source.id, "offline"); Operations.record(applicationContext, OperationKind.SOURCE_FAILED, OperationReason.NETWORK); SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.NETWORK); failed = true }
                finally { dispatch.record(slice.bytes, slice.requests) }
            }
            if (failed) failure()
            else if (more) { SourceWork.enqueueUpload(applicationContext, settings.read(), inputData.getBoolean("manual", false), continuation = true, delaySeconds = if (delayedFiles) 60 else 0); Result.success() }
            else {
                SyncHealth.finish(applicationContext)
                // Explicit source sync has its own final report because manual mode sends no later automatic heartbeat.
                SyncHeartbeat.send(applicationContext, settings, config, applicationContext.queue())
                Result.success()
            }
        } catch (_: Exception) { SupportEvents.record(applicationContext, EventStage.SOURCE, EventCode.CONFIG_INVALID); failure() }
    }
}

object SourceWork {
    private data class Request(val context: Context, val intent: ScheduleIntent)
    private val dispatcher = CoalescingDispatcher<Request>(Executors.newSingleThreadExecutor(),
        merge = { old, next -> next.copy(intent = old.intent.merge(next.intent)) }, action = { request ->
            val app = request.context
            runCatching {
                val ran = ConnectionGuard.sync {
                    if (SyncSchedule.stamp(Settings(app).read()) == request.intent.stamp)
                        schedule(app, request.intent.manualScan, request.intent.explicit)
                }
                if (ran == null && (request.intent.explicit || request.intent.manualScan)) SyncSchedule.reportBusy(app)
            }.onFailure { SupportEvents.record(app, EventStage.SOURCE, EventCode.SCHEDULER) }
        })
    fun schedule(context: Context, manual: Boolean = false, syncExplicit: Boolean = false) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            val app = context.applicationContext
            dispatcher.submit(Request(app, ScheduleIntent(SyncSchedule.stamp(Settings(app).read()), syncExplicit, manual)))
            return
        }
        val manager = WorkManager.getInstance(context)
        if (context.localSources().sources().none { it.enabled }) { manager.cancelUniqueWork("mote-source-scan"); manager.cancelUniqueWork("mote-source-periodic"); manager.cancelUniqueWork("mote-source-upload"); return }
        val request = OneTimeWorkRequestBuilder<SourceScanWorker>().setInputData(workDataOf("manual" to manual, "syncExplicit" to syncExplicit)).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        // Appends a manual follow-up so a save near the end of an active scan cannot be lost.
        manager.enqueueUniqueWork("mote-source-scan", if (manual) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
        val periodic = PeriodicWorkRequestBuilder<SourceScanWorker>(15, TimeUnit.MINUTES).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        manager.enqueueUniquePeriodicWork("mote-source-periodic", ExistingPeriodicWorkPolicy.UPDATE, periodic)
        if (!syncExplicit) upload(context)
    }
    internal fun continueScan(context: Context, id: String, explicit: Boolean) {
        val request = OneTimeWorkRequestBuilder<SourceScanWorker>().setInitialDelay(1, TimeUnit.SECONDS)
            .setInputData(workDataOf("manual" to true, "syncExplicit" to explicit, "sourceId" to id)).build()
        WorkManager.getInstance(context).enqueueUniqueWork("mote-source-scan", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
    fun upload(context: Context, explicit: Boolean = false) = UploadWorker.schedule(context, Settings(context).read(), explicit)
    internal fun enqueueUpload(context: Context, config: CollectorConfig, explicit: Boolean, continuation: Boolean = false, delaySeconds: Long = 0) {
        if (context.localSources().sources().none { it.enabled }) return
        val request = OneTimeWorkRequestBuilder<SourceUploadWorker>().setInitialDelay(delaySeconds, TimeUnit.SECONDS).setConstraints(SyncSchedule.constraints(config))
            .setInputData(workDataOf("manual" to explicit, "syncStamp" to SyncSchedule.stamp(config)))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("mote-source-upload", if (continuation) ExistingWorkPolicy.APPEND_OR_REPLACE else if (explicit) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
    }
}
