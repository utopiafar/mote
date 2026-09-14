package dev.mote.collector

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.view.WindowManager
import java.time.Instant
import kotlin.math.roundToInt

class ProjectionService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private var pipeline: CapturePipeline? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private data class Pending(val windows: WindowSnapshot, val at: String, val requestedAt: Long)
    private var pending: Pending? = null
    private var displayWidth = 0
    private var displayHeight = 0
    private var config: CollectorConfig? = null
    private var lastTick = 0L
    private var closed = false
    private val callback = object : MediaProjection.Callback() {
        override fun onStop() {
            settings.enabled = false
            settings.status("permission_required", "投屏授权已结束（锁屏、系统或用户停止），请打开应用重新授权")
            stopSelf()
        }
        override fun onCapturedContentResize(width: Int, height: Int) {
            if (width > 0 && height > 0 && display != null) resize(width, height)
        }
    }
    private val tick = object : Runnable {
        override fun run() {
            val c = config ?: return
            if (!settings.enabled) { stopSelf(); return }
            UploadWorker.heartbeat(this@ProjectionService, c)
            if (!CapturePipeline.unlocked(this@ProjectionService)) {
                settings.enabled = false
                settings.status("permission_required", "已锁屏，投屏采集结束；解锁后请重新授权")
                stopSelf(); return
            }
            if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
                settings.enabled = false; settings.status("permission_required", "通知权限关闭，采集已停止"); stopSelf(); return
            }
            try {
                val windows = ForegroundApps.snapshot(this@ProjectionService)
                if (pending != null && (pending!!.windows != windows || CapturePipeline.policy(c, windows) != AppCollectionMode.CONTENT)) {
                    clearPending(); pipeline?.pause("窗口已变化，丢弃未读取屏幕帧")
                }
                if (pending != null && SystemClock.elapsedRealtime() - pending!!.requestedAt > 5000) {
                    clearPending(); pipeline?.pause("未收到屏幕帧；下一采样周期重试")
                }
                if (pending == null && SystemClock.elapsedRealtime() - lastTick >= c.intervalSeconds * 1000L) {
                    when (CapturePipeline.policy(c, windows)) {
                        AppCollectionMode.ACTIVITY -> if (pipeline?.canCollect(c, windows, AppCollectionMode.ACTIVITY) == true) {
                            lastTick = SystemClock.elapsedRealtime(); pipeline?.submitActivity(windows, c)
                        }
                        AppCollectionMode.CONTENT -> if (pipeline?.canCapture(c, windows) == true) {
                            lastTick = SystemClock.elapsedRealtime(); requestFrame(windows)
                        }
                        AppCollectionMode.OFF -> pipeline?.canCollect(c, windows, AppCollectionMode.OFF)
                    }
                }
                Notifications.show(this@ProjectionService, settings.message())
            } catch (_: Exception) { pipeline?.pause("投屏帧暂不可用，下一周期重试") }
            handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate() { super.onCreate(); settings = Settings(this) }
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (projection != null) return START_NOT_STICKY
        try {
            val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("consent", Intent::class.java) else {
                @Suppress("DEPRECATION") intent?.getParcelableExtra("consent")
            }
            require(data != null && intent?.getIntExtra("result", Activity.RESULT_CANCELED) == Activity.RESULT_OK)
            require(settings.enabled && intent.getStringExtra("configurationStamp") == ConnectionGuard.configurationStamp(this))
            config = settings.read().also { it.validate() }
            startForeground(Notifications.ID, Notifications.notification(this, "投屏采集已启动，可随时停止"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            projection = getSystemService(MediaProjectionManager::class.java).getMediaProjection(Activity.RESULT_OK, data)
            projection!!.registerCallback(callback, handler)
            pipeline = CapturePipeline(this)
            val bounds = if (Build.VERSION.SDK_INT >= 30) getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds else android.graphics.Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            createDisplay(bounds.width(), bounds.height())
            running = true; instance = this
            settings.status("capturing", "投屏采集已启动；每次会话都需系统授权")
            handler.post(tick)
        } catch (_: Exception) {
            settings.enabled = false
            settings.status("permission_required", "无法启动投屏，请重新点击开始并授予屏幕共享权限")
            stopSelf()
        }
        return START_NOT_STICKY
    }
    /** No Surface is attached until the live app policy grants this individual sample. */
    private fun requestFrame(windows: WindowSnapshot) {
        val c = config ?: return
        if (CapturePipeline.policy(c, windows) != AppCollectionMode.CONTENT || pending != null) return
        val source = ImageReader.newInstance(displayWidth, displayHeight, PixelFormat.RGBA_8888, 2)
        reader = source
        pending = Pending(windows, Instant.now().toString(), SystemClock.elapsedRealtime())
        source.setOnImageAvailableListener({ available ->
            val ticket = pending
            if (available !== reader || ticket == null) return@setOnImageAvailableListener
            val current = ForegroundApps.snapshot(this@ProjectionService)
            if (!settings.enabled || settings.read() != c || !CapturePipeline.unlocked(this@ProjectionService) || current != ticket.windows || CapturePipeline.policy(c, current) != AppCollectionMode.CONTENT) {
                clearPending(); return@setOnImageAvailableListener
            }
            val image = available.acquireLatestImage() ?: return@setOnImageAvailableListener
            display?.surface = null
            pending = null
            try {
                val plane = image.planes[0]
                val paddedWidth = image.width + (plane.rowStride - plane.pixelStride * image.width) / plane.pixelStride
                val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
                padded.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
                if (cropped !== padded) padded.recycle()
                pipeline?.submit(cropped, current, c, ticket.at, ticket.requestedAt) ?: cropped.recycle()
            } catch (_: Exception) { pipeline?.pause("投屏帧读取失败，未保存内容") }
            finally { image.close(); if (reader === available) { reader = null; available.setOnImageAvailableListener(null, null); available.close() } }
        }, handler)
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        display?.surface = source.surface
    }
    private fun clearPending() {
        display?.surface = null; pending = null
        reader?.setOnImageAvailableListener(null, null); reader?.close(); reader = null
    }
    fun onWindowChanged() {
        val ticket = pending ?: return
        val current = ForegroundApps.snapshot(this)
        if (ticket.windows != current || config?.let { CapturePipeline.policy(it, current) } != AppCollectionMode.CONTENT) clearPending()
    }
    private fun size(width: Int, height: Int) {
        val scale = minOf(1f, (config?.captureMaxSide ?: 1280).toFloat() / maxOf(width, height))
        displayWidth = (width * scale).roundToInt().coerceAtLeast(1)
        displayHeight = (height * scale).roundToInt().coerceAtLeast(1)
    }
    private fun createDisplay(width: Int, height: Int) {
        size(width, height)
        display = projection!!.createVirtualDisplay("Mote", displayWidth, displayHeight, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler)
    }
    private fun resize(width: Int, height: Int) {
        val beforeWidth = displayWidth; val beforeHeight = displayHeight
        size(width, height)
        if (beforeWidth == displayWidth && beforeHeight == displayHeight) return
        clearPending()
        display?.resize(displayWidth, displayHeight, resources.displayMetrics.densityDpi)
    }
    override fun onDestroy() {
        if (!closed) {
            closed = true; running = false; instance = null
            handler.removeCallbacksAndMessages(null)
            pipeline?.close(); pipeline = null
            clearPending(); display?.release(); display = null
            projection?.unregisterCallback(callback); projection?.stop(); projection = null
            settings.enabled = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            config?.let { UploadWorker.schedule(this, it) }
        }
        super.onDestroy()
    }
    companion object { @Volatile var running = false; private set; @Volatile var instance: ProjectionService? = null; private set }
}
