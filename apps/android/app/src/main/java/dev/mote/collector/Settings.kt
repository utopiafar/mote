package dev.mote.collector

import android.content.Context
import android.os.Build
import android.util.Base64
import java.util.UUID

data class CollectorConfig(
    val uploadGate: UploadGateConfig = UploadGateConfig(),
    val server: String = "", val token: String = "", val deviceName: String = Build.MODEL,
    val intervalSeconds: Int = 30, val maxQueueMiB: Int = 256, val wifiOnly: Boolean = true,
    val excludedPackages: String = "", val masks: String = "", val localReviewUrl: String = "",
    val debugHttp: Boolean = false, val mode: String = "accessibility", val nsfw: NsfwConfig = NsfwConfig(),
    val jpegQuality: Int = 75, val captureMaxSide: Int = 1280, val chargingOnly: Boolean = false, val batteryPauseBelowPct: Int = 0,
    val diagnosticsEnabled: Boolean = false, val diagnosticsIntervalSeconds: Int = 60,
    val appCollectionRules: String = AppCollectionRules.DEFAULT, val metadataEnabled: Boolean = true,
    val packedUpload: Boolean = true, val syncMode: String = "realtime", val syncIntervalMinutes: Int = 15, val syncBatchSize: Int = 20, val jsonlWindowMinutes: Int = 10,
    val ocrChargingOnly: Boolean = false, val mediaCollectionEnabled: Boolean = false, val screenCollectionEnabled: Boolean = true,
    val notificationCollectionEnabled: Boolean = false, val deviceEventCollectionEnabled: Boolean = false,
    val syncChargingOnly: Boolean = false, val syncBatteryNotLow: Boolean = false, val imageDedupeMode: String = "off",
    val ocrMode: String = "chinese", val ocrAppModes: String = "{}",
    val imageDedupeDiagnosticsEnabled: Boolean = false, val contentEncryptionEnabled: Boolean = false, val uploadedRetentionDays: Int = 7
) {
    fun observesSystem() = (mediaCollectionEnabled && metadataEnabled) || notificationCollectionEnabled || deviceEventCollectionEnabled
    val collectionRules by lazy { AppCollectionRules.parse(appCollectionRules) }
    fun effectiveMode() = if (collectionRules.mayCollectContent()) mode else "accessibility"
    fun hasSyncConnection() = server.isNotBlank() && token.length >= 32
    fun syncPolicy() = SyncPolicy(syncMode, syncIntervalMinutes, syncBatchSize)
    fun validateConnection() {
        PrivacyRules.validateEndpoint(server, debugHttp, BuildConfig.DEBUG)
        require(token.length >= 32) { MoteI18n.text("节点令牌至少需要 32 个字符") }
    }
    fun validate() {
        uploadGate.validate()
        if (server.isNotBlank()) PrivacyRules.validateEndpoint(server, debugHttp, BuildConfig.DEBUG)
        require(token.isBlank() || token.length >= 32) { MoteI18n.text("节点令牌至少需要 32 个字符；留空时仅保存在本机") }
        syncPolicy().validate()
        OcrPolicy.validate(ocrMode, ocrAppModes)
        require(imageDedupeMode in setOf("off", "exact", "conservative", "balanced", "aggressive")) { MoteI18n.text("图片去重档位无效") }
        require(deviceName.isNotBlank() && deviceName.length <= 128) { MoteI18n.text("请填写 1..128 字符的设备名称") }
        require(intervalSeconds in 5..300) { MoteI18n.text("采集间隔为 5..300 秒") }
        require(uploadedRetentionDays in 0..365) { MoteI18n.text("本机保留时间为 0..365 天") }
        require(maxQueueMiB in 8..4096) { MoteI18n.text("队列上限为 8..4096 MiB") }
        require(jsonlWindowMinutes in 1..1440) { MoteI18n.text("JSONL 合并窗口为 1..1440 分钟") }
        Mask.parse(masks)
        AppCollectionRules.parse(appCollectionRules)
        PrivacyRules.validateLocalReview(localReviewUrl)
        require(mode in setOf("accessibility", "projection"))
        nsfw.validate()
        require(jpegQuality in 40..95 && captureMaxSide in 640..2560 && batteryPauseBelowPct in 0..95) { MoteI18n.text("检查 JPEG 质量、图片最长边或电量配置") }
        require(diagnosticsIntervalSeconds in 15..3600) { MoteI18n.text("诊断采样间隔为 15..3600 秒") }
    }
}

class SettingsWriteFailure : IllegalStateException(MoteI18n.text("无法持久保存设置，请检查存储空间"))
class SettingsChangedFailure : IllegalStateException(MoteI18n.text("已保存设置发生变化，页面已更新；请检查后重新保存"))

class Settings(private val context: Context) {
    private val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
    private val secret = SecretBox()
    val deviceId: String get() = synchronized(Settings::class.java) {
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId", it).commit() }
    }
    var enabled: Boolean get() = prefs.getBoolean("enabled", false); set(value) {
        if (!value) MediaCollectionService.suspendObservation()
        prefs.edit().putBoolean("enabled", value).commit()
        CaptureAccessibilityService.instance?.refreshSchedule()
        runCatching { HeartbeatWorker.stateChanged(context, read()) }
    }
    fun read(): CollectorConfig = synchronized(Settings::class.java) {
        if (!prefs.contains("appCollectionRules")) {
            val initial = if (prefs.contains("interval") || prefs.contains("enabled")) AppCollectionRules.LEGACY_DEFAULT else AppCollectionRules.DEFAULT
            if (!prefs.edit().putString("appCollectionRules", initial).commit()) throw SettingsWriteFailure()
        }
        // SharedPreferences already keeps values in memory. Compare only configuration keys,
        // so status/counter writes never rebuild a snapshot or decrypt credentials.
        val values = prefs.all.filterKeys { it in configurationKeys }
        if (cachedPrefs === prefs && cachedValues == values) return@synchronized requireNotNull(cachedConfig)
        val config = CollectorConfig(
        uploadGate = UploadGateConfig(prefs.getBoolean("uploadGateEnabled", true), prefs.getString("uploadGateText", "")!!, prefs.getString("uploadGateFailure", "hold")!!),
        server = prefs.getString("server", BuildConfig.DEFAULT_SERVER)!!,
        token = credentials(prefs.getString("token", null)),
        deviceName = prefs.getString("deviceName", Build.MODEL)!!,
        intervalSeconds = prefs.getInt("interval", 30), maxQueueMiB = prefs.getInt("maxQueue", 256),
        wifiOnly = prefs.getBoolean("wifiOnly", true), excludedPackages = prefs.getString("excluded", "")!!,
        masks = prefs.getString("masks", "")!!, localReviewUrl = prefs.getString("localReview", "")!!,
        debugHttp = prefs.getBoolean("debugHttp", BuildConfig.MOTE_PROFILE == "dev"), mode = prefs.getString("mode", "accessibility")!!,
        nsfw = NsfwConfig(enabled = false, threads = prefs.getInt("nsfwThreads", 2),
            timeoutMs = prefs.getLong("qwenTimeout", 60000), source = prefs.getString("nsfwSource", "auto")!!,
            customUrl = prefs.getString("qwenCustomUrl", "")!!, policy = prefs.getString("qwenPolicy", null) ?: context.assets.open("review-policy.txt").bufferedReader().use { it.readText().trim() },
            maxTokens = prefs.getInt("qwenMaxTokens", 256), reviewMaxSide = prefs.getInt("qwenMaxSide", 512)),
        jpegQuality = prefs.getInt("jpegQuality", 75), captureMaxSide = prefs.getInt("captureMaxSide", 1280),
        chargingOnly = prefs.getBoolean("chargingOnly", false), batteryPauseBelowPct = prefs.getInt("batteryPauseBelowPct", 0),
        diagnosticsEnabled = prefs.getBoolean("diagnosticsEnabled", false), diagnosticsIntervalSeconds = prefs.getInt("diagnosticsIntervalSeconds", 60),
        appCollectionRules = prefs.getString("appCollectionRules", if (prefs.contains("interval") || prefs.contains("enabled")) AppCollectionRules.LEGACY_DEFAULT else AppCollectionRules.DEFAULT)!!,
        metadataEnabled = prefs.getBoolean("metadataEnabled", true),
        syncMode = prefs.getString("syncMode", "realtime")!!,
        packedUpload = prefs.getBoolean("packedUpload", true), syncIntervalMinutes = prefs.getInt("syncIntervalMinutes", 15), syncBatchSize = prefs.getInt("syncBatchSize", 20), jsonlWindowMinutes = prefs.getInt("jsonlWindowMinutes", 10),
        ocrChargingOnly = prefs.getBoolean("ocrChargingOnly", false), mediaCollectionEnabled = prefs.getBoolean("mediaCollectionEnabled", false), screenCollectionEnabled = prefs.getBoolean("screenCollectionEnabled", true),
        notificationCollectionEnabled = prefs.getBoolean("notificationCollectionEnabled", false), deviceEventCollectionEnabled = prefs.getBoolean("deviceEventCollectionEnabled", false),
        syncChargingOnly = prefs.getBoolean("syncChargingOnly", false), syncBatteryNotLow = prefs.getBoolean("syncBatteryNotLow", false), imageDedupeMode = prefs.getString("imageDedupeMode", "off")!!,
        imageDedupeDiagnosticsEnabled = prefs.getBoolean("imageDedupeDiagnosticsEnabled", false),
        contentEncryptionEnabled = false,
        uploadedRetentionDays = prefs.getInt("uploadedRetentionDays", 7),
        ocrMode = prefs.getString("ocrMode", "chinese")!!, ocrAppModes = prefs.getString("ocrAppModes", "{}")!!
    )
        cachedPrefs = prefs; cachedValues = values; cachedConfig = config
        config
    }
    private fun credentials(ciphertext: String?): String {
        if (ciphertext == null) return ""
        if (cachedCiphertext != ciphertext) {
            cachedToken = String(secret.open(Base64.decode(ciphertext, Base64.NO_WRAP)))
            cachedCiphertext = ciphertext
        }
        return cachedToken
    }
    fun save(c: CollectorConfig, expected: CollectorConfig? = null) = synchronized(Settings::class.java) {
        if (expected != null && read() != expected) throw SettingsChangedFailure()
        c.validate()
        val origin = originAfterChange(c)
        val values = mapOf<String, Any>(
            "uploadGateEnabled" to c.uploadGate.enabled, "uploadGateText" to c.uploadGate.blockedText, "uploadGateFailure" to c.uploadGate.failureAction,
            "contentEncryptionEnabled" to c.contentEncryptionEnabled, "uploadedRetentionDays" to c.uploadedRetentionDays,
            "ocrMode" to c.ocrMode, "ocrAppModes" to c.ocrAppModes, "imageDedupeMode" to c.imageDedupeMode, "imageDedupeDiagnosticsEnabled" to c.imageDedupeDiagnosticsEnabled,
            "dataOrigin" to origin, "syncMode" to c.syncMode, "syncIntervalMinutes" to c.syncIntervalMinutes,
            "syncChargingOnly" to c.syncChargingOnly, "syncBatteryNotLow" to c.syncBatteryNotLow,
            "packedUpload" to c.packedUpload, "syncBatchSize" to c.syncBatchSize, "jsonlWindowMinutes" to c.jsonlWindowMinutes, "server" to c.server.trim().trimEnd('/'),
            "token" to (prefs.getString("token", null)?.takeIf { credentials(it) == c.token }
                ?: Base64.encodeToString(secret.seal(c.token.toByteArray()), Base64.NO_WRAP)),
            "deviceName" to c.deviceName, "interval" to c.intervalSeconds, "maxQueue" to c.maxQueueMiB,
            "wifiOnly" to c.wifiOnly, "excluded" to c.excludedPackages, "masks" to c.masks, "localReview" to c.localReviewUrl,
            "debugHttp" to c.debugHttp, "mode" to c.mode, "appCollectionRules" to c.appCollectionRules, "metadataEnabled" to c.metadataEnabled,
            "jpegQuality" to c.jpegQuality, "captureMaxSide" to c.captureMaxSide, "chargingOnly" to c.chargingOnly,
            "notificationCollectionEnabled" to c.notificationCollectionEnabled, "deviceEventCollectionEnabled" to c.deviceEventCollectionEnabled,
            "ocrChargingOnly" to c.ocrChargingOnly, "mediaCollectionEnabled" to c.mediaCollectionEnabled, "screenCollectionEnabled" to c.screenCollectionEnabled, "batteryPauseBelowPct" to c.batteryPauseBelowPct,
            "diagnosticsEnabled" to c.diagnosticsEnabled, "diagnosticsIntervalSeconds" to c.diagnosticsIntervalSeconds,
            "nsfwEnabled" to c.nsfw.enabled, "nsfwThreads" to c.nsfw.threads, "qwenTimeout" to c.nsfw.timeoutMs,
            "nsfwSource" to c.nsfw.source, "qwenCustomUrl" to c.nsfw.customUrl, "qwenPolicy" to c.nsfw.policy,
            "qwenMaxTokens" to c.nsfw.maxTokens, "qwenMaxSide" to c.nsfw.reviewMaxSide)
        val previous = values.keys.associateWith { prefs.all[it] }
        fun write(items: Map<String, Any?>): Boolean {
            val edit = prefs.edit()
            items.forEach { (key, value) -> when (value) {
                null -> edit.remove(key); is String -> edit.putString(key, value); is Int -> edit.putInt(key, value)
                is Long -> edit.putLong(key, value); is Boolean -> edit.putBoolean(key, value)
                else -> error("Unsupported configuration value")
            } }
            return edit.commit()
        }
        if (!write(values)) {
            if (!write(previous)) { enabled = false; status("error", MoteI18n.text("设置保存与恢复均未持久完成，采集已停止；请检查存储空间并重试")) }
            throw SettingsWriteFailure()
        }
        /* Configuration is committed as one snapshot; status counters are never rolled back. */
    }
    fun saveConnection(server: String, token: String, deviceName: String, debugHttp: Boolean) = synchronized(Settings::class.java) {
        val next = read().copy(server = server, token = token, deviceName = deviceName, debugHttp = debugHttp)
        next.validate(); next.validateConnection()
        val origin = originAfterChange(next)
        val previousServer = prefs.getString("server", null); val previousToken = prefs.getString("token", null)
        val previousOrigin = prefs.getString("dataOrigin", null)
        val previousName = prefs.getString("deviceName", null); val previousHttp = prefs.getBoolean("debugHttp", BuildConfig.MOTE_PROFILE == "dev")
        val saved = prefs.edit().putString("dataOrigin", origin).putString("server", server.trimEnd('/')).putString("token", Base64.encodeToString(secret.seal(token.toByteArray()), Base64.NO_WRAP))
            .putString("deviceName", deviceName).putBoolean("debugHttp", debugHttp).commit()
        if (!saved) {
            // Restore memory as well as attempt durable rollback; caller retains the encrypted redemption journal.
            if (!prefs.edit().putString("dataOrigin", previousOrigin).putString("server", previousServer).putString("token", previousToken).putString("deviceName", previousName).putBoolean("debugHttp", previousHttp).commit()) {
                enabled = false; status("error", MoteI18n.text("连接设置未能持久恢复，采集已停止；原连接恢复资料仍保留"))
            }
            throw SettingsWriteFailure()
        }
    }
    /** Sticky while records or prepared submissions exist, including after disconnecting. */
    fun dataOrigin(): String {
        if (prefs.contains("dataOrigin")) return prefs.getString("dataOrigin", "")!!
        val old = read()
        return if (prefs.contains("server") && old.server.isNotBlank()) old.server.trimEnd('/') else ""
    }
    fun hasPendingData(): Boolean = context.fileArchives().pendingSync().count > 0 || context.queue().depth() > 0 || QuickNotes.draft(context).read().prepared != null ||
        context.localSources().sources().any { (context.localSources().state(it.id).optJSONArray("pending")?.length() ?: 0) > 0 }
    private fun originAfterChange(next: CollectorConfig): String {
        val previous = dataOrigin()
        val current = read()
        if (current.server == next.server && current.token == next.token) return previous
        if (!hasPendingData()) return if (next.hasSyncConnection()) next.server.trimEnd('/') else ""
        require(previous.isBlank() || next.server.isBlank() || previous == next.server.trimEnd('/')) { MoteI18n.text("待同步资料属于原节点，请先同步到原节点；清空连接不会解除资料绑定") }
        return previous.ifBlank { if (next.hasSyncConnection()) next.server.trimEnd('/') else "" }
    }
    fun ensureDataOrigin(config: CollectorConfig) {
        if (!prefs.contains("dataOrigin")) {
            val origin = if (config.hasSyncConnection()) config.server.trimEnd('/') else ""
            if (!prefs.edit().putString("dataOrigin", origin).commit()) throw SettingsWriteFailure()
        }
    }
    fun lastSyncDispatch(): Long = prefs.getLong("lastSyncDispatch", 0)
    fun syncDispatched(at: Long) { prefs.edit().putLong("lastSyncDispatch", at).apply() }
    fun lastUploadAt(): String? = prefs.getString("lastUploadAt", null)
    fun syncState(): String = prefs.getString("syncState", "idle")!!
    fun syncStatus(state: String, message: String, uploaded: Boolean = false) {
        if (!uploaded && syncState() == state && uploadStatus() == message) return
        val edit = prefs.edit().putString("syncState", state).putString("uploadStatus", message)
        if (uploaded) edit.putString("lastUploadAt", java.time.Instant.now().toString())
        edit.apply()
    }
    companion object {
        private var cachedPrefs: android.content.SharedPreferences? = null
        private var cachedValues: Map<String, *>? = null
        private var cachedConfig: CollectorConfig? = null
        private var cachedCiphertext: String? = null
        private var cachedToken = ""
        private val configurationKeys = setOf("packedUpload", "uploadGateEnabled", "uploadGateText", "uploadGateFailure", "uploadedRetentionDays", "contentEncryptionEnabled", "appCollectionRules", "batteryPauseBelowPct", "captureMaxSide", "chargingOnly", "debugHttp", "deviceEventCollectionEnabled", "deviceName", "diagnosticsEnabled", "diagnosticsIntervalSeconds", "enabled", "excluded", "imageDedupeDiagnosticsEnabled", "imageDedupeMode", "interval", "jpegQuality", "jsonlWindowMinutes", "localReview", "masks", "maxQueue", "mediaCollectionEnabled", "metadataEnabled", "mode", "notificationCollectionEnabled", "nsfwEnabled", "nsfwSource", "nsfwThreads", "ocrAppModes", "ocrChargingOnly", "ocrMode", "qwenCustomUrl", "qwenMaxSide", "qwenMaxTokens", "qwenPolicy", "qwenTimeout", "screenCollectionEnabled", "server", "syncBatchSize", "syncBatteryNotLow", "syncChargingOnly", "syncIntervalMinutes", "syncMode", "token", "wifiOnly")

    }
    fun saveNsfw(value: NsfwConfig) {
        save(read().copy(nsfw = value))
    }
    fun status(state: String, message: String) {
        val changed = state() != state
        if (!changed && message() == message) return
        prefs.edit().putString("state", state).putString("message", message).putLong("statusAt", System.currentTimeMillis()).apply()
        if (changed) runCatching { HeartbeatWorker.stateChanged(context, read()) }
    }
    fun state(): String = prefs.getString("state", "paused")!!
    fun message(): String = prefs.getString("message", MoteI18n.text("尚未开始采集"))!!
    fun statusAt(): Long = prefs.getLong("statusAt", 0)
    fun captured(at: String) { prefs.edit().putString("lastCapture", at).apply() }
    fun lastCapture(): String? = prefs.getString("lastCapture", null)
    fun uploadStatus(message: String) { prefs.edit().putString("uploadStatus", message).apply() }
    fun uploadStatus(): String = prefs.getString("uploadStatus", MoteI18n.text("尚未上传"))!!
}

fun Context.queue() = QueueStorage(this).openQueue()
