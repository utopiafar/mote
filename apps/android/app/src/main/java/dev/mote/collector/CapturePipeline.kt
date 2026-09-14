package dev.mote.collector

import android.app.KeyguardManager
import android.content.Context
import android.graphics.*
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

data class WindowSnapshot(val packages: Set<String>, val foreground: String?, val trustworthy: Boolean)

class CapturePipeline(private val context: Context, private val scheduleUpload: (CollectorConfig) -> Unit = { UploadWorker.schedule(context, it) }) {
    private val settings = Settings(context)
    private val diagnostics = Diagnostics(context)
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val nsfwInstance = lazy { NsfwClient(context) }
    private val ocrInstance = lazy { CaptureOcr(context) }
    private val nsfw by nsfwInstance
    private var previousTime: Long? = null
    private var previousApp: String? = null
    private var previousMode: AppCollectionMode? = null
    @Volatile private var closed = false
    fun isBusy(): Boolean = busy.get()
    private var lastPause: OperationReason? = null
    fun pause(reason: String, category: OperationReason = OperationReason.STATE_CHANGED) {
        if (lastPause != category) { Operations.record(context, OperationKind.CAPTURE_PAUSED, category); lastPause = category }
        previousTime = null; previousApp = null; previousMode = null
        settings.status("paused", reason)
    }
    fun canCapture(config: CollectorConfig, windows: WindowSnapshot) = canCollect(config, windows, AppCollectionMode.CONTENT)
    fun canCollect(config: CollectorConfig, windows: WindowSnapshot, expected: AppCollectionMode): Boolean {
        if (closed || !settings.enabled || busy.get()) return false
        val selected = policy(config, windows)
        if (selected == AppCollectionMode.OFF) { pause(if (!windows.trustworthy) "当前应用规则要求完整窗口信息，暂停本次采样" else "当前可见窗口的应用规则不允许本次采样", if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); return false }
        if (selected != expected) return false
        if (!unlocked(context)) { pause("锁屏或熄屏，暂停采集", OperationReason.LOCKED); return false }
        runCatching { diagnostics.sample(config) }
        val battery = Diagnostics.battery(context)
        if (config.chargingOnly && !battery.second) { pause("用户设置仅充电时采集", OperationReason.CHARGING); return false }
        if (config.batteryPauseBelowPct > 0 && (battery.first < 0 || battery.first < config.batteryPauseBelowPct)) { pause("达到用户设置的低电量暂停条件", OperationReason.BATTERY); return false }
        if (expected == AppCollectionMode.CONTENT && config.nsfw.enabled && !NsfwModelStore(context).hasFile()) { pause("NSFW 模型未就绪，请下载或导入；尚未截图", OperationReason.MODEL_MISSING); return false }
        val reason = PrivacyRules.excludedReason(PrivacyRules.exclusions(config.excludedPackages), windows.packages, windows.trustworthy)
        if (reason != null) { pause(reason, if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); return false }
        if (context.queue().bytes() >= config.maxQueueMiB * 1024L * 1024L) { pause("本机空间已满，请同步释放空间或调大存储上限", OperationReason.QUEUE_FULL); return false }
        return true
    }
    fun submitActivity(windows: WindowSnapshot, config: CollectorConfig, capturedAt: String = Instant.now().toString(), observedAtMs: Long = SystemClock.elapsedRealtime()) {
        if (closed || !busy.compareAndSet(false, true)) return
        ConnectionGuard.processing.incrementAndGet()
        try { executor.execute {
            try {
                if (!settings.enabled || closed || !unlocked(context) || settings.read() != config || policy(config, windows) != AppCollectionMode.ACTIVITY) return@execute
                val now = observedAtMs
                val appId = requireNotNull(windows.foreground)
                val duration = duration(now, appId, AppCollectionMode.ACTIVITY, config.intervalSeconds)
                val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("capturedAt", capturedAt).put("durationMs", duration)
                    .put("appId", appId).put("appName", CollectorMetadata.appName(context, appId)).put("source", "activity")
                    .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))
                    .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context, if (config.effectiveMode() == "projection") "media_projection" else "accessibility", config.intervalSeconds * 1000L)) }
                settings.ensureDataOrigin(config)
                context.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
                previousTime = now; previousApp = appId; previousMode = AppCollectionMode.ACTIVITY; lastPause = null
                settings.captured(capturedAt); settings.status("capturing", "仅应用活动已保存；未请求截图、OCR或模型 · ${context.queue().depth()} 条保存在本机")
                scheduleUpload(config)
            } catch (error: Exception) { Operations.record(context, OperationKind.ACTIVITY_FAILED, Operations.failure(error, EventStage.QUEUE)); pause("应用活动未保存，请检查本机队列；未采集内容") }
            finally { busy.set(false); ConnectionGuard.processing.decrementAndGet() }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { busy.set(false); ConnectionGuard.processing.decrementAndGet() }
    }
    private fun duration(now: Long, appId: String?, mode: AppCollectionMode, intervalSeconds: Int): Long =
        if (previousApp == appId && previousMode == mode && previousTime != null) SamplingTime.interval(previousTime!!, now, intervalSeconds * 1000L) else 0L
    fun submit(bitmap: Bitmap, windows: WindowSnapshot, config: CollectorConfig, capturedAt: String = Instant.now().toString(), observedAtMs: Long = SystemClock.elapsedRealtime()) {
        if (closed || !busy.compareAndSet(false, true)) { bitmap.recycle(); return }
        ConnectionGuard.processing.incrementAndGet()
        try { executor.execute {
            var output: Bitmap? = null
            var stage = EventStage.CAPTURE
            try {
                Operations.record(context, OperationKind.FRAME_RECEIVED)
                if (!settings.enabled || !unlocked(context) || closed || settings.read() != config || policy(config, windows) != AppCollectionMode.CONTENT) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
                val reason = PrivacyRules.excludedReason(PrivacyRules.exclusions(config.excludedPackages), windows.packages, windows.trustworthy)
                if (reason != null) { Operations.record(context, OperationKind.FRAME_BLOCKED, if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); pause(reason); return@execute }
                val inferenceStart = SystemClock.elapsedRealtime()
                stage = EventStage.MODEL
                val decision = if (config.nsfw.enabled) nsfw.check(bitmap, config.nsfw) else null
                if (decision != null) diagnostics.timing("inferenceMs", SystemClock.elapsedRealtime() - inferenceStart)
                if (decision?.allow == false) {
                    SupportEvents.record(context, stage, EventCode.FILTERED, SystemClock.elapsedRealtime() - inferenceStart)
                    Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.MODEL_DENIED, elapsedMs = SystemClock.elapsedRealtime() - inferenceStart)
                    diagnostics.add("blockedCount")
                    pause("本机 NSFW 模型已过滤当前帧，未进入 OCR/保存/上传"); return@execute
                }
                output = bitmap.copy(Bitmap.Config.ARGB_8888, true)
                val masks = Mask.parse(config.masks)
                ImagePrivacy.applyMasks(output, masks)
                val scale = minOf(1f, config.captureMaxSide.toFloat() / maxOf(output.width, output.height))
                if (scale < 1f) {
                    val resized = Bitmap.createScaledBitmap(output, (output.width * scale).roundToInt(), (output.height * scale).roundToInt(), true)
                    output.recycle(); output = resized
                }
                stage = EventStage.OCR
                val runOcr = !config.ocrChargingOnly || Diagnostics.battery(context).second
                var text = if (runOcr) ocrInstance.value.recognize(output) else ""
                var reviewed = false
                var modelMaskApplied = false
                var appliedMaskCount = masks.size
                if (config.localReviewUrl.isNotBlank()) {
                    stage = EventStage.PRIVACY
                    PrivacyRules.validateLocalReview(config.localReviewUrl)
                    val request = JSONObject().put("version", 1).put("imageBase64", Base64.encodeToString(jpeg(output, config.jpegQuality), Base64.NO_WRAP))
                        .put("imageMime", "image/jpeg").put("ocrText", text).put("appId", windows.foreground)
                    val (code, response) = HttpJson.post(config.localReviewUrl, request)
                    require(code == 200 && response != null && response.has("allow") && response.get("allow") is Boolean) { "隐私模型响应无效" }
                    if (!response.getBoolean("allow")) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.LOCAL_DENIED); pause("本机隐私模型阻止此帧", OperationReason.LOCAL_DENIED); return@execute }
                    val extraMasks = ReviewResponse.masks(response)
                    if (extraMasks.isNotEmpty()) { ImagePrivacy.applyMasks(output, extraMasks); text = if (runOcr) ocrInstance.value.recognize(output) else ""; modelMaskApplied = true; appliedMaskCount += extraMasks.size }
                    reviewed = true
                }
                if (!settings.enabled || closed || !unlocked(context)) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
                val now = observedAtMs
                val duration = duration(now, windows.foreground, AppCollectionMode.CONTENT, config.intervalSeconds)
                val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("capturedAt", capturedAt)
                    .put("durationMs", duration).put("appId", windows.foreground).put("appName", windows.foreground?.let { CollectorMetadata.appName(context, it) })
                    .put("imageMime", "image/jpeg").put("ocrText", text).put("source", "screen")
                    .put("ocr", JSONObject().put("status", if (runOcr) "completed" else "pending").apply { if (!runOcr) put("reason", "charging") })
                    .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context, if (config.effectiveMode() == "projection") "media_projection" else "accessibility", config.intervalSeconds * 1000L).apply {
                        getJSONObject("capture").put("width", output.width).put("height", output.height).put("ocrEnabled", runOcr)
                        if (appliedMaskCount <= 200) getJSONObject("capture").put("maskCount", appliedMaskCount)
                    }) }
                    .put("privacy", JSONObject().put("excluded", false).put("redacted", masks.isNotEmpty() || modelMaskApplied).put("mode", "local").put("collection", "content")
                        .put("reason", (if (config.nsfw.enabled) "local NSFW model passed; " else "") +
                            if (reviewed) "configured masks and local model review" else if (masks.isNotEmpty()) "configured masks applied" else "user configured capture without masks"))
                stage = EventStage.QUEUE
                settings.ensureDataOrigin(config)
                context.queue().enqueue(event, jpeg(output, config.jpegQuality), config.maxQueueMiB * 1024L * 1024L)
                SupportEvents.record(context, stage, EventCode.OK)
                diagnostics.add("capturedCount")
                lastPause = null
                previousTime = now; previousApp = windows.foreground; previousMode = AppCollectionMode.CONTENT
                settings.captured(capturedAt)
                settings.status("capturing", "采集中 · ${if (runOcr) "本地遮罩/OCR 已完成" else "图片已保存，充电后补做 OCR"} · ${context.queue().depth()} 条保存在本机")
                if (!runOcr) CaptureOcrWorker.schedule(context, config)
                scheduleUpload(config)
            } catch (error: NsfwUnavailable) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.MODEL); SupportEvents.record(context, EventStage.MODEL, EventCode.MODEL_UNAVAILABLE); diagnostics.add("failedCount"); pause(error.message ?: "本机 NSFW 不可用，当前帧已跳过") }
            catch (error: QueueFull) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.QUEUE_FULL); SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE); pause(error.message ?: "队列已满") }
            catch (error: Exception) { Operations.record(context, OperationKind.CAPTURE_FAILED, Operations.failure(error, stage)); SupportEvents.record(context, stage, EventJournal.failure(error, stage)); diagnostics.add("failedCount"); pause("本机 OCR、隐私审查或存储失败，此帧未入队；下一周期重试") }
            finally { output?.recycle(); bitmap.recycle(); busy.set(false); ConnectionGuard.processing.decrementAndGet() }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { ConnectionGuard.processing.decrementAndGet(); busy.set(false); bitmap.recycle(); Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.CANCELLED) }
    }
    private fun jpeg(bitmap: Bitmap, quality: Int): ByteArray = ByteArrayOutputStream().use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)); stream.toByteArray()
    }
    fun close() { closed = true; if (nsfwInstance.isInitialized()) nsfw.close(); executor.execute { if (ocrInstance.isInitialized()) ocrInstance.value.close() }; executor.shutdown() }
    companion object {
        fun policy(config: CollectorConfig, windows: WindowSnapshot) = AppCollectionRules.parse(config.appCollectionRules).decide(windows, PrivacyRules.exclusions(config.excludedPackages))
        fun unlocked(context: Context): Boolean = context.getSystemService(PowerManager::class.java).isInteractive &&
            !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    }
}
