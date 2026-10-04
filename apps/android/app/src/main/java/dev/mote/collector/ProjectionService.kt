package dev.mote.collector

import android.app.*
import android.content.Intent
import android.content.res.Configuration
import android.content.pm.ServiceInfo
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
    private var sourceWidth = 0
    private var sourceHeight = 0
    @Volatile private var preserveEnabledOnStop = false
    private var config: CollectorConfig? = null
    private var lastTick = 0L
    @Volatile private var closed = false
    @Volatile private var generation = 0L
    private var starting = false
    private var ending = false
    private var instanceGeneration = 0L
    private val state = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var copying = false
    private var checking: Long? = null
    private var checkSequence = 0L
    @Volatile private var statusPending = false
    private val pixels = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(1))
    private val callback = object : MediaProjection.Callback() {
        override fun onStop() {
            if (!closed && instanceGeneration == instances.get()) RuntimeSettings.cancelProjectionConsentRequest()
            projectionEnded(MoteI18n.text("投屏授权已结束（锁屏、系统或用户停止），请打开应用重新授权"))
            stopSelf()
        }
        override fun onCapturedContentResize(width: Int, height: Int) {
            if (width > 0 && height > 0 && display != null) resize(width, height)
        }
    }
    private val tick = object : Runnable {
        override fun run() {
            if (closed || ending || !::settings.isInitialized) return
            if (ConnectionGuard.reconfiguring()) { handler.postDelayed(this, 1000); return }
            val c = config ?: return
            if (!settings.enabled) { stopSelf(); return }
            if (!CapturePipeline.unlocked(this@ProjectionService)) {
                projectionEnded(MoteI18n.text("已锁屏，投屏采集结束；解锁后请重新授权"))
                stopSelf(); return
            }
            if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
                generation++; ending = true; clearPending(); pipeline?.close(); pipeline = null
                state.execute { if (instanceGeneration == instances.get()) { settings.enabled = false; settings.status("permission_required", MoteI18n.text("通知权限关闭，采集已停止")) } }
                stopSelf(); return
            }
            try {
                val windows = ForegroundApps.snapshot(this@ProjectionService)
                if (pending != null && (pending!!.windows != windows || CapturePipeline.policy(c, windows) != AppCollectionMode.CONTENT)) {
                    clearPending(); pausePipeline(MoteI18n.text("窗口已变化，丢弃未读取屏幕帧"))
                }
                if (pending != null && SystemClock.elapsedRealtime() - pending!!.requestedAt > 5000) {
                    clearPending(); pausePipeline(MoteI18n.text("未收到屏幕帧；下一采样周期重试"))
                }
                if (pending == null && !copying && checking == null && SystemClock.elapsedRealtime() - lastTick >= c.intervalSeconds * 1000L) checkEligibility(c, windows)
                val ticket = generation
                if (!statusPending) {
                    statusPending = true
                    state.execute { try {
                        if (!closed && !ending && ticket == generation && config == c && !ConnectionGuard.changing()) {
                            UploadWorker.heartbeat(this@ProjectionService, c)
                            Notifications.show(this@ProjectionService, LocalStateRepository.get(this@ProjectionService).state.value.captureLabel)
                        }
                    } finally { statusPending = false } }
                }
            } catch (_: Exception) { pausePipeline(MoteI18n.text("投屏帧暂不可用，下一周期重试")) }
            handler.postDelayed(this, 1000)
        }
    }
    private fun pausePipeline(message: String) {
        val selected = pipeline ?: return; val ticket = generation
        state.execute { if (!closed && ticket == generation && selected === pipeline) selected.pause(message) }
    }
    private fun checkEligibility(c: CollectorConfig, windows: WindowSnapshot) {
        val selected = pipeline ?: return
        val ticket = generation; val request = ++checkSequence; checking = request
        val mode = CapturePipeline.policy(c, windows)
        state.execute {
            val allowed = runCatching { !closed && ticket == generation && settings.read() == c && selected.canCollect(c, windows, mode) }.getOrDefault(false)
            handler.post {
                if (checking != request) return@post
                checking = null
                if (!allowed || closed || ending || ticket != generation || ConnectionGuard.changing() || !settings.enabled || config != c ||
                    selected !== pipeline || !CapturePipeline.unlocked(this) || ForegroundApps.snapshot(this) != windows) return@post
                when (mode) {
                    AppCollectionMode.ACTIVITY -> { lastTick = SystemClock.elapsedRealtime(); selected.submitActivity(windows, c) }
                    AppCollectionMode.CONTENT -> { lastTick = SystemClock.elapsedRealtime(); requestFrame(windows) }
                    AppCollectionMode.OFF -> Unit
                }
            }
        }
    }
    override fun onCreate() { super.onCreate(); instanceGeneration = instances.incrementAndGet() }
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (projection != null || starting || closed || ending) return START_NOT_STICKY
        try {
            val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("consent", Intent::class.java) else {
                @Suppress("DEPRECATION") intent?.getParcelableExtra("consent")
            }
            require(data != null && intent?.getIntExtra("result", Activity.RESULT_CANCELED) == Activity.RESULT_OK)
            val expectedStamp = intent.getStringExtra("configurationStamp")
            starting = true
            val ticket = ++generation
            // Meet the foreground-service deadline before a settings writer can delay validation.
            // No display or Surface exists until the background validation succeeds.
            startForeground(Notifications.ID, Notifications.notification(this, MoteI18n.text("投屏采集已启动，可随时停止")), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            state.execute {
                val prepared = runCatching {
                    val opened = Settings(this)
                    val current = opened.read().also { it.validate() }
                    check(opened.enabled && expectedStamp == SourceRules.hash(current.toString()) && current.screenCollectionEnabled && current.effectiveMode() == "projection")
                    val ready = CapturePipeline(this)
                    try { check(opened.enabled && opened.read() == current); Triple(opened, current, ready) }
                    catch (error: Exception) { ready.close(); throw error }
                }
                handler.post {
                    if (closed || ending || ticket != generation || instanceGeneration != instances.get()) {
                        prepared.getOrNull()?.third?.close(); return@post
                    }
                    starting = false
                    prepared.onSuccess { (opened, current, readyPipeline) ->
                        if (ConnectionGuard.changing() || !opened.enabled) { readyPipeline.close(); stopSelf(); return@onSuccess }
                        runCatching {
                            settings = opened; config = current; pipeline = readyPipeline
                            projection = getSystemService(MediaProjectionManager::class.java).getMediaProjection(Activity.RESULT_OK, data)
                            projection!!.registerCallback(callback, handler)
                            val bounds = if (Build.VERSION.SDK_INT >= 30) getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds else android.graphics.Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
                            createDisplay(bounds.width(), bounds.height())
                            running = true; instance = this
                            state.execute { if (!closed && ticket == generation) opened.status("capturing", MoteI18n.text("投屏采集已启动；每次会话都需系统授权")) }
                            handler.post(tick)
                        }.onFailure { projectionEnded(MoteI18n.text("无法启动投屏，请重新点击开始并授予屏幕共享权限")); stopSelf() }
                    }.onFailure { projectionEnded(MoteI18n.text("无法启动投屏，请重新点击开始并授予屏幕共享权限")); stopSelf() }
                }
            }
        } catch (_: Exception) {
            projectionEnded(MoteI18n.text("无法启动投屏，请重新点击开始并授予屏幕共享权限"))
            stopSelf()
        }
        return START_NOT_STICKY
    }
    /** No Surface is attached until the live app policy grants this individual sample. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // API 29–33 have no onCapturedContentResize callback. Rebuild the Surface on rotation.
        if (Build.VERSION.SDK_INT < 34 && display != null) {
            val bounds = if (Build.VERSION.SDK_INT >= 30) getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
                else android.graphics.Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            resize(bounds.width(), bounds.height())
        }
    }
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
            if (!settings.enabled || ConnectionGuard.changing() || !CapturePipeline.unlocked(this@ProjectionService) || current != ticket.windows || CapturePipeline.policy(c, current) != AppCollectionMode.CONTENT) {
                clearPending(); return@setOnImageAvailableListener
            }
            display?.surface = null
            pending = null
            // The worker owns this detached image/reader until its copy completes.
            reader = null; available.setOnImageAvailableListener(null, null); copying = true
            val capturePipeline = pipeline
            val captureGeneration = generation
            try { pixels.execute {
                var cropped: android.graphics.Bitmap? = null
                try {
                    // Validate before materializing even a pixel from the detached reader.
                    if (!closed && !ending && captureGeneration == generation && !ConnectionGuard.changing() && settings.enabled && settings.read() == c &&
                        CapturePipeline.unlocked(this@ProjectionService) && SystemClock.elapsedRealtime() - ticket.requestedAt <= 5000) {
                        val image = available.acquireLatestImage()
                        if (image != null) try { cropped = CapturedFrame.copy(image) } finally { image.close() }
                        if (closed || captureGeneration != generation || ConnectionGuard.changing() || !settings.enabled || settings.read() != c) { cropped?.recycle(); cropped = null }
                    }
                } catch (_: Exception) { cropped?.recycle(); cropped = null }
                finally { available.close() }
                val copied = cropped
                handler.post {
                    copying = false
                    if (copied != null) {
                        if (!closed && !ending && captureGeneration == generation && !ConnectionGuard.changing() && settings.enabled && config == c && capturePipeline === pipeline &&
                            CapturePipeline.unlocked(this@ProjectionService) && ForegroundApps.snapshot(this@ProjectionService) == ticket.windows)
                            capturePipeline?.submit(copied, current, c, ticket.at, ticket.requestedAt) ?: copied.recycle()
                        else copied.recycle()
                    } else if (!closed && !ending && captureGeneration == generation) pausePipeline(MoteI18n.text("投屏帧读取失败，未保存内容"))
                }
            } } catch (_: java.util.concurrent.RejectedExecutionException) { copying = false; available.close() }
        }, handler)
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        state.execute { if (!closed) Diagnostics(this).add("captureRequests") }
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
        sourceWidth = width; sourceHeight = height
        size(width, height)
        display = projection!!.createVirtualDisplay("Mote", displayWidth, displayHeight, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler)
    }
    private fun resize(width: Int, height: Int) {
        val sourceChanged = sourceWidth != width || sourceHeight != height
        sourceWidth = width; sourceHeight = height
        val beforeWidth = displayWidth; val beforeHeight = displayHeight
        size(width, height)
        if (!sourceChanged && beforeWidth == displayWidth && beforeHeight == displayHeight) return
        clearPending()
        display?.resize(displayWidth, displayHeight, resources.displayMetrics.densityDpi)
    }
    fun pauseForConfiguration() { generation++; checking = null; clearPending(); pipeline?.close(); pipeline = null; lastTick = 0 }
    fun applyConfiguration(next: CollectorConfig) {
        check(!closed && projection != null && display != null)
        config = next; lastTick = 0
        resize(sourceWidth, sourceHeight)
        val ticket = ++generation
        state.execute {
            val prepared = runCatching {
                val current = settings.read()
                check(settings.enabled && current == next && current.screenCollectionEnabled && current.effectiveMode() == "projection")
                val ready = CapturePipeline(this)
                try { check(settings.enabled && settings.read() == next); ready }
                catch (error: Exception) { ready.close(); throw error }
            }
            handler.post {
                if (closed || ending || ticket != generation || projection == null || display == null) {
                    prepared.getOrNull()?.close(); return@post
                }
                prepared.onSuccess { ready ->
                    if (ConnectionGuard.changing() || !settings.enabled) { ready.close(); stopSelf() }
                    else { pipeline?.close(); pipeline = ready }
                }.onFailure { projectionEnded(MoteI18n.text("无法启动投屏，请重新点击开始并授予屏幕共享权限")); stopSelf() }
            }
        }
    }
    fun finishForModeChange() { preserveEnabledOnStop = true; stopSelf() }
    private fun projectionEnded(message: String) {
        if (closed || ending) return
        ending = true; generation++; if (instanceGeneration == instances.get()) running = false
        clearPending(); pipeline?.close(); pipeline = null; handler.removeCallbacks(tick)
        state.execute {
            if (instanceGeneration != instances.get()) return@execute
            runCatching {
                val opened = Settings(this)
                val c = opened.read()
                if (instanceGeneration != instances.get()) return@runCatching
                preserveEnabledOnStop = opened.enabled && c.observesSystem()
                if (!preserveEnabledOnStop) opened.enabled = false
                opened.status(if (preserveEnabledOnStop) "capturing" else "permission_required", message + if (preserveEnabledOnStop) MoteI18n.text("；媒体采集继续运行") else "")
                MediaCollectionService.refresh()
            }
        }
    }
    override fun onDestroy() {
        if (!closed) {
            closed = true; generation++; if (instanceGeneration == instances.get()) running = false; if (instance === this) instance = null
            handler.removeCallbacks(tick); pixels.shutdown()
            pipeline?.close(); pipeline = null
            clearPending(); display?.release(); display = null
            projection?.unregisterCallback(callback); projection?.stop(); projection = null
            stopForeground(STOP_FOREGROUND_DETACH)
            state.execute {
                if (instanceGeneration != instances.get()) return@execute
                runCatching {
                    val opened = Settings(this)
                    if (instanceGeneration != instances.get()) return@runCatching
                    if (!preserveEnabledOnStop) opened.enabled = false
                    Notifications.clear(this)
                    UploadWorker.schedule(this, opened.read())
                }
            }
            state.shutdown()
        }
        super.onDestroy()
    }
    companion object { private val instances = java.util.concurrent.atomic.AtomicLong(); @Volatile var running = false; private set; @Volatile var instance: ProjectionService? = null; private set }
}
