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
    private var dedupeSignature: String? = null
    private var dedupeConfig: CollectorConfig? = null
    private var dedupeSize: Pair<Int, Int>? = null
    private var dedupeApp: String? = null
    private data class DedupeReference(val signature: String, val captureId: String, val capturedAt: String, val image: ByteArray)
    private var dedupeReference: DedupeReference? = null
    private var earlySignature: String? = null
    private var earlyConfig: CollectorConfig? = null
    private var earlyWindows: WindowSnapshot? = null
    private var earlySize: Pair<Int, Int>? = null
    private var featurePixels = IntArray(0)
    private var previousTime: Long? = null
    private var previousApp: String? = null
    private var previousMode: AppCollectionMode? = null
    @Volatile private var closed = false
    fun isBusy(): Boolean = busy.get()
    private var lastPause: OperationReason? = null
    fun pause(reason: String, category: OperationReason = OperationReason.STATE_CHANGED) {
        if (lastPause != category) { Operations.record(context, OperationKind.CAPTURE_PAUSED, category); lastPause = category }
        previousTime = null; previousApp = null; previousMode = null; dedupeSignature = null; dedupeReference = null; earlySignature = null
        settings.status("paused", reason)
    }
    fun canCapture(config: CollectorConfig, windows: WindowSnapshot) = canCollect(config, windows, AppCollectionMode.CONTENT)
    fun canCollect(config: CollectorConfig, windows: WindowSnapshot, expected: AppCollectionMode): Boolean {
        if (closed || !config.screenCollectionEnabled || ConnectionGuard.changing() || !settings.enabled || busy.get()) return false
        val selected = policy(config, windows)
        if (selected == AppCollectionMode.OFF) { pause(if (!windows.trustworthy) MoteI18n.text("当前应用规则要求完整窗口信息，暂停本次采样") else MoteI18n.text("当前可见窗口的应用规则不允许本次采样"), if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); return false }
        if (selected != expected) return false
        if (!unlocked(context)) { pause(MoteI18n.text("锁屏或熄屏，暂停采集"), OperationReason.LOCKED); return false }
        val battery = Diagnostics.battery(context)
        if (config.chargingOnly && !battery.second) { pause(MoteI18n.text("用户设置仅充电时采集"), OperationReason.CHARGING); return false }
        if (config.batteryPauseBelowPct > 0 && (battery.first < 0 || battery.first < config.batteryPauseBelowPct)) { pause(MoteI18n.text("达到用户设置的低电量暂停条件"), OperationReason.BATTERY); return false }
        if (expected == AppCollectionMode.CONTENT && config.nsfw.enabled && !NsfwModelStore(context).hasFile()) { pause(MoteI18n.text("NSFW 模型未就绪，请下载或导入；尚未截图"), OperationReason.MODEL_MISSING); return false }
        val reason = PrivacyRules.excludedReason(PrivacyRules.exclusions(config.excludedPackages), windows.packages, windows.trustworthy)
        if (reason != null) { pause(reason, if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); return false }
        return true
    }
    private fun checkStorage(config: CollectorConfig) {
        // canCollect runs on service/UI callbacks. Queue accounting and diagnostic sampling
        // may scan legacy encrypted records, so run them only on the processing executor.
        runCatching { diagnostics.sample(config) }
        if (context.queue().bytes() >= config.maxQueueMiB * 1024L * 1024L) throw QueueFull()
    }
    fun submitActivity(windows: WindowSnapshot, config: CollectorConfig, capturedAt: String = Instant.now().toString(), observedAtMs: Long = SystemClock.elapsedRealtime()) {
        if (closed || !busy.compareAndSet(false, true)) return
        ConnectionGuard.processing.incrementAndGet()
        try { executor.execute {
            try {
                if (!settings.enabled || closed || !unlocked(context) || settings.read() != config || policy(config, windows) != AppCollectionMode.ACTIVITY) return@execute
                checkStorage(config)
                val now = observedAtMs
                val appId = requireNotNull(windows.foreground)
                val duration = duration(now, appId, AppCollectionMode.ACTIVITY, config.intervalSeconds)
                val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("capturedAt", capturedAt).put("durationMs", duration)
                    .put("appId", appId).put("appName", CollectorMetadata.appName(context, appId)).put("source", "activity")
                    .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))
                    .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context, if (config.effectiveMode() == "projection") "media_projection" else "accessibility", config.intervalSeconds * 1000L, activityOnly = true)) }
                SupportEvents.record(context, EventStage.QUEUE, EventCode.STARTED)
                settings.ensureDataOrigin(config)
                context.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
                SupportEvents.record(context, EventStage.QUEUE, EventCode.OK)
                dedupeSignature = null; dedupeReference = null
                previousTime = now; previousApp = appId; previousMode = AppCollectionMode.ACTIVITY; lastPause = null
                settings.captured(capturedAt); settings.status("capturing", MoteI18n.text("仅应用活动已保存；未请求截图、OCR或模型"))
                scheduleUpload(config)
            } catch (error: QueueFull) { Operations.record(context, OperationKind.ACTIVITY_FAILED, OperationReason.QUEUE_FULL); pause(error.message ?: MoteI18n.text("队列已满"), OperationReason.QUEUE_FULL) }
            catch (error: Exception) { Operations.record(context, OperationKind.ACTIVITY_FAILED, Operations.failure(error, EventStage.QUEUE)); pause(MoteI18n.text("应用活动未保存，请检查本机队列；未采集内容")) }
            finally { busy.set(false); ConnectionGuard.processing.decrementAndGet() }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { busy.set(false); ConnectionGuard.processing.decrementAndGet() }
    }
    private fun duration(now: Long, appId: String?, mode: AppCollectionMode, intervalSeconds: Int): Long =
        if (previousApp == appId && previousMode == mode && previousTime != null) SamplingTime.interval(previousTime!!, now, intervalSeconds * 1000L) else 0L
    fun submit(bitmap: Bitmap, windows: WindowSnapshot, config: CollectorConfig, capturedAt: String = Instant.now().toString(), observedAtMs: Long = SystemClock.elapsedRealtime()) {
        if (closed || !busy.compareAndSet(false, true)) { bitmap.recycle(); return }
        ConnectionGuard.processing.incrementAndGet()
        try { executor.execute {
            val pipelineStart = SystemClock.elapsedRealtime()
            var output: Bitmap? = null
            var stage = EventStage.CAPTURE
            try {
                Operations.record(context, OperationKind.FRAME_RECEIVED)
                diagnostics.add("receivedFrames")
                if (!settings.enabled || !unlocked(context) || closed || settings.read() != config || policy(config, windows) != AppCollectionMode.CONTENT) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
                val reason = PrivacyRules.excludedReason(PrivacyRules.exclusions(config.excludedPackages), windows.packages, windows.trustworthy)
                if (reason != null) { Operations.record(context, OperationKind.FRAME_BLOCKED, if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); pause(reason); return@execute }
                stage = EventStage.QUEUE
                checkStorage(config)
                // Approximate matches only discard this frame. They never inherit an approval,
                // image, or OCR result. Diagnostics deliberately retains the reviewed-pair path.
                if (earlyConfig != config || earlyWindows != windows || earlySize != (bitmap.width to bitmap.height)) earlySignature = null
                val earlyFeatures = if (config.imageDedupeMode != "off" && !config.imageDedupeDiagnosticsEnabled && windows.trustworthy && windows.foreground != null)
                    features(bitmap, ScreenshotDedupeHelper.Mode.fromRaw(config.imageDedupeMode)) else null
                if (earlyFeatures != null && ScreenshotDedupeHelper.shouldSkip(earlySignature, earlyFeatures, ScreenshotDedupeHelper.Mode.fromRaw(config.imageDedupeMode)).duplicate) {
                    if (!settings.enabled || closed || ConnectionGuard.changing() || settings.read() != config || !unlocked(context)) return@execute
                    val appId = requireNotNull(windows.foreground)
                    val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
                        .put("deviceName", config.deviceName).put("platform", "android").put("capturedAt", capturedAt)
                        .put("durationMs", duration(observedAtMs, appId, AppCollectionMode.CONTENT, config.intervalSeconds))
                        .put("appId", appId).put("appName", CollectorMetadata.appName(context, appId)).put("source", "activity")
                        .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))
                        .apply { if (config.metadataEnabled) put("metadata", CollectorMetadata.snapshot(context,
                            if (config.effectiveMode() == "projection") "media_projection" else "accessibility", config.intervalSeconds * 1000L, activityOnly = true)) }
                    settings.ensureDataOrigin(config)
                    context.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
                    diagnostics.add("earlySkippedFrames")
                    previousTime = observedAtMs; previousApp = appId; previousMode = AppCollectionMode.CONTENT
                    settings.captured(capturedAt); settings.status("capturing", MoteI18n.text("重复画面已丢弃，仅保存应用活动；未执行审查与 OCR"))
                    scheduleUpload(config)
                    return@execute
                }
                val inferenceStart = SystemClock.elapsedRealtime()
                stage = EventStage.MODEL
                if (config.nsfw.enabled) settings.status("capturing", MoteI18n.text("已收到画面，正在加载模型并进行本机隐私检查…"))
                if (config.nsfw.enabled) SupportEvents.record(context, stage, EventCode.STARTED)
                val decision = if (config.nsfw.enabled) { diagnostics.add("modelCalls"); nsfw.check(bitmap, config.nsfw) } else null
                if (decision != null) diagnostics.timing("inferenceMs", SystemClock.elapsedRealtime() - inferenceStart)
                if (decision?.allow == false) {
                    SupportEvents.record(context, stage, EventCode.FILTERED, SystemClock.elapsedRealtime() - inferenceStart)
                    Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.MODEL_DENIED, elapsedMs = SystemClock.elapsedRealtime() - inferenceStart)
                    diagnostics.add("blockedCount")
                    pause(MoteI18n.text("本机 NSFW 模型已过滤当前帧，未进入 OCR/保存/上传")); return@execute
                }
                if (decision != null) SupportEvents.record(context, stage, EventCode.OK, SystemClock.elapsedRealtime() - inferenceStart)
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
                if (runOcr) settings.status("capturing", MoteI18n.text("隐私检查已完成，正在识别文字…"))
                val ocrStart = SystemClock.elapsedRealtime()
                SupportEvents.record(context, stage, if (runOcr) EventCode.STARTED else EventCode.SCHEDULER)
                var text = if (runOcr) ocrInstance.value.recognize(output, config, windows.foreground) else ""
                if (runOcr) SupportEvents.record(context, stage, EventCode.OK, SystemClock.elapsedRealtime() - ocrStart)
                var reviewed = false
                var modelMaskApplied = false
                var appliedMaskCount = masks.size
                if (config.localReviewUrl.isNotBlank()) {
                    stage = EventStage.PRIVACY
                    SupportEvents.record(context, stage, EventCode.STARTED)
                    settings.status("capturing", MoteI18n.text("正在进行本机附加隐私检查…"))
                    PrivacyRules.validateLocalReview(config.localReviewUrl)
                    val request = JSONObject().put("version", 1).put("imageBase64", Base64.encodeToString(jpeg(output, config.jpegQuality), Base64.NO_WRAP))
                        .put("imageMime", "image/jpeg").put("ocrText", text).put("appId", windows.foreground)
                        .put("appName", windows.foreground?.let { CollectorMetadata.appName(context, it) })
                    val (code, response) = HttpJson.post(config.localReviewUrl, request)
                    require(code == 200 && response != null && response.has("allow") && response.get("allow") is Boolean) { MoteI18n.text("隐私模型响应无效") }
                    if (!response.getBoolean("allow")) { SupportEvents.record(context, stage, EventCode.FILTERED); Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.LOCAL_DENIED); pause(MoteI18n.text("本机隐私模型阻止此帧"), OperationReason.LOCAL_DENIED); return@execute }
                    val extraMasks = ReviewResponse.masks(response)
                    if (extraMasks.isNotEmpty()) { ImagePrivacy.applyMasks(output, extraMasks); text = if (runOcr) ocrInstance.value.recognize(output, config, windows.foreground) else ""; modelMaskApplied = true; appliedMaskCount += extraMasks.size }
                    reviewed = true
                    SupportEvents.record(context, stage, EventCode.OK)
                }
                if (!settings.enabled || closed || ConnectionGuard.changing() || settings.read() != config || !unlocked(context)) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
                if (dedupeConfig != config || dedupeApp != windows.foreground || dedupeSize != (output.width to output.height)) { dedupeSignature = null; dedupeReference = null }
                val dedupeMode = ScreenshotDedupeHelper.Mode.fromRaw(config.imageDedupeMode)
                val features = if (config.imageDedupeMode != "off") features(output, dedupeMode) else null
                val previousSignature = dedupeSignature
                val comparison = features?.let { ScreenshotDedupeHelper.shouldSkip(previousSignature, it, dedupeMode) }
                val duplicate = comparison?.duplicate == true
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
                if (duplicate) {
                    event.remove("imageMime")
                    event.put("ocrText", "").put("ocr", JSONObject().put("status", "disabled"))
                    val metadata = event.optJSONObject("metadata") ?: JSONObject().put("version", 1).put("observedAt", capturedAt)
                    val capture = metadata.optJSONObject("capture") ?: JSONObject()
                    capture.put("ocrEnabled", false).put("deduplication", JSONObject().put("mode", config.imageDedupeMode).put("duplicate", true))
                    event.put("metadata", metadata.put("capture", capture))
                }
                stage = EventStage.QUEUE
                SupportEvents.record(context, EventStage.QUEUE, EventCode.STARTED)
                settings.ensureDataOrigin(config)
                // Diagnostic pixels are encoded only after every privacy gate and final state check.
                // The local pair is never included in the upload event or upload queue.
                val encodeStart = SystemClock.elapsedRealtime()
                val encoded = if (!duplicate) jpeg(output, config.jpegQuality) else null
                if (!duplicate) diagnostics.timing("encodeMs", SystemClock.elapsedRealtime() - encodeStart)
                val queueStart = SystemClock.elapsedRealtime()
                context.queue().enqueue(event, encoded, config.maxQueueMiB * 1024L * 1024L)
                diagnostics.timing("queueMs", SystemClock.elapsedRealtime() - queueStart)
                if (!duplicate) runCatching {
                    val ratio = minOf(1f, 320f / maxOf(output.width, output.height))
                    val thumb = Bitmap.createScaledBitmap(output, maxOf(1, (output.width * ratio).roundToInt()), maxOf(1, (output.height * ratio).roundToInt()), true)
                    try { context.queue().cacheThumbnail(event.getString("id"), jpeg(thumb, 70), config.maxQueueMiB * 1024L * 1024L) }
                    finally { if (thumb !== output) thumb.recycle() }
                }
                if (duplicate && config.imageDedupeDiagnosticsEnabled && features != null) {
                    val reference = dedupeReference?.takeIf { it.signature == previousSignature }
                    if (reference != null) runCatching {
                        context.imageDedupeDiagnostics().record(ImageDedupeDiagnosticsDetails.metadata(dedupeMode, comparison!!,
                            reference.captureId, reference.capturedAt, event.getString("id"), capturedAt, windows.foreground,
                            output.width, output.height, features.width, features.height), reference.image, jpeg(output, config.jpegQuality))
                    }.onFailure { SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE) }
                }
                if (!duplicate) {
                    dedupeSignature = features?.toSignature()
                    // Retain the accepted reference, not the immediately preceding rejected frame.
                    dedupeReference = if (config.imageDedupeDiagnosticsEnabled && dedupeSignature != null && encoded != null)
                        DedupeReference(dedupeSignature!!, event.getString("id"), capturedAt, encoded) else null
                }
                // Reference advances only after durable storage of an accepted new frame.
                if (!duplicate) {
                    earlySignature = earlyFeatures?.toSignature(); earlyConfig = config
                    earlyWindows = windows; earlySize = bitmap.width to bitmap.height
                }
                dedupeConfig = config; dedupeApp = windows.foreground; dedupeSize = output.width to output.height
                SupportEvents.record(context, stage, EventCode.OK)
                diagnostics.add("capturedCount")
                lastPause = null
                previousTime = now; previousApp = windows.foreground; previousMode = AppCollectionMode.CONTENT
                settings.captured(capturedAt)
                settings.status("capturing", MoteI18n.text("采集中 · {0}", if (duplicate) MoteI18n.text("图片去重命中，仅元数据已保存") else if (runOcr) MoteI18n.text("本地遮罩/OCR 已完成") else MoteI18n.text("图片已保存，充电后补做 OCR")))
                if (!runOcr && !duplicate) CaptureOcrWorker.schedule(context, config)
                scheduleUpload(config)
            } catch (error: NsfwUnavailable) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.MODEL); SupportEvents.record(context, EventStage.MODEL, EventCode.MODEL_UNAVAILABLE); diagnostics.add("failedCount"); pause(error.message ?: MoteI18n.text("本机 NSFW 不可用，当前帧已跳过")) }
            catch (error: QueueFull) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.QUEUE_FULL); SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE); pause(error.message ?: MoteI18n.text("队列已满")) }
            catch (error: Exception) { Operations.record(context, OperationKind.CAPTURE_FAILED, Operations.failure(error, stage)); SupportEvents.record(context, stage, EventJournal.failure(error, stage)); diagnostics.add("failedCount"); pause(MoteI18n.text("本机 OCR、隐私审查或存储失败，此帧未入队；下一周期重试")) }
            finally { output?.recycle(); bitmap.recycle(); runCatching { diagnostics.timing("pipelineMs", SystemClock.elapsedRealtime() - pipelineStart) }; busy.set(false); ConnectionGuard.processing.decrementAndGet() }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { ConnectionGuard.processing.decrementAndGet(); busy.set(false); bitmap.recycle(); Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.CANCELLED) }
    }
    private fun features(bitmap: Bitmap, mode: ScreenshotDedupeHelper.Mode): ScreenshotDedupeHelper.FrameFeatures {
        val size = ScreenshotDedupeHelper.sampleSizeForMode(bitmap.width, bitmap.height, mode)
        val sample = Bitmap.createScaledBitmap(bitmap, size.width, size.height, true)
        try {
            val count = sample.width * sample.height
            if (featurePixels.size != count) featurePixels = IntArray(count)
            sample.getPixels(featurePixels, 0, sample.width, 0, 0, sample.width, sample.height)
            return ScreenshotDedupeHelper.buildFeatures(sample.width, sample.height, featurePixels)
        } finally { if (sample !== bitmap) sample.recycle() }
    }
    private fun jpeg(bitmap: Bitmap, quality: Int): ByteArray = ByteArrayOutputStream().use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)); stream.toByteArray()
    }
    @Synchronized fun close() { if (closed) return; closed = true; dedupeReference = null; if (nsfwInstance.isInitialized()) nsfw.close(); executor.execute { if (ocrInstance.isInitialized()) ocrInstance.value.close() }; executor.shutdown() }
    companion object {
        fun policy(config: CollectorConfig, windows: WindowSnapshot) = config.collectionRules.decide(windows, PrivacyRules.exclusions(config.excludedPackages))
        fun unlocked(context: Context): Boolean = context.getSystemService(PowerManager::class.java).isInteractive &&
            !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    }
}
