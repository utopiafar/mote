package dev.mote.collector

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.work.WorkManager
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Suspends producers, drains existing work, then applies one configuration without losing capture intent. */
object RuntimeSettings {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val stopGeneration = java.util.concurrent.atomic.AtomicLong()
    @Volatile var stopping = false; private set
    private val projectionConsent = ProjectionConsentHandoff()
    private var configurationObserver: (() -> Unit)? = null
    fun observeConfiguration(observer: (() -> Unit)?) { configurationObserver = observer }
    fun takeProjectionConsentRequest() = projectionConsent.take()
    fun observeProjectionConsent(observer: (() -> Unit)?) { if (observer == null) projectionConsent.detach() else projectionConsent.attach(observer) }
    fun cancelProjectionConsentRequest() = projectionConsent.cancel()
    @Volatile var currentConfiguration: CollectorConfig? = null; private set
    @Volatile private var progressMessage = ""
    @Volatile private var startedAt = 0L
    fun reportProgress(message: String) { progressMessage = message }
    fun progressLabel(): String = "$progressMessage · 已用 ${(SystemClock.elapsedRealtime() - startedAt) / 1000} 秒"
    data class Applied(val projectionConsentRequired: Boolean)
    fun stop(context: Context, finished: (kotlin.Result<Unit>) -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (stopping) return
        stopGeneration.incrementAndGet(); stopping = true
        startedAt = SystemClock.elapsedRealtime(); reportProgress("正在停止采集")
        val app = context.applicationContext
        val ownsHold = ConnectionGuard.beginReconfiguration()
        CaptureAccessibilityService.instance?.stopCapture()
        ProjectionService.instance?.pauseForConfiguration()
        MediaCollectionService.suspendObservation()
        executor.execute {
            val result = runCatching {
                Settings(app).enabled = false
                Operations.record(app, OperationKind.CAPTURE_STOPPED)
                SupportEvents.record(app, EventStage.CAPTURE, EventCode.STOPPED)
            }
            main.post {
                if (ownsHold) ConnectionGuard.endReconfiguration()
                app.stopService(android.content.Intent(app, ProjectionService::class.java))
                Notifications.clear(app); Notifications.clearMedia(app)
                MediaCollection.clear(); MediaCollectionService.refresh()
                stopping = false; finished(result)
            }
        }
    }
    fun apply(context: Context, next: CollectorConfig, bindLocal: Boolean = false, change: (() -> Unit)? = null,
        nextServer: String = if (next.hasSyncConnection()) next.server else "", expected: CollectorConfig? = null,
        finished: (kotlin.Result<Applied>) -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val app = context.applicationContext; val settings = Settings(app)
        next.validate()
        if (QueueStorage.recovering || !ConnectionGuard.beginReconfiguration()) { finished(kotlin.Result.failure(ConnectionFailure("busy"))); return }
        startedAt = SystemClock.elapsedRealtime(); reportProgress("正在暂停当前处理")
        val stopVersion = stopGeneration.get()
        val wasEnabled = settings.enabled
        try {
            CaptureAccessibilityService.instance?.stopCapture()
            MediaCollectionService.suspendObservation()
            ProjectionService.instance?.pauseForConfiguration()
            settings.status(if (wasEnabled) "capturing" else "paused", "正在保存设置…")
        } catch (error: Exception) {
            ConnectionGuard.endReconfiguration(); finished(kotlin.Result.failure(error)); return
        }
        executor.execute {
            val result = runCatching {
                reportProgress("正在等待后台处理结束")
                val work = WorkManager.getInstance(app)
                listOf("mote-heartbeat", "mote-heartbeat-now", "mote-sync-recovery", "mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload", "mote-source-scan", "mote-source-periodic", "mote-capture-ocr", "mote-capture-ocr-recovery")
                    .forEach { work.cancelUniqueWork(it).result.get(10, TimeUnit.SECONDS) }
                SyncSchedule.invalidate()
                val deadline = SystemClock.elapsedRealtime() + 120_000
                while (ConnectionGuard.processing.get() > 0) {
                    check(SystemClock.elapsedRealtime() < deadline) { "当前处理暂未结束，原设置已保留，请稍后重试" }
                    Thread.sleep(25)
                }
                reportProgress("正在验证并保存设置")
                ConnectionGuard.reconfigure(app, nextServer, bindLocal, expected) {
                    if (change == null) {
                        val discardImageComparisons = settings.read().imageDedupeDiagnosticsEnabled && !next.imageDedupeDiagnosticsEnabled
                        settings.save(next, expected)
                        if (discardImageComparisons) app.imageDedupeDiagnostics().clear()
                        ImageDedupeDiagnosticsMaintenance.configure(app, next.imageDedupeDiagnosticsEnabled)
                    } else change()
                }
            }
            // Also validate the still-saved configuration after a failed apply. The selected
            // directory can wait behind recovery/migration; keep that wait off the UI thread.
            reportProgress("正在验证存储并恢复运行")
            val current = runCatching {
                settings.read().also { app.queue().depth() }
            }
            currentConfiguration = current.getOrNull()
            main.post {
                val applied = runCatching {
                    val config = current.getOrThrow()
                    val enabled = settings.enabled && (config.screenCollectionEnabled || config.observesSystem()) && stopVersion == stopGeneration.get()
                    if (!config.screenCollectionEnabled && !config.observesSystem()) executor.execute { settings.enabled = false }
                    val resume = wasEnabled && enabled
                    var needsConsent = false
                    when (captureResume(wasEnabled, enabled, if (config.screenCollectionEnabled) config.effectiveMode() else "accessibility", ProjectionService.instance != null)) {
                        CaptureResume.EXISTING_PROJECTION -> ProjectionService.instance!!.applyConfiguration(config)
                        CaptureResume.NEW_PROJECTION -> {
                            if (!config.observesSystem()) { executor.execute { settings.enabled = false }; needsConsent = true }
                        }
                        CaptureResume.ACCESSIBILITY -> {
                            ProjectionService.instance?.finishForModeChange()
                            CaptureAccessibilityService.instance?.stopCapture()
                        }
                        CaptureResume.STOPPED -> Unit
                    }
                    if (result.isSuccess) settings.status(if (resume && !needsConsent) "capturing" else "paused", if (resume && !needsConsent) "设置已保存" else if (needsConsent) "设置已生效，请授权新的投屏会话" else "设置已保存")
                    else settings.status(if (resume && !needsConsent) "capturing" else "paused", "设置未完成，继续使用当前已保存配置")
                    Applied(needsConsent)
                }.onFailure { executor.execute { settings.enabled = false }; settings.status("error", "采集恢复失败：${it.message ?: "请检查权限和所选存储位置"}") }
                ConnectionGuard.endReconfiguration()
                CaptureAccessibilityService.instance?.refreshSchedule()
                MediaCollectionService.refresh()
                if (result.isSuccess && applied.getOrNull()?.projectionConsentRequired == true) projectionConsent.request()
                executor.execute {
                    val scheduled = runCatching {
                        if (applied.isSuccess) current.getOrNull()?.let { config ->
                            UploadWorker.schedule(app, config)
                            CaptureOcrWorker.schedule(app, config, replace = true)
                            SourceWork.schedule(app)
                        }
                    }.onFailure { settings.uploadStatus("设置已保存，同步调度暂不可用：${it.message ?: "请稍后重试"}") }
                    main.post {
                        finished(when {
                            result.isFailure -> kotlin.Result.failure(result.exceptionOrNull()!!)
                            applied.isFailure -> applied
                            scheduled.isFailure -> kotlin.Result.failure(scheduled.exceptionOrNull()!!)
                            else -> applied
                        })
                        // Deliver the committed snapshot to whichever MainActivity is now visible.
                        configurationObserver?.invoke()
                    }
                }
            }
        }
    }
}
