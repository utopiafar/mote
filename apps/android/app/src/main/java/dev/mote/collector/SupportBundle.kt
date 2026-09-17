package dev.mote.collector

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object SupportEvents {
    fun record(context: Context, stage: EventStage, code: EventCode, elapsedMs: Long? = null, httpStatus: Int? = null) {
        runCatching { runtime(context).event(stage, code, elapsedMs, httpStatus) }
        if (!context.getSharedPreferences("mote", Context.MODE_PRIVATE).getBoolean("diagnosticsEnabled", false)) return
        // Diagnostic storage failure never changes capture/queue correctness.
        runCatching { journal(context).record(stage, code, elapsedMs, httpStatus) }
    }
    fun runtime(context: Context) = RuntimeLog(File(context.noBackupFilesDir, "mote.log"))
    fun journal(context: Context) = EventJournal(File(context.noBackupFilesDir, "support-events.json"))
    fun export(context: Context, hours: Int = 24): String {
        require(hours in setOf(1, 24, 168))
        val settings = Settings(context); val config = runCatching { settings.read() }.getOrNull()
        val metadata = JSONObject().put("platform", "android").put("version", BuildConfig.VERSION_NAME)
            .put("profile", BuildConfig.MOTE_PROFILE).put("applicationId", context.packageName).put("androidApi", Build.VERSION.SDK_INT)
        val state = JSONObject().put("captureEnabled", settings.enabled).put("accessibilityConnected", CaptureAccessibilityService.connected)
            .put("projectionRunning", ProjectionService.running)
        runCatching { state.put("queueDepth", context.queue().depth()).put("queueBytes", context.queue().bytes()) }
            .onFailure { state.put("queueReadable", false) }
        runCatching {
            val sources = context.localSources().sources()
            state.put("localSourceCount", sources.size).put("enabledLocalSourceCount", sources.count { it.enabled })
                .put("localSourceBytes", File(context.noBackupFilesDir, "local-sources").listFiles()?.sumOf { it.length() } ?: 0L)
        }.onFailure { state.put("localSourcesReadable", false) }
        val safeConfig = JSONObject()
        config?.let {
            safeConfig.put("configured", it.server.isNotBlank() && it.token.isNotBlank()).put("diagnosticsEnabled", it.diagnosticsEnabled)
                .put("intervalSeconds", it.intervalSeconds).put("maxQueueMiB", it.maxQueueMiB).put("wifiOnly", it.wifiOnly)
                .put("projectionMode", it.mode == "projection").put("jpegQuality", it.jpegQuality).put("captureMaxSide", it.captureMaxSide)
                .put("chargingOnly", it.chargingOnly).put("batteryPauseBelowPct", it.batteryPauseBelowPct)
                .put("localReviewConfigured", it.localReviewUrl.isNotBlank()).put("nsfwEnabled", it.nsfw.enabled)
                .put("reviewMaxSide", it.nsfw.reviewMaxSide).put("threads", it.nsfw.threads).put("timeoutMs", it.nsfw.timeoutMs)
        }
        val samples = runCatching { NumericSupport.sanitize(JSONObject(Diagnostics(context).export()).getJSONArray("samples")) }.getOrElse { JSONArray() }
        return JSONObject().put("version", 1).put("app", metadata).put("state", state).put("configuration", safeConfig)
            .put("logs", runtime(context).exportRange(System.currentTimeMillis() - hours * 3600000L)).put("events", journal(context).read()).put("samples", samples).put("batteryAttribution", "device-wide, not attributable to Mote").toString(2)
    }
}

object NumericSupport {
    private val numeric = setOf("atMs", "batteryPct", "chargeCounterUAh", "deviceBatteryDeltaPct", "queueBytes", "queueDepth", "modelBytes", "diagnosticsBytes", "capturedCount", "blockedCount", "failedCount", "uploadBytes", "inferenceMs", "ocrMs")
    fun sanitize(samples: JSONArray): JSONArray = JSONArray().also { output ->
        for (index in maxOf(0, samples.length() - 1440) until samples.length()) {
            val sample = samples.optJSONObject(index) ?: continue; val safe = JSONObject()
            numeric.forEach { key -> (sample.opt(key) as? Number)?.takeIf { it.toDouble().isFinite() }?.let { safe.put(key, it) } }
            (sample.opt("charging") as? Boolean)?.let { safe.put("charging", it) }
            output.put(safe)
        }
    }
}
