package dev.mote.collector

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import java.time.Instant

/** Passive screenshot/window package source. No node text, gestures, UI actions or hidden grants. */
class CaptureAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private var pipeline: CapturePipeline? = null
    private var inFlight = false
    private var nextCapture = 0L
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
    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* Read only live window package identities at capture time. */ }
    override fun onInterrupt() {
        if (::settings.isInitialized) settings.status("permission_required", "无障碍服务中断，请检查系统设置")
    }
    fun windowSnapshot(): WindowSnapshot {
        return try {
            val all = windows
            val apps = all.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            val packages = apps.map { window ->
                val root = window.root
                val name = root?.packageName?.toString()
                @Suppress("DEPRECATION") root?.recycle()
                name
            }
            val root = rootInActiveWindow
            val foreground = root?.packageName?.toString()
            @Suppress("DEPRECATION") root?.recycle()
            // Unknown app roots, overlays and multiple app windows cannot enforce exclusions safely.
            val trustworthy = apps.size == 1 && packages.all { !it.isNullOrBlank() } && foreground in packages &&
                all.none { it.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY || (it.type == AccessibilityWindowInfo.TYPE_SYSTEM && it.isActive) }
            WindowSnapshot(packages.filterNotNull().toSet(), foreground, trustworthy)
        } catch (_: Exception) { WindowSnapshot(emptySet(), null, false) }
    }
    private fun collectIfEnabled() {
        val config = settings.read()
        if (!settings.enabled || config.mode != "accessibility") { stopCapture(); return }
        UploadWorker.heartbeat(this, config)
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            settings.enabled = false
            settings.status("permission_required", "通知权限已关闭，为保持采集可见已停止，请授权通知后重新开始")
            stopCapture(); return
        }
        if (Build.VERSION.SDK_INT < 30) { settings.status("permission_required", "此系统需使用投屏模式（Android 11+ 支持无障碍截图）"); return }
        if (pipeline == null) pipeline = CapturePipeline(this)
        Notifications.show(this, settings.message())
        if (inFlight || System.currentTimeMillis() < nextCapture || pipeline!!.isBusy()) return
        val snapshot = windowSnapshot()
        if (!pipeline!!.canCapture(config, snapshot)) return
        val capturePipeline = pipeline!!
        inFlight = true
        nextCapture = System.currentTimeMillis() + config.intervalSeconds * 1000L
        val at = Instant.now().toString()
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val current = windowSnapshot()
                    if (!settings.enabled || current != snapshot || !CapturePipeline.unlocked(this@CaptureAccessibilityService)) return
                    val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: return
                    val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false)
                    hardware.recycle()
                    capturePipeline.submit(bitmap, current, config, at)
                } finally { result.hardwareBuffer.close(); inFlight = false }
            }
            override fun onFailure(errorCode: Int) {
                inFlight = false
                Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, OperationReason.SYSTEM)
                pipeline?.pause("系统未提供截图（代码 $errorCode），可能是安全窗口或权限变化；未保存内容")
            }
        })
    }
    fun stopCapture() {
        pipeline?.close(); pipeline = null
        if (!ProjectionService.running) Notifications.clear(this)
    }
    override fun onDestroy() {
        connected = false; instance = null
        handler.removeCallbacksAndMessages(null)
        stopCapture()
        if (::settings.isInitialized && settings.enabled) settings.status("permission_required", "无障碍服务未连接，等待系统恢复或打开设置重新启用")
        if (::settings.isInitialized) runCatching { UploadWorker.schedule(this, settings.read(), true) }
        super.onDestroy()
    }
    companion object {
        @Volatile var connected = false; private set
        @Volatile var instance: CaptureAccessibilityService? = null; private set
    }
}
