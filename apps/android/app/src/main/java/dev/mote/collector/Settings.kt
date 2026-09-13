package dev.mote.collector

import android.content.Context
import android.os.Build
import android.util.Base64
import java.io.File
import java.util.UUID

data class CollectorConfig(
    val server: String = "", val token: String = "", val deviceName: String = Build.MODEL,
    val intervalSeconds: Int = 30, val maxQueueMiB: Int = 256, val wifiOnly: Boolean = true,
    val excludedPackages: String = "", val masks: String = "", val localReviewUrl: String = "",
    val debugHttp: Boolean = false, val mode: String = "accessibility", val nsfw: NsfwConfig = NsfwConfig(),
    val jpegQuality: Int = 75, val captureMaxSide: Int = 1280, val chargingOnly: Boolean = false, val batteryPauseBelowPct: Int = 0,
    val diagnosticsEnabled: Boolean = false, val diagnosticsIntervalSeconds: Int = 60
) {
    fun validate() {
        PrivacyRules.validateEndpoint(server, debugHttp, BuildConfig.DEBUG)
        require(token.length >= 32) { "节点令牌至少需要 32 个字符" }
        require(deviceName.isNotBlank() && deviceName.length <= 128) { "请填写 1..128 字符的设备名称" }
        require(intervalSeconds in 5..300) { "采集间隔为 5..300 秒" }
        require(maxQueueMiB in 8..4096) { "队列上限为 8..4096 MiB" }
        Mask.parse(masks)
        PrivacyRules.validateLocalReview(localReviewUrl)
        require(mode in setOf("accessibility", "projection"))
        nsfw.validate()
        require(jpegQuality in 40..95 && captureMaxSide in 640..2560 && batteryPauseBelowPct in 0..95) { "检查 JPEG 质量、图片最长边或电量配置" }
        require(diagnosticsIntervalSeconds in 15..3600) { "诊断采样间隔为 15..3600 秒" }
    }
}

class Settings(private val context: Context) {
    private val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
    private val secret = SecretBox()
    val deviceId: String get() = synchronized(Settings::class.java) {
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId", it).commit() }
    }
    var enabled: Boolean get() = prefs.getBoolean("enabled", false); set(value) { prefs.edit().putBoolean("enabled", value).commit() }
    fun read(): CollectorConfig = CollectorConfig(
        server = prefs.getString("server", "")!!,
        token = prefs.getString("token", null)?.let { String(secret.open(Base64.decode(it, Base64.NO_WRAP))) } ?: "",
        deviceName = prefs.getString("deviceName", Build.MODEL)!!,
        intervalSeconds = prefs.getInt("interval", 30), maxQueueMiB = prefs.getInt("maxQueue", 256),
        wifiOnly = prefs.getBoolean("wifiOnly", true), excludedPackages = prefs.getString("excluded", "")!!,
        masks = prefs.getString("masks", "")!!, localReviewUrl = prefs.getString("localReview", "")!!,
        debugHttp = prefs.getBoolean("debugHttp", false), mode = prefs.getString("mode", "accessibility")!!,
        nsfw = NsfwConfig(enabled = prefs.getBoolean("nsfwEnabled", true), threads = prefs.getInt("nsfwThreads", 2),
            timeoutMs = prefs.getLong("qwenTimeout", 60000), source = prefs.getString("nsfwSource", "auto")!!,
            customUrl = prefs.getString("qwenCustomUrl", "")!!, policy = prefs.getString("qwenPolicy", null) ?: context.assets.open("review-policy.txt").bufferedReader().use { it.readText().trim() },
            maxTokens = prefs.getInt("qwenMaxTokens", 256), reviewMaxSide = prefs.getInt("qwenMaxSide", 512)),
        jpegQuality = prefs.getInt("jpegQuality", 75), captureMaxSide = prefs.getInt("captureMaxSide", 1280),
        chargingOnly = prefs.getBoolean("chargingOnly", false), batteryPauseBelowPct = prefs.getInt("batteryPauseBelowPct", 0),
        diagnosticsEnabled = prefs.getBoolean("diagnosticsEnabled", false), diagnosticsIntervalSeconds = prefs.getInt("diagnosticsIntervalSeconds", 60)
    )
    fun save(c: CollectorConfig) {
        c.validate()
        prefs.edit().putString("server", c.server.trim().trimEnd('/')).putString("token", Base64.encodeToString(secret.seal(c.token.toByteArray()), Base64.NO_WRAP))
            .putString("deviceName", c.deviceName).putInt("interval", c.intervalSeconds).putInt("maxQueue", c.maxQueueMiB)
            .putBoolean("wifiOnly", c.wifiOnly).putString("excluded", c.excludedPackages).putString("masks", c.masks)
            .putString("localReview", c.localReviewUrl).putBoolean("debugHttp", c.debugHttp).putString("mode", c.mode).commit()
        prefs.edit().putInt("jpegQuality", c.jpegQuality).putInt("captureMaxSide", c.captureMaxSide).putBoolean("chargingOnly", c.chargingOnly)
            .putInt("batteryPauseBelowPct", c.batteryPauseBelowPct).putBoolean("diagnosticsEnabled", c.diagnosticsEnabled).putInt("diagnosticsIntervalSeconds", c.diagnosticsIntervalSeconds).commit()
        saveNsfw(c.nsfw)
    }
    fun saveNsfw(value: NsfwConfig) {
        value.validate()
        prefs.edit().putBoolean("nsfwEnabled", value.enabled)
            .putInt("nsfwThreads", value.threads).putLong("qwenTimeout", value.timeoutMs).putString("nsfwSource", value.source)
            .putString("qwenCustomUrl", value.customUrl).putString("qwenPolicy", value.policy).putInt("qwenMaxTokens", value.maxTokens).putInt("qwenMaxSide", value.reviewMaxSide).commit()
    }
    fun status(state: String, message: String) { prefs.edit().putString("state", state).putString("message", message).putLong("statusAt", System.currentTimeMillis()).apply() }
    fun state(): String = prefs.getString("state", "paused")!!
    fun message(): String = prefs.getString("message", "尚未开始采集")!!
    fun statusAt(): Long = prefs.getLong("statusAt", 0)
    fun captured(at: String) { prefs.edit().putString("lastCapture", at).apply() }
    fun lastCapture(): String? = prefs.getString("lastCapture", null)
    fun uploadStatus(message: String) { prefs.edit().putString("uploadStatus", message).apply() }
    fun uploadStatus(): String = prefs.getString("uploadStatus", "尚未上传")!!
}

fun Context.queue() = DurableQueue(File(noBackupFilesDir, "queue"), SecretBox())
