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
    private var frame: Bitmap? = null
    private var frameWindows: WindowSnapshot? = null
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
                if (SystemClock.elapsedRealtime() - lastTick >= c.intervalSeconds * 1000L && pipeline?.canCapture(c, windows) == true) {
                    if (frame != null && frameWindows == windows) {
                        Operations.record(this@ProjectionService, OperationKind.CAPTURE_REQUESTED)
                        pipeline?.submit(frame!!.copy(Bitmap.Config.ARGB_8888, false), windows, c, Instant.now().toString())
                        lastTick = SystemClock.elapsedRealtime()
                    } else pipeline?.pause("等待当前应用的新屏幕帧")
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
            running = true
            settings.status("capturing", "投屏采集已启动；每次会话都需系统授权")
            handler.post(tick)
        } catch (_: Exception) {
            settings.enabled = false
            settings.status("permission_required", "无法启动投屏，请重新点击开始并授予屏幕共享权限")
            stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun reader(width: Int, height: Int): ImageReader {
        val scale = minOf(1f, 1280f / maxOf(width, height))
        return ImageReader.newInstance((width * scale).roundToInt(), (height * scale).roundToInt(), PixelFormat.RGBA_8888, 2).apply {
            setOnImageAvailableListener({ source ->
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    if (!settings.enabled || !CapturePipeline.unlocked(this@ProjectionService)) return@setOnImageAvailableListener
                    val windows = ForegroundApps.snapshot(this@ProjectionService)
                    val plane = image.planes[0]
                    val paddedWidth = image.width + (plane.rowStride - plane.pixelStride * image.width) / plane.pixelStride
                    val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
                    padded.copyPixelsFromBuffer(plane.buffer)
                    val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
                    if (cropped !== padded) padded.recycle()
                    frame?.recycle(); frame = cropped; frameWindows = windows
                } finally { image.close() }
            }, handler)
        }
    }
    private fun createDisplay(width: Int, height: Int) {
        reader = reader(width, height)
        display = projection!!.createVirtualDisplay("Mote", reader!!.width, reader!!.height, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, handler)
    }
    private fun resize(width: Int, height: Int) {
        val next = reader(width, height)
        display?.resize(next.width, next.height, resources.displayMetrics.densityDpi)
        display?.surface = next.surface
        reader?.close(); reader = next
        frame?.recycle(); frame = null; frameWindows = null
    }
    override fun onDestroy() {
        if (!closed) {
            closed = true; running = false
            handler.removeCallbacksAndMessages(null)
            pipeline?.close(); pipeline = null
            display?.release(); display = null
            reader?.close(); reader = null
            frame?.recycle(); frame = null
            projection?.unregisterCallback(callback); projection?.stop(); projection = null
            settings.enabled = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            config?.let { UploadWorker.schedule(this, it, true) }
        }
        super.onDestroy()
    }
    companion object { @Volatile var running = false; private set }
}
