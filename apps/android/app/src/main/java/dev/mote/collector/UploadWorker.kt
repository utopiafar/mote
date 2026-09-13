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
    fun post(url: String, body: JSONObject, token: String? = null): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false // Never leak owner tokens through redirects.
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
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

class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val settings = Settings(applicationContext)
        return try {
            val config = settings.read()
            if (config.server.isBlank()) return Result.success()
            config.validate()
            if (config.wifiOnly && !isWifi(applicationContext)) {
                settings.uploadStatus("等待非计费 Wi-Fi；截图留在本机队列")
                return Result.retry()
            }
            val queue = applicationContext.queue()
            sendHeartbeat(settings, config, queue)
            repeat(25) {
                if (isStopped) return Result.retry()
                if (config.wifiOnly && !isWifi(applicationContext)) return Result.retry()
                val event = queue.peek() ?: run {
                    sendHeartbeat(settings, config, queue)
                    settings.uploadStatus("队列已同步 · ${java.time.Instant.now()}")
                    return Result.success()
                }
                val (code, response) = HttpJson.post("${config.server}/api/captures", event, config.token)
                if (code !in setOf(200, 201) || response?.optString("id") != event.getString("id")) {
                    settings.uploadStatus("上传未确认（HTTP $code），原记录保留并退避重试")
                    return Result.retry()
                }
                Diagnostics(applicationContext).add("uploadBytes", event.toString().toByteArray(Charsets.UTF_8).size.toLong())
                queue.acknowledge(event.getString("id"))
                settings.uploadStatus("已确认上传；待上传 ${queue.depth()} 条")
            }
            sendHeartbeat(settings, config, queue)
            if (queue.depth() > 0) Result.retry() else Result.success()
        } catch (_: Exception) {
            settings.uploadStatus("网络、配置或本地队列异常，数据保留，等待重试；请检查节点地址/证书/令牌")
            Result.retry()
        }
    }
    private fun sendHeartbeat(settings: Settings, config: CollectorConfig, queue: DurableQueue) {
        val runtimeAlive = CaptureAccessibilityService.connected || ProjectionService.running
        val status = if (settings.enabled && !runtimeAlive) "permission_required" else settings.state()
        val body = JSONObject().put("deviceId", settings.deviceId).put("deviceName", config.deviceName).put("platform", "android")
            .put("status", status).put("queueDepth", queue.depth()).put("lastCaptureAt", settings.lastCapture())
        if (status == "permission_required") body.put("error", if (!runtimeAlive && settings.enabled)
            "采集服务未连接，请打开手机应用恢复权限" else settings.message())
        else if (status == "error") body.put("error", settings.message())
        val (code, response) = HttpJson.post("${config.server}/api/devices/heartbeat", body, config.token)
        check(code in 200..299 && response?.optBoolean("ok") == true) { "节点未确认最新设备状态" }
    }
    companion object {
        private var lastHeartbeatRequest = 0L
        @Synchronized fun heartbeat(context: Context, config: CollectorConfig) {
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - lastHeartbeatRequest >= 30_000) { lastHeartbeatRequest = now; schedule(context, config) }
        }
        private fun constraints(config: CollectorConfig) = Constraints.Builder()
            .setRequiredNetworkType(if (config.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build()
        fun schedule(context: Context, config: CollectorConfig, manual: Boolean = false) {
            val work = OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(constraints(config))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("mote-upload", if (manual) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, work)
            val periodic = PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints(config)).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("mote-upload-recovery", ExistingPeriodicWorkPolicy.UPDATE, periodic)
        }
        fun isWifi(context: Context): Boolean {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
            return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
    }
}
