package dev.mote.collector

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

object HttpJson {
    fun post(url: String, body: JSONObject, token: String? = null): Pair<Int, JSONObject?> = request("POST", url, body, token)
    fun get(url: String, token: String? = null): Pair<Int, JSONObject?> = request("GET", url, null, token)
    fun request(method: String, url: String, body: JSONObject?, token: String? = null): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false // Never leak owner tokens through redirects.
            connection.doOutput = body != null
            connection.setRequestProperty("Content-Type", "application/json")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= 256 * 1024) { "响应超过 256 KiB" }
                    output.write(buffer, 0, count)
                }
                output.toString("UTF-8")
            }
            return code to response?.let { runCatching { JSONObject(it) }.getOrNull() }
        } finally { connection.disconnect() }
    }
}

private class RecordedHeartbeatFailure : IllegalStateException()

class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = ConnectionGuard.sync { work() } ?: Result.retry()
    private fun work(): Result {
        val settings = Settings(applicationContext)
        var stage = EventStage.CONFIG
        var pendingRecordId: String? = null
        val manualOnly = settings.read().syncMode == "manual" && inputData.getBoolean("manual", false)
        fun failed(message: String, retryable: Boolean = true): Result {
            settings.syncStatus("error", "$message；记录保留在本机，${if (manualOnly || !retryable) "请处理后点击立即同步" else "稍后自动重试"}")
            return if (manualOnly || !retryable) Result.failure() else Result.retry()
        }
        return try {
            val config = settings.read()
            val explicit = inputData.getBoolean("manual", false)
            if (!config.hasSyncConnection()) { settings.syncStatus("unconfigured", "仅保存在本机 · 尚未配置完整连接"); return Result.success() }
            if (config.syncMode == "manual" && !explicit) { settings.syncStatus("manual", "手动同步 · 记录持续保存在本机"); return Result.success() }
            val requestedStamp = inputData.getString("syncStamp")
            if (requestedStamp != null && requestedStamp != SyncSchedule.stamp(config)) { SyncSchedule.schedule(applicationContext, config); return Result.success() }
            config.validate(); config.validateConnection()
            if (runAttemptCount == 0 && !inputData.getBoolean("continuation", false) && (SyncSchedule.delay(applicationContext, config, explicit) ?: Long.MAX_VALUE) > 0) {
                SyncSchedule.schedule(applicationContext, config); return Result.success()
            }
            if (runAttemptCount == 0 && !inputData.getBoolean("continuation", false)) settings.syncDispatched(System.currentTimeMillis())
            SyncSchedule.waitingReason(applicationContext, config)?.let {
                settings.syncStatus("waiting", it); return Result.retry()
            }
            stage = EventStage.QUEUE
            val queue = applicationContext.queue()
            settings.syncStatus("uploading", "正在同步本机记录")
            if (!inputData.getBoolean("continuation", false)) SourceWork.enqueueUpload(applicationContext, config, explicit)
            stage = EventStage.HEARTBEAT
            SyncHeartbeat.send(applicationContext, settings, config, queue)
            repeat(25) {
                if (isStopped || ConnectionGuard.reconfiguring()) return Result.retry()
                SyncSchedule.waitingReason(applicationContext, config)?.let {
                    settings.syncStatus("waiting", it); return Result.retry()
                }
                stage = EventStage.QUEUE
                val ocrUpdate = queue.nextOcrUpdate()
                if (ocrUpdate != null) {
                    stage = EventStage.UPLOAD
                    val id = ocrUpdate.getString("id"); pendingRecordId = id
                    val body = JSONObject().put("ocrText", ocrUpdate.getString("ocrText")).put("status", ocrUpdate.getString("status"))
                    val (code, response) = HttpJson.post("${config.server}/api/capture-browser/$id/ocr", body, config.token)
                    if ((code == 404 && response?.optString("error") == "capture_not_found") || code == 410) {
                        queue.archiveMissing(id); pendingRecordId = null
                        settings.syncStatus("error", "中央记录已不可更新；本机保留图片和失败状态，不会重新创建记录")
                        return@repeat
                    }
                    if (code == 409) {
                        queue.ocrConflict(id); pendingRecordId = null
                        settings.syncStatus("error", "OCR 更新与中央记录冲突；本机图片和文字已保留，请在采集记录中查看")
                        return@repeat
                    }
                    if (code !in 200..299 || response?.optString("id") != id) return failed(if (code == 404) "中央节点可能需要升级，OCR 结果已保留" else "OCR 更新未确认（HTTP $code）")
                    Diagnostics(applicationContext).add("uploadBytes", body.toString().toByteArray(Charsets.UTF_8).size.toLong())
                    queue.acknowledgeOcr(id); pendingRecordId = null
                    settings.syncStatus("uploading", "文字识别已更新至中央归档", uploaded = true)
                    return@repeat
                }
                val event = queue.peek() ?: run {
                    stage = EventStage.HEARTBEAT
                    finishStatus()
                    SyncHeartbeat.send(applicationContext, settings, config, queue)
                    return Result.success()
                }
                stage = EventStage.UPLOAD
                pendingRecordId = event.getString("id")
                val (code, response) = HttpJson.post("${config.server}/api/captures", event, config.token)
                if (code == 409) {
                    queue.uploadConflict(event.getString("id")); pendingRecordId = null
                    settings.syncStatus("error", "记录 ID 与中央内容冲突；保留本机副本，继续发送其他记录")
                    return@repeat
                }
                if (code == 410) {
                    queue.archiveMissing(event.getString("id")); pendingRecordId = null
                    settings.syncStatus("error", "中央记录已删除；本机保留图片和失败状态，不会重新创建记录")
                    return@repeat
                }
                if (code !in setOf(200, 201) || response?.optString("id") != event.getString("id")) {
                    SupportEvents.record(applicationContext, stage, EventJournal.httpFailure(code), httpStatus = code)
                    Operations.record(applicationContext, OperationKind.UPLOAD_RETRY, Operations.httpReason(code), httpStatus = code, recordId = pendingRecordId)
                    return failed(if (code == 400 && event.has("ocr")) "当前截图协议未被接受，请先确认中央节点已升级至 0.0.2 或更新版本" else "上传未确认（HTTP $code）", retryable = code !in setOf(400, 401, 403, 413))
                }
                Diagnostics(applicationContext).add("uploadBytes", event.toString().toByteArray(Charsets.UTF_8).size.toLong())
                stage = EventStage.QUEUE
                queue.acknowledge(event.getString("id"), event.toString().toByteArray(Charsets.UTF_8).size.toLong())
                SupportEvents.record(applicationContext, EventStage.UPLOAD, EventCode.OK, httpStatus = code)
                pendingRecordId = null
                settings.syncStatus("uploading", "已确认上传；待同步 ${SyncSchedule.pending(applicationContext).count} 条", uploaded = true)
            }
            stage = EventStage.HEARTBEAT
            if (!queue.pendingSync().hasWork) finishStatus()
            SyncHeartbeat.send(applicationContext, settings, config, queue)
            // A successful chunk may continue the same explicit operation; failures never retry in manual mode.
            if (queue.pendingSync().hasWork) SyncSchedule.continueUpload(applicationContext, config, explicit)
            Result.success()
        } catch (error: Exception) {
            SupportEvents.record(applicationContext, stage, EventJournal.failure(error, stage))
            if (error !is RecordedHeartbeatFailure) Operations.record(applicationContext, OperationKind.UPLOAD_RETRY, Operations.failure(error, stage), recordId = pendingRecordId)
            failed("同步失败，请检查连接")
        }
    }
    private fun finishStatus() = SyncHealth.finish(applicationContext)
    companion object {
        private var lastHeartbeatRequest = 0L
        @Synchronized fun heartbeat(context: Context, config: CollectorConfig) {
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - lastHeartbeatRequest >= 30_000) { lastHeartbeatRequest = now; schedule(context, config) }
        }
        fun schedule(context: Context, config: CollectorConfig, manual: Boolean = false) = SyncSchedule.schedule(context, config, manual)
        fun isWifi(context: Context): Boolean {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
            return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
    }
}

internal object SyncHeartbeat {
    fun send(context: Context, settings: Settings, config: CollectorConfig, queue: DurableQueue) {
        if (SyncSchedule.waitingReason(context, config) != null) return
        val runtimeAlive = (config.screenCollectionEnabled && (CaptureAccessibilityService.connected || ProjectionService.running)) || (config.observesSystem() && MediaCollectionService.connected)
        val status = if (settings.enabled && !runtimeAlive) "permission_required" else settings.state()
        val inventory = queue.syncInventory()
        val body = JSONObject().put("deviceId", settings.deviceId).put("deviceName", config.deviceName).put("platform", "android")
            .put("status", status).put("queueDepth", queue.depth()).put("lastCaptureAt", settings.lastCapture())
            .put("sync", JSONObject().put("mode", config.syncMode).put("state", settings.syncState())
                .put("intervalMinutes", config.syncIntervalMinutes).put("batchSize", config.syncBatchSize)
                .put("pendingRecords", SyncSchedule.pending(context).count.coerceAtMost(1_000_000))
                .put("blockedRecords", inventory.getInt("blocked")).put("awaitingOcrRecords", inventory.getInt("awaitingOcr")).put("retainedRecords", inventory.getInt("retained"))
                .apply { settings.lastUploadAt()?.let { put("lastUploadAt", it) }
                    SyncSchedule.delay(context, config)?.takeIf { it > 0 }?.let { put("nextUploadAt", java.time.Instant.ofEpochMilli(System.currentTimeMillis() + it).toString()) } })
            .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context, if (!config.screenCollectionEnabled) "media_session" else if (config.effectiveMode() == "projection") "media_projection" else "accessibility")) }
        if (status == "permission_required") body.put("error", if (!runtimeAlive && settings.enabled)
            "采集服务未连接，请打开手机应用恢复权限" else settings.message())
        else if (status == "error") body.put("error", settings.message())
        val (code, response) = HttpJson.post("${config.server}/api/devices/heartbeat", body, config.token)
        if (code !in 200..299 || response?.optBoolean("ok") != true) SupportEvents.record(context, EventStage.HEARTBEAT, EventJournal.httpFailure(code), httpStatus = code)
        if (code !in 200..299 || response?.optBoolean("ok") != true) {
            Operations.record(context, OperationKind.HEARTBEAT_FAILED, Operations.httpReason(code), httpStatus = code)
            throw RecordedHeartbeatFailure()
        }
    }
}
