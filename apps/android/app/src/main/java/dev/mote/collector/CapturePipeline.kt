package dev.mote.collector

import android.app.KeyguardManager
import android.content.Context
import android.graphics.*
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

data class WindowSnapshot(val packages: Set<String>, val foreground: String?, val trustworthy: Boolean)

class CapturePipeline(private val context: Context) {
    private val settings = Settings(context)
    private val diagnostics = Diagnostics(context)
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val nsfw = NsfwClient(context)
    private val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    private var previousTime: Long? = null
    private var previousApp: String? = null
    @Volatile private var closed = false
    fun isBusy(): Boolean = busy.get()
    private var lastPause: OperationReason? = null
    fun pause(reason: String, category: OperationReason = OperationReason.STATE_CHANGED) {
        if (lastPause != category) { Operations.record(context, OperationKind.CAPTURE_PAUSED, category); lastPause = category }
        previousTime = null; previousApp = null
        settings.status("paused", reason)
    }
    fun canCapture(config: CollectorConfig, windows: WindowSnapshot): Boolean {
        if (closed || !settings.enabled || busy.get()) return false
        if (!unlocked(context)) { pause("锁屏或熄屏，暂停采集", OperationReason.LOCKED); return false }
        runCatching { diagnostics.sample(config) }
        val battery = Diagnostics.battery(context)
        if (config.chargingOnly && !battery.second) { pause("用户设置仅充电时采集", OperationReason.CHARGING); return false }
        if (config.batteryPauseBelowPct > 0 && (battery.first < 0 || battery.first < config.batteryPauseBelowPct)) { pause("达到用户设置的低电量暂停条件", OperationReason.BATTERY); return false }
        if (config.nsfw.enabled && !NsfwModelStore(context).hasFile()) { pause("NSFW 模型未就绪，请下载或导入；尚未截图", OperationReason.MODEL_MISSING); return false }
        val reason = PrivacyRules.excludedReason(PrivacyRules.exclusions(config.excludedPackages), windows.packages, windows.trustworthy)
        if (reason != null) { pause(reason, if (windows.trustworthy) OperationReason.EXCLUDED else OperationReason.WINDOW_UNKNOWN); return false }
        if (context.queue().bytes() >= config.maxQueueMiB * 1024L * 1024L) { pause("本地队列已满，等待成功上传后恢复", OperationReason.QUEUE_FULL); return false }
        return true
    }
    fun submit(bitmap: Bitmap, windows: WindowSnapshot, config: CollectorConfig, capturedAt: String = Instant.now().toString()) {
        if (closed || !busy.compareAndSet(false, true)) { bitmap.recycle(); return }
        ConnectionGuard.processing.incrementAndGet()
        try { executor.execute {
            var output: Bitmap? = null
            var stage = EventStage.CAPTURE
            try {
                Operations.record(context, OperationKind.FRAME_RECEIVED)
                if (!settings.enabled || !unlocked(context) || closed) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
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
                var text = ocr(output)
                var reviewed = false
                var modelMaskApplied = false
                if (config.localReviewUrl.isNotBlank()) {
                    stage = EventStage.PRIVACY
                    PrivacyRules.validateLocalReview(config.localReviewUrl)
                    val request = JSONObject().put("version", 1).put("imageBase64", Base64.encodeToString(jpeg(output, config.jpegQuality), Base64.NO_WRAP))
                        .put("imageMime", "image/jpeg").put("ocrText", text).put("appId", windows.foreground)
                    val (code, response) = HttpJson.post(config.localReviewUrl, request)
                    require(code == 200 && response != null && response.has("allow") && response.get("allow") is Boolean) { "隐私模型响应无效" }
                    if (!response.getBoolean("allow")) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.LOCAL_DENIED); pause("本机隐私模型阻止此帧", OperationReason.LOCAL_DENIED); return@execute }
                    val extraMasks = ReviewResponse.masks(response)
                    if (extraMasks.isNotEmpty()) { ImagePrivacy.applyMasks(output, extraMasks); text = ocr(output); modelMaskApplied = true }
                    reviewed = true
                }
                if (!settings.enabled || closed || !unlocked(context)) { Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED); return@execute }
                val now = SystemClock.elapsedRealtime()
                val duration = if (previousApp != null && previousApp == windows.foreground && previousTime != null)
                    (now - previousTime!!).coerceIn(0, config.intervalSeconds * 1000L) else 0L
                val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
                    .put("deviceName", config.deviceName).put("platform", "android").put("capturedAt", capturedAt)
                    .put("durationMs", duration).put("appId", windows.foreground).put("appName", windows.foreground ?: "未知应用")
                    .put("imageMime", "image/jpeg").put("ocrText", text).put("source", "screen")
                    .put("privacy", JSONObject().put("excluded", false).put("redacted", masks.isNotEmpty() || modelMaskApplied).put("mode", "local")
                        .put("reason", (if (config.nsfw.enabled) "local NSFW model passed; " else "") +
                            if (reviewed) "configured masks and local model review" else if (masks.isNotEmpty()) "configured masks applied" else "user configured capture without masks"))
                stage = EventStage.QUEUE
                context.queue().enqueue(event, jpeg(output, config.jpegQuality), config.maxQueueMiB * 1024L * 1024L)
                SupportEvents.record(context, stage, EventCode.OK)
                diagnostics.add("capturedCount")
                lastPause = null
                previousTime = now; previousApp = windows.foreground
                settings.captured(capturedAt)
                settings.status("capturing", "采集中 · 本地遮罩/OCR 已完成 · ${context.queue().depth()} 条待上传")
                UploadWorker.schedule(context, config)
            } catch (error: NsfwUnavailable) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.MODEL); SupportEvents.record(context, EventStage.MODEL, EventCode.MODEL_UNAVAILABLE); diagnostics.add("failedCount"); pause(error.message ?: "本机 NSFW 不可用，当前帧已跳过") }
            catch (error: QueueFull) { Operations.record(context, OperationKind.CAPTURE_FAILED, OperationReason.QUEUE_FULL); SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE); pause(error.message ?: "队列已满") }
            catch (error: Exception) { Operations.record(context, OperationKind.CAPTURE_FAILED, Operations.failure(error, stage)); SupportEvents.record(context, stage, EventJournal.failure(error, stage)); diagnostics.add("failedCount"); pause("本机 OCR、隐私审查或存储失败，此帧未入队；下一周期重试") }
            finally { output?.recycle(); bitmap.recycle(); busy.set(false); ConnectionGuard.processing.decrementAndGet() }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { ConnectionGuard.processing.decrementAndGet(); busy.set(false); bitmap.recycle(); Operations.record(context, OperationKind.FRAME_BLOCKED, OperationReason.CANCELLED) }
    }
    private fun ocr(bitmap: Bitmap): String {
        val started = SystemClock.elapsedRealtime()
        val input = InputImage.fromBitmap(bitmap, 0)
        val chineseText = Tasks.await(chinese.process(input), 30, TimeUnit.SECONDS).text
        val latinText = Tasks.await(latin.process(input), 30, TimeUnit.SECONDS).text
        diagnostics.timing("ocrMs", SystemClock.elapsedRealtime() - started)
        return listOf(chineseText, latinText).filter(String::isNotBlank).distinct().joinToString("\n").take(100_000)
    }
    private fun jpeg(bitmap: Bitmap, quality: Int): ByteArray = ByteArrayOutputStream().use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)); stream.toByteArray()
    }
    fun close() { closed = true; nsfw.close(); executor.execute { latin.close(); chinese.close() }; executor.shutdown() }
    companion object {
        fun unlocked(context: Context): Boolean = context.getSystemService(PowerManager::class.java).isInteractive &&
            !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    }
}
