package dev.mote.collector

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import java.time.Instant

/** Passive screenshot/window package source. No node text, gestures, UI actions or hidden grants. */
class CaptureAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private var pipeline: CapturePipeline? = null
    private var inFlight = false
    private var nextCapture = 0L
    private var configurationGeneration = 0L
    private val tick = object : Runnable {
        override fun run() {
            try { collectIfEnabled() }
            catch (_: Exception) { settings.status("paused", "无障碍采集暂不可用，下一周期重试") }
            handler.postDelayed(this, 1000)
        }
    }
    override fun onServiceConnected() {
        super.onServiceConnected()
        settings = Settings(this)
        instance = this; connected = true
        handler.removeCallbacks(tick); handler.post(tick)
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) { ProjectionService.instance?.onWindowChanged() /* Never read event/node text. */ }
    override fun onInterrupt() {
        if (::settings.isInitialized) settings.status("permission_required", "无障碍服务中断，请检查系统设置")
    }
    fun windowSnapshot(): WindowSnapshot {
        return try {
            val all = windows
            val observed = all.map { window ->
                val root = window.root
                val name = root?.packageName?.toString()
                @Suppress("DEPRECATION") root?.recycle()
                CollectionWindow(window.type, name)
            }
            val root = rootInActiveWindow
            val foreground = root?.packageName?.toString()
            @Suppress("DEPRECATION") root?.recycle()
            // Keyboards and system/other overlays may contain private content even when inactive.
            CollectionWindows.snapshot(observed, foreground)
        } catch (_: Exception) { WindowSnapshot(emptySet(), null, false) }
    }
    private fun collectIfEnabled() {
        if (ConnectionGuard.reconfiguring()) return
        val config = settings.read()
        if (!settings.enabled || config.effectiveMode() != "accessibility") { stopCapture(); return }
        UploadWorker.heartbeat(this, config)
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            settings.enabled = false
            settings.status("permission_required", "通知权限已关闭，为保持采集可见已停止，请授权通知后重新开始")
            stopCapture(); return
        }
        if (pipeline == null) pipeline = CapturePipeline(this)
        Notifications.show(this, settings.message())
        if (inFlight || System.currentTimeMillis() < nextCapture || pipeline!!.isBusy()) return
        val snapshot = windowSnapshot()
        val mode = CapturePipeline.policy(config, snapshot)
        if (mode == AppCollectionMode.ACTIVITY) {
            if (pipeline!!.canCollect(config, snapshot, mode)) {
                nextCapture = System.currentTimeMillis() + config.intervalSeconds * 1000L
                pipeline!!.submitActivity(snapshot, config)
            }; return
        }
        if (!pipeline!!.canCapture(config, snapshot)) return
        if (Build.VERSION.SDK_INT < 30) { settings.status("permission_required", "此系统需投屏模式采集内容；仅应用活动无需截图API"); return }
        val capturePipeline = pipeline!!
        val generation = configurationGeneration
        inFlight = true
        nextCapture = System.currentTimeMillis() + config.intervalSeconds * 1000L
        val at = Instant.now().toString()
        val observedAtMs = android.os.SystemClock.elapsedRealtime()
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val current = windowSnapshot()
                    if (generation != configurationGeneration || ConnectionGuard.reconfiguring() || !settings.enabled || current != snapshot || CapturePipeline.policy(settings.read(), current) != AppCollectionMode.CONTENT || !CapturePipeline.unlocked(this@CaptureAccessibilityService)) return
                    val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: return
                    val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false)
                    hardware.recycle()
                    capturePipeline.submit(bitmap, current, config, at, observedAtMs)
                } finally { result.hardwareBuffer.close(); if (generation == configurationGeneration) inFlight = false }
            }
            override fun onFailure(errorCode: Int) {
                if (generation != configurationGeneration) return
                inFlight = false
                Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, OperationReason.SYSTEM)
                pipeline?.pause("系统未提供截图（代码 $errorCode），可能是安全窗口或权限变化；未保存内容")
            }
        })
    }
    fun stopCapture() {
        configurationGeneration++; nextCapture = 0; inFlight = false
        pipeline?.close(); pipeline = null
        if (!ProjectionService.running) Notifications.clear(this)
    }
    override fun onDestroy() {
        connected = false; instance = null
        handler.removeCallbacksAndMessages(null)
        stopCapture()
        if (::settings.isInitialized && settings.enabled) settings.status("permission_required", "无障碍服务未连接，等待系统恢复或打开设置重新启用")
        if (::settings.isInitialized) runCatching { UploadWorker.schedule(this, settings.read()) }
        super.onDestroy()
    }
    companion object {
        @Volatile var connected = false; private set
        @Volatile var instance: CaptureAccessibilityService? = null; private set
    }
}
