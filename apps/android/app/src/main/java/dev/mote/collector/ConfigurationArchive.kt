package dev.mote.collector

import org.json.JSONObject

/** Versioned portable settings. Device identity, run state and Android grants are never imported. */
object ConfigurationArchive {
    const val MAX_BYTES = 256 * 1024
    fun encode(c: CollectorConfig, includeToken: Boolean = false): String {
        val settings = JSONObject().put("uiPageMode", c.uiPageMode).put("uiPageRules", c.uiPageRules)
            .put("server", c.server)
            .put("deviceName", c.deviceName)
            .put("intervalSeconds", c.intervalSeconds)
            .put("maxQueueMiB", c.maxQueueMiB)
            .put("wifiOnly", c.wifiOnly)
            .put("excludedPackages", c.excludedPackages)
            .put("masks", c.masks)
            .put("debugHttp", c.debugHttp)
            .put("mode", c.mode)
            .put("jpegQuality", c.jpegQuality)
            .put("captureMaxSide", c.captureMaxSide)
            .put("chargingOnly", c.chargingOnly)
            .put("batteryPauseBelowPct", c.batteryPauseBelowPct)
            .put("diagnosticsEnabled", c.diagnosticsEnabled)
            .put("diagnosticsIntervalSeconds", c.diagnosticsIntervalSeconds)
            .put("appCollectionRules", c.appCollectionRules)
            .put("metadataEnabled", c.metadataEnabled)
            .put("syncMode", c.syncMode)
            .put("syncIntervalMinutes", c.syncIntervalMinutes)
            .put("syncBatchSize", c.syncBatchSize)
            .put("packedUpload", c.packedUpload)
            .put("uploadGateEnabled", c.uploadGate.enabled)
            .put("uploadGateText", c.uploadGate.blockedText)
            .put("uploadGateFailure", c.uploadGate.failureAction)
            .put("jsonlWindowMinutes", c.jsonlWindowMinutes)

            .put("mediaCollectionEnabled", c.mediaCollectionEnabled)
            .put("screenCollectionEnabled", c.screenCollectionEnabled)
            .put("notificationCollectionEnabled", c.notificationCollectionEnabled)
            .put("deviceEventCollectionEnabled", c.deviceEventCollectionEnabled)
            .put("syncChargingOnly", c.syncChargingOnly)
            .put("syncBatteryNotLow", c.syncBatteryNotLow)
            .put("imageDedupeMode", c.imageDedupeMode)
            .put("ocrMode", c.ocrMode)
            .put("ocrAppModes", c.ocrAppModes)
            .put("imageDedupeDiagnosticsEnabled", c.imageDedupeDiagnosticsEnabled)

            .put("uploadedRetentionDays", c.uploadedRetentionDays)
        if (includeToken) settings.put("token", c.token)
        return JSONObject().put("format", "mote-android-settings").put("version", 1).put("settings", settings).toString(2)
    }
    fun decode(raw: String, current: CollectorConfig): CollectorConfig {
        require(raw.toByteArray().size <= MAX_BYTES) { MoteI18n.text("配置文件过大") }
        StrictJson.validate(raw)
        val root = JSONObject(raw)
        require(root.getString("format") == "mote-android-settings" && root.get("version") == 1) { MoteI18n.text("不支持的配置格式或版本") }
        val values = root.getJSONObject("settings")
        require(!values.has("nsfw") && !values.has("localReviewUrl")) { MoteI18n.text("配置包含已停用的本机模型设置，请移除后导入") }
        require(values.keys().asSequence().all { it in keys }) { MoteI18n.text("配置包含未知字段") }
        val nextServer = string(values, "server", current.server)
        return current.copy(
            uiPageMode=string(values,"uiPageMode",current.uiPageMode), uiPageRules=string(values,"uiPageRules",current.uiPageRules),
            server = nextServer,
            deviceName = string(values, "deviceName", current.deviceName),
            intervalSeconds = int(values, "intervalSeconds", current.intervalSeconds),
            maxQueueMiB = int(values, "maxQueueMiB", current.maxQueueMiB),
            wifiOnly = boolean(values, "wifiOnly", current.wifiOnly),
            excludedPackages = string(values, "excludedPackages", current.excludedPackages),
            masks = string(values, "masks", current.masks),
            debugHttp = boolean(values, "debugHttp", current.debugHttp),
            mode = string(values, "mode", current.mode),
            jpegQuality = int(values, "jpegQuality", current.jpegQuality),
            captureMaxSide = int(values, "captureMaxSide", current.captureMaxSide),
            chargingOnly = boolean(values, "chargingOnly", current.chargingOnly),
            batteryPauseBelowPct = int(values, "batteryPauseBelowPct", current.batteryPauseBelowPct),
            diagnosticsEnabled = boolean(values, "diagnosticsEnabled", current.diagnosticsEnabled),
            diagnosticsIntervalSeconds = int(values, "diagnosticsIntervalSeconds", current.diagnosticsIntervalSeconds),
            appCollectionRules = string(values, "appCollectionRules", current.appCollectionRules),
            metadataEnabled = boolean(values, "metadataEnabled", current.metadataEnabled),
            syncMode = string(values, "syncMode", current.syncMode),
            syncIntervalMinutes = int(values, "syncIntervalMinutes", current.syncIntervalMinutes),
            syncBatchSize = int(values, "syncBatchSize", current.syncBatchSize),
            packedUpload = boolean(values, "packedUpload", current.packedUpload),
            uploadGate = UploadGateConfig(
                enabled = boolean(values, "uploadGateEnabled", current.uploadGate.enabled),
                blockedText = string(values, "uploadGateText", current.uploadGate.blockedText),
                failureAction = string(values, "uploadGateFailure", current.uploadGate.failureAction),
            ),
            jsonlWindowMinutes = int(values, "jsonlWindowMinutes", current.jsonlWindowMinutes),

            mediaCollectionEnabled = boolean(values, "mediaCollectionEnabled", current.mediaCollectionEnabled),
            screenCollectionEnabled = boolean(values, "screenCollectionEnabled", current.screenCollectionEnabled),
            notificationCollectionEnabled = boolean(values, "notificationCollectionEnabled", current.notificationCollectionEnabled),
            deviceEventCollectionEnabled = boolean(values, "deviceEventCollectionEnabled", current.deviceEventCollectionEnabled),
            syncChargingOnly = boolean(values, "syncChargingOnly", current.syncChargingOnly),
            syncBatteryNotLow = boolean(values, "syncBatteryNotLow", current.syncBatteryNotLow),
            imageDedupeMode = string(values, "imageDedupeMode", current.imageDedupeMode),
            ocrMode = string(values, "ocrMode", current.ocrMode),
            ocrAppModes = string(values, "ocrAppModes", current.ocrAppModes),
            imageDedupeDiagnosticsEnabled = boolean(values, "imageDedupeDiagnosticsEnabled", current.imageDedupeDiagnosticsEnabled),

            uploadedRetentionDays = int(values, "uploadedRetentionDays", current.uploadedRetentionDays),
            token = string(values, "token", if (nextServer == current.server) current.token else "")
        ).also { it.validate() }
    }
    private fun string(j: JSONObject, key: String, fallback: String): String = if (!j.has(key)) fallback else j.get(key) as? String ?: error(MoteI18n.text("{0} 必须为文本", key))
    private fun boolean(j: JSONObject, key: String, fallback: Boolean): Boolean = if (!j.has(key)) fallback else j.get(key) as? Boolean ?: error(MoteI18n.text("{0} 必须为布尔值", key))
    private fun long(j: JSONObject, key: String, fallback: Long): Long {
        if (!j.has(key)) return fallback
        val n = j.get(key); require(n is Int || n is Long) { MoteI18n.text("{0} 必须为整数", key) }; return (n as Number).toLong()
    }
    private fun int(j: JSONObject, key: String, fallback: Int): Int {
        val n = long(j, key, fallback.toLong()); require(n in Int.MIN_VALUE..Int.MAX_VALUE); return n.toInt()
    }
    private val keys = setOf("packedUpload", "uploadGateEnabled", "uploadGateText", "uploadGateFailure", "uiPageMode", "uiPageRules", "server", "token", "deviceName", "intervalSeconds", "maxQueueMiB", "wifiOnly", "excludedPackages", "masks", "debugHttp", "mode", "jpegQuality", "captureMaxSide", "chargingOnly", "batteryPauseBelowPct", "diagnosticsEnabled", "diagnosticsIntervalSeconds", "appCollectionRules", "metadataEnabled", "syncMode", "syncIntervalMinutes", "syncBatchSize", "jsonlWindowMinutes", "mediaCollectionEnabled", "screenCollectionEnabled", "notificationCollectionEnabled", "deviceEventCollectionEnabled", "syncChargingOnly", "syncBatteryNotLow", "imageDedupeMode", "ocrMode", "ocrAppModes", "imageDedupeDiagnosticsEnabled", "uploadedRetentionDays")
}
