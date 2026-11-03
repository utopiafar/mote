package dev.mote.collector.plugins

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import dev.mote.collector.BatchUpload
import dev.mote.collector.CaptureAttemptStore
import dev.mote.collector.CaptureReceiptFinalizer
import dev.mote.collector.CaptureReceiptStore
import dev.mote.collector.CaptureUploadAttempts
import dev.mote.collector.CaptureUploadHistory
import dev.mote.collector.CaptureUploadReceipt
import dev.mote.collector.CollectorConfig
import dev.mote.collector.DurableQueue
import dev.mote.collector.HeartbeatWorker
import dev.mote.collector.ItemUploadHistory
import dev.mote.collector.ItemUploadSession
import dev.mote.collector.LocalDataFormat
import dev.mote.collector.LocalStatusProducer
import dev.mote.collector.LoginProcess
import dev.mote.collector.MoteI18n
import dev.mote.collector.QueueStorage
import dev.mote.collector.Settings
import dev.mote.collector.SyncRecoveryWorker
import dev.mote.collector.SyncSchedule
import dev.mote.collector.TransportInventory
import dev.mote.collector.UploadHistoryRecovery
import dev.mote.collector.UploadHistoryRetention
import dev.mote.collector.fileArchives
import dev.mote.collector.localSources
import dev.mote.collector.secretBox
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Build-native durable transport provider. The plugin owns the active queue
 * handle, upload scheduling, receipt finalization, recovery work and the single
 * local status producer. WorkManager only instantiates the workers; their
 * dependencies and lifecycle stay here. */
internal fun NativePluginRegistry.registerDurableTransport(buildId: String) {
    register(NativePluginProvider("mote.durable-upload", "1", buildId = buildId))
}

/** The result of one logical upload attempt. Receipts are already durably
 * completed before this is returned, exactly as the worker observes them. */
internal data class CaptureSendOutcome(
    val response: Pair<Int, JSONObject?>,
    val receipts: Map<String, Int>,
    val acknowledged: Int,
)

/** Pure transport slice used by the worker and native contracts. It owns the
 * attempt journal and turns acknowledged response entries into exactly-once
 * receipt completions; a duplicate receipt is idempotent. */
internal class DurableCaptureTransport(
    private val queue: DurableQueue,
    private val receiptStore: CaptureReceiptStore,
    private val attemptStore: CaptureAttemptStore,
    private val scope: String,
    private val origin: String,
    private val deviceId: String,
    private val batchId: String,
    private val process: String = LoginProcess.id,
    private val now: () -> Long = System::currentTimeMillis,
    private val retentionDays: Int = UploadHistoryRetention.DEFAULT_DAYS,
) {
    private val attempts = CaptureUploadAttempts(attemptStore, batchId, scope, process, now)

    fun send(
        events: List<JSONObject>,
        originals: List<JSONObject> = events,
        individual: Boolean,
        bytes: Long,
        send: () -> Pair<Int, JSONObject?>,
    ): CaptureSendOutcome {
        val response = attempts.send(events, bytes, individual, originals, send)
        val receipts = if (individual) {
            if (response.first in 200..201) mapOf(events.single().getString("id") to response.first) else emptyMap()
        } else if (response.first == 200) {
            BatchUpload.receipts(events.map { it.getString("id") }.toSet(), response.second)
        } else emptyMap()
        var acknowledged = 0
        for (event in events) {
            val id = event.getString("id")
            if (receipts[id] !in 200..201) continue
            val original = originals.single { it.getString("id") == id }
            CaptureReceiptFinalizer(receiptStore).received(queue, CaptureUploadReceipt.create(
                origin, deviceId, original, event, batchId, now(), retentionDays,
            ))
            acknowledged++
        }
        return CaptureSendOutcome(response, receipts, acknowledged)
    }
}

internal class DurableTransportPlugin private constructor(
    context: Context,
    private val scope: PluginOwnerSession,
) {
    private val app = context.applicationContext
    val localStatus = LocalStatusProducer(app)
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)

    init {
        scope.registerService(PluginServiceRegistration("durable-queue", "mote.durable-upload.queue"))
        scope.registerService(PluginServiceRegistration("local-status", "mote.durable-upload.local-status"))
        scope.registerJob(PluginJob("durable-transport", durable = true, drain = { close() }))
        scope.defer { close() }
    }

    internal fun startOwned() { localStatus.start() }

    /** The active queue handle. A location change is resolved on every open, so
     * no stale directory survives a migration. */
    fun openQueue(): DurableQueue {
        check(!closed.get()) { "Durable transport plugin is closed" }
        return QueueStorage(app).openQueue().apply { archiveOrigin = Settings(app).dataOrigin() }
    }

    fun captureHistory(): CaptureUploadHistory {
        check(!closed.get()) { "Durable transport plugin is closed" }
        LocalDataFormat.requireCurrent(app)
        return CaptureUploadHistory(File(app.noBackupFilesDir, "upload-history/received.sqlite"), app.secretBox())
    }

    fun itemHistory(): ItemUploadHistory {
        check(!closed.get()) { "Durable transport plugin is closed" }
        LocalDataFormat.requireCurrent(app)
        return ItemUploadHistory(File(app.noBackupFilesDir, "upload-history/items.sqlite"), app.secretBox())
    }

    fun uploadSession(config: CollectorConfig, batchId: String = UUID.randomUUID().toString(), lane: String): ItemUploadSession =
        ItemUploadSession(app, config, batchId, lane)

    fun scheduleUpload(config: CollectorConfig, manual: Boolean = false) = SyncSchedule.schedule(app, config, manual)

    fun heartbeat() = HeartbeatWorker.stateChanged(app, Settings(app).read())

    fun restoreHistory(queue: DurableQueue, settings: Settings): Boolean = UploadHistoryRecovery.restore(app, queue, settings)

    /** Recover receipts and interrupted attempts for the current connection before
     * any worker or explicit replay selects a batch. */
    fun recoverReceipts(queue: DurableQueue, config: CollectorConfig, includeCurrentProcess: Boolean = false) {
        val history = captureHistory()
        val scope = CaptureUploadReceipt.scope(config.server.trim().trimEnd('/'), Settings(app).deviceId)
        history.prune(UploadHistoryRetention.read(app))
        history.recoverInterrupted(scope, LoginProcess.id, includeCurrentProcess)
        CaptureReceiptFinalizer(history).recover(queue, scope)
        UploadHistoryRecovery.available()
    }

    /** Prepare the current connection's transport and recover interrupted receipts
     * before the worker selects its first batch. */
    fun captureTransport(queue: DurableQueue, config: CollectorConfig, batchId: String): DurableCaptureTransport {
        val origin = config.server.trim().trimEnd('/')
        val deviceId = Settings(app).deviceId
        val history = captureHistory()
        history.prune(UploadHistoryRetention.read(app))
        val scope = CaptureUploadReceipt.scope(origin, deviceId)
        history.recoverInterrupted(scope, LoginProcess.id, includeCurrentProcess = true)
        CaptureReceiptFinalizer(history).recover(queue, scope)
        UploadHistoryRecovery.available()
        return DurableCaptureTransport(queue, history, history, scope, origin, deviceId, batchId,
            retentionDays = config.uploadedRetentionDays)
    }

    /** Generated contract test seam: the same owned transport with an injected
     * history directory and origin. Production always uses captureTransport(). */
    internal fun captureTransport(queue: DurableQueue, history: CaptureUploadHistory, origin: String, deviceId: String,
                                  batchId: String, retentionDays: Int): DurableCaptureTransport {
        val normalized = origin.trim().trimEnd('/')
        return DurableCaptureTransport(queue, history, history, CaptureUploadReceipt.scope(normalized, deviceId),
            normalized, deviceId, batchId, retentionDays = retentionDays)
    }

    fun startRecovery(replay: Boolean) {
        check(!closed.get()) { "Durable transport plugin is closed" }
        val config = Settings(app).read(); config.validateConnection()
        val request = OneTimeWorkRequestBuilder<SyncRecoveryWorker>().setConstraints(SyncSchedule.constraints(config, explicit = true))
            .setInputData(workDataOf("replay" to replay, "syncStamp" to SyncSchedule.stamp(config)))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(app).enqueueUniqueWork("mote-sync-recovery", ExistingWorkPolicy.KEEP, request)
        app.getSharedPreferences("sync-recovery", Context.MODE_PRIVATE).edit()
            .putString("message", MoteI18n.text("操作已请求；重复点击会合并，等待网络条件或当前操作完成")).apply()
    }

    fun inventory(): TransportInventory = TransportInventory(
        openQueue().pendingSync(), app.localSources().pendingSync(), app.fileArchives().pendingSync(),
    )

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        localStatus.close()
        synchronized(Companion) { if (instance === this) instance = null }
    }

    companion object {
        @Volatile private var instance: DurableTransportPlugin? = null

        /** Start the one application-scoped transport owner. Repeating startup
         * returns the same owner instead of creating a second queue/status producer. */
        fun start(context: Context, host: NativePluginHost): DurableTransportPlugin = synchronized(this) {
            instance?.let { return it }
            val identity = PluginInstanceIdentity("mote.durable-upload", "builtin:mote.durable-upload", "mote.durable-upload")
            val descriptor = PluginInstanceDescriptor(
                identity,
                setOf("transport", "local-status"),
                requires = listOf(NativeRequirement("mote.durable-upload", "1")),
            )
            val scope = when (val admitted = host.createScope(descriptor)) {
                is PluginResult.Ok -> admitted.value
                is PluginResult.Failed -> error("${admitted.code}: ${admitted.message}")
            }
            val plugin = try {
                when (val result = host.startPlugin(scope) { DurableTransportPlugin(context, scope) }) {
                    is PluginResult.Ok -> result.value
                    is PluginResult.Failed -> error("${result.code}: ${result.message}")
                }
            } catch (error: Throwable) {
                host.stopScope(identity.instanceId)
                throw error
            }
            instance = plugin
            try { plugin.startOwned() }
            catch (error: Throwable) {
                plugin.close()
                host.stopScope(identity.instanceId)
                throw error
            }
            plugin
        }

        fun get(context: Context): DurableTransportPlugin = instance
            ?: error("Durable transport plugin is not started")
    }
}
