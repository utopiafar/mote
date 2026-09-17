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
    @Volatile var onRequest: (() -> Unit)? = null
    @Volatile var onComplete: ((Long) -> Unit)? = null
    fun post(url: String, body: JSONObject, token: String? = null): Pair<Int, JSONObject?> = request("POST", url, body, token)
    fun get(url: String, token: String? = null): Pair<Int, JSONObject?> = request("GET", url, null, token)
    fun request(method: String, url: String, body: JSONObject?, token: String? = null): Pair<Int, JSONObject?> {
        val started = android.os.SystemClock.elapsedRealtime()
        runCatching { onRequest?.invoke() }
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false // Never leak owner tokens through redirects.
            connection.doOutput = body != null
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept-Language", MoteI18n.language())
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
                    require(output.size() + count <= 256 * 1024) { MoteI18n.text("响应超过 256 KiB") }
                    output.write(buffer, 0, count)
                }
                output.toString("UTF-8")
            }
            return code to response?.let { runCatching { JSONObject(it) }.getOrNull() }
        } finally { connection.disconnect(); runCatching { onComplete?.invoke(android.os.SystemClock.elapsedRealtime() - started) } }
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
            settings.syncStatus("error", MoteI18n.text("{0}；记录保留在本机，{1}", message, if (manualOnly || !retryable) MoteI18n.text("请处理后点击立即同步") else MoteI18n.text("稍后自动重试")))
            return if (manualOnly || !retryable) Result.failure() else Result.retry()
        }
        return try {
            val config = settings.read()
            val explicit = inputData.getBoolean("manual", false)
            if (!config.hasSyncConnection()) { settings.syncStatus("unconfigured", MoteI18n.text("仅保存在本机 · 尚未配置完整连接")); return Result.success() }
            if (config.syncMode == "manual" && !explicit) { settings.syncStatus("manual", MoteI18n.text("手动同步 · 记录持续保存在本机")); return Result.success() }
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
            settings.syncStatus("uploading", MoteI18n.text("正在同步本机记录"))
            if (!inputData.getBoolean("continuation", false)) SourceWork.enqueueUpload(applicationContext, config, explicit)
            Diagnostics(applicationContext).add("uploadSessions")
            var remaining = 25
            while (remaining > 0) {
                remaining--
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
                        settings.syncStatus("error", MoteI18n.text("中央记录已不可更新；本机保留图片和失败状态，不会重新创建记录"))
                        continue
                    }
                    if (code == 409) {
                        queue.ocrConflict(id); pendingRecordId = null
                        settings.syncStatus("error", MoteI18n.text("OCR 更新与中央记录冲突；本机图片和文字已保留，请在采集记录中查看"))
                        continue
                    }
                    if (code !in 200..299 || response?.optString("id") != id) return failed(if (code == 404) MoteI18n.text("中央节点可能需要升级，OCR 结果已保留") else MoteI18n.text("OCR 更新未确认（HTTP {0}）", code))
                    Diagnostics(applicationContext).add("uploadBytes", body.toString().toByteArray(Charsets.UTF_8).size.toLong())
                    queue.acknowledgeOcr(id, config.uploadedRetentionDays); pendingRecordId = null
                    settings.syncStatus("uploading", MoteI18n.text("文字识别已更新至中央归档"), uploaded = true)
                    continue
                }
                val events = queue.peekBatch(remaining + 1)
                if (events.isEmpty()) {
                    finishStatus()
                    runCatching { SyncHeartbeat.send(applicationContext, settings, config, queue) }
                    return Result.success()
                }
                stage = EventStage.UPLOAD
                val capability = applicationContext.getSharedPreferences("batch-capability", Context.MODE_PRIVATE)
                val legacy = capability.getString("server", null) == config.server &&
                    System.currentTimeMillis() - capability.getLong("at", 0) in 0 until 86_400_000L
                var sent = if (legacy) events.take(1) else events
                pendingRecordId = sent.first().getString("id")
                val body = JSONObject().put("captures", org.json.JSONArray(sent))
                var response = if (legacy) HttpJson.post("${config.server}/api/captures", sent.first(), config.token)
                    else HttpJson.post("${config.server}/api/captures/batch", body, config.token)
                var individual = legacy
                if (!legacy && response.first in setOf(403, 404, 405, 413)) {
                    if (response.first != 413) capability.edit().putString("server", config.server).putLong("at", System.currentTimeMillis()).apply()
                    sent = events.take(1); individual = true
                    response = HttpJson.post("${config.server}/api/captures", sent.first(), config.token)
                }
                val receipts = if (individual) {
                    if (response.first in setOf(200, 201) && response.second?.optString("id") != pendingRecordId) return failed(MoteI18n.text("上传确认 ID 不匹配"))
                    mapOf(pendingRecordId!! to response.first)
                } else {
                    if (response.first != 200) return failed(MoteI18n.text("批量上传未确认（HTTP {0}）", response.first), response.first !in setOf(400, 401, 403, 413))
                    BatchUpload.receipts(sent.map { it.getString("id") }.toSet(), response.second)
                }
                var retry = false
                var permanent = false
                for (event in sent) {
                    val id = event.getString("id")
                    val code = receipts[id]
                    when (code) {
                        200, 201 -> {
                            val bytes = event.toString().toByteArray(Charsets.UTF_8).size.toLong()
                            queue.acknowledge(id, bytes, config.uploadedRetentionDays)
                            Diagnostics(applicationContext).add("uploadBytes", bytes)
                            SupportEvents.record(applicationContext, EventStage.UPLOAD, EventCode.OK, httpStatus = code)
                            settings.syncStatus("uploading", MoteI18n.text("已收到上传确认"), uploaded = true)
                        }
                        409 -> queue.uploadConflict(id)
                        410 -> queue.archiveMissing(id)
                        else -> { retry = true; if (code in setOf(400, 401, 403, 413)) permanent = true }
                    }
                }
                pendingRecordId = null
                remaining -= sent.size - 1
                if (retry) return failed(MoteI18n.text("部分记录未确认"), !permanent)

            }
            stage = EventStage.HEARTBEAT
            if (!queue.pendingSync().hasWork) finishStatus()
            runCatching { SyncHeartbeat.send(applicationContext, settings, config, queue) }
            // A successful chunk may continue the same explicit operation; failures never retry in manual mode.
            if (queue.pendingSync().hasWork) SyncSchedule.continueUpload(applicationContext, config, explicit)
            Result.success()
        } catch (error: Exception) {
            SupportEvents.record(applicationContext, stage, EventJournal.failure(error, stage))
            if (error !is RecordedHeartbeatFailure) Operations.record(applicationContext, OperationKind.UPLOAD_RETRY, Operations.failure(error, stage), recordId = pendingRecordId)
            failed(MoteI18n.text("同步失败，请检查连接"))
        }
    }
    private fun finishStatus() = SyncHealth.finish(applicationContext)
    companion object {
        fun heartbeat(context: Context, config: CollectorConfig) = HeartbeatWorker.stateChanged(context, config)
        fun schedule(context: Context, config: CollectorConfig, manual: Boolean = false) = SyncSchedule.schedule(context, config, manual)
        fun isWifi(context: Context): Boolean {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
            return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
    }
}

internal object SyncHeartbeat {
    @Synchronized fun send(context: Context, settings: Settings, config: CollectorConfig, queue: DurableQueue): Boolean {
        val prefs = context.getSharedPreferences("sync-heartbeat", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val state = "${SyncSchedule.stamp(config)}:${settings.enabled}:${settings.state()}"
        val last = prefs.getLong("at", 0)
        if (now >= last && now - last < 15 * 60_000 && prefs.getString("state", null) == state) return true
        if (now >= last && now - last < 60_000 && prefs.getString("stamp", null) == SyncSchedule.stamp(config)) return false
        if (SyncSchedule.waitingReason(context, config) != null) return false
        val runtimeAlive = (config.screenCollectionEnabled && (CaptureAccessibilityService.connected || ProjectionService.running)) || (config.observesSystem() && MediaCollectionService.connected)
        val status = if (!settings.enabled) "paused" else if (!runtimeAlive) "permission_required" else settings.state()
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
            MoteI18n.text("采集服务未连接，请打开手机应用恢复权限") else settings.message())
        else if (status == "error") body.put("error", settings.message())
        Diagnostics(context).add("heartbeatRequests")
        val (code, response) = HttpJson.post("${config.server}/api/devices/heartbeat", body, config.token)
        if (code !in 200..299 || response?.optBoolean("ok") != true) SupportEvents.record(context, EventStage.HEARTBEAT, EventJournal.httpFailure(code), httpStatus = code)
        if (code !in 200..299 || response?.optBoolean("ok") != true) {
            Operations.record(context, OperationKind.HEARTBEAT_FAILED, Operations.httpReason(code), httpStatus = code)
            throw RecordedHeartbeatFailure()
        }
        prefs.edit().putLong("at", now).putString("state", state).putString("stamp", SyncSchedule.stamp(config)).apply()
        return true
    }
}
