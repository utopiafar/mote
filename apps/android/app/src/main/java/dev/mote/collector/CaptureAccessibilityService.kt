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

/** Passive collection. Page text requires explicit rules; no gestures, actions or hidden grants. */
class CaptureAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private var pipeline: CapturePipeline? = null
    private val pixels = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(1))
    @Volatile private var destroyed = false
    @Volatile private var pageActivity = ""
    @Volatile private var pagePackage = ""
    private val pageWorker = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(1))
    private val screenReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: android.content.Intent) { refreshSchedule() }
    }
    private var inFlight = false
    private var nextCapture = 0L
    private var windowCounts = Triple(0, 0, 0)
    private var lastDecision = ""
    private var lastDecisionAt = 0L
    @Volatile private var configurationGeneration = 0L
    private val tick = object : Runnable {
        override fun run() {
            try { collectIfEnabled() }
            catch (error: Exception) {
                inFlight = false
                Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, Operations.failure(error, EventStage.CAPTURE))
                settings.status("paused", MoteI18n.text("无障碍采集暂不可用，下一周期重试"))
            }
            if (shouldSchedule()) handler.postDelayed(this, (nextCapture - android.os.SystemClock.elapsedRealtime()).coerceIn(1000L, 300_000L))
        }
    }
    override fun onServiceConnected() {
        super.onServiceConnected()
        settings = Settings(this)
        instance = this; connected = true
        val filter = android.content.IntentFilter().apply {
            addAction(android.content.Intent.ACTION_SCREEN_OFF); addAction(android.content.Intent.ACTION_SCREEN_ON)
            addAction(android.content.Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(screenReceiver, filter)
        refreshSchedule()
    }
    private fun shouldSchedule(): Boolean = !destroyed && ::settings.isInitialized && settings.enabled &&
        settings.read().let { it.screenCollectionEnabled && it.effectiveMode() == "accessibility" } && CapturePipeline.unlocked(this)
    fun refreshSchedule() {
        handler.post {
            handler.removeCallbacks(tick)
            if (shouldSchedule()) handler.post(tick)
            else if (::settings.isInitialized) {
                if (!settings.enabled) stopCapture()
                else { configurationGeneration++; inFlight = false; nextCapture = 0; pipeline?.pause(MoteI18n.text("锁屏或熄屏，暂停采集"), OperationReason.LOCKED) }
            }
        }
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        ProjectionService.instance?.onWindowChanged()
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && event.className?.toString()?.contains(".") == true) {
            pageActivity=event.className.toString(); pagePackage=event.packageName?.toString().orEmpty()
        }
    }
    override fun onInterrupt() {
        if (::settings.isInitialized) settings.status("permission_required", MoteI18n.text("无障碍服务中断，请检查系统设置"))
    }
    fun windowSnapshot(): WindowSnapshot {
        return try {
            val all = windows
            val metrics = if (Build.VERSION.SDK_INT >= 30) runCatching { getSystemService(android.view.WindowManager::class.java).maximumWindowMetrics }.getOrNull() else null
            val barInsets = metrics?.windowInsets?.getInsetsIgnoringVisibility(android.view.WindowInsets.Type.systemBars())
            val observed = all.map { window ->
                val root = window.root
                val name = root?.packageName?.toString()
                @Suppress("DEPRECATION") root?.recycle()
                val bounds = android.graphics.Rect(); window.getBoundsInScreen(bounds)
                val inBar = if (metrics != null && barInsets != null) SystemBarRegion.contains(
                        CaptureBounds(bounds.left, bounds.top, bounds.right, bounds.bottom),
                        metrics.bounds.let { CaptureBounds(it.left, it.top, it.right, it.bottom) },
                        CaptureBounds(barInsets.left, barInsets.top, barInsets.right, barInsets.bottom))
                    else {
                        // Android 10 projection mode has no WindowMetrics API.
                        val display = resources.displayMetrics; val limit = (96 * display.density).toInt()
                        window.title?.toString() in setOf("StatusBar", "NavigationBar") &&
                            (bounds.width() >= display.widthPixels * .9 && bounds.height() <= limit && (bounds.top <= 0 || bounds.bottom >= display.heightPixels) ||
                             bounds.height() >= display.heightPixels * .9 && bounds.width() <= limit && (bounds.left <= 0 || bounds.right >= display.widthPixels))
                    }
                val chrome = window.type == 3 && name == "com.android.systemui" && !window.isActive && !window.isFocused && inBar
                CollectionWindow(window.type, name, chrome)
            }
            windowCounts = Triple(observed.size, observed.count { it.packageName.isNullOrBlank() || it.type !in 1..3 }, observed.count { it.systemBar })
            val root = rootInActiveWindow
            val foreground = root?.packageName?.toString()
            @Suppress("DEPRECATION") root?.recycle()
            // Keyboards and system/other overlays may contain private content even when inactive.
            CollectionWindows.snapshot(observed, foreground)
        } catch (_: Exception) { windowCounts = Triple(0, 0, 0); WindowSnapshot(emptySet(), null, false) }
    }
    private fun collectIfEnabled() {
        if (ConnectionGuard.reconfiguring()) return
        val config = settings.read()
        if (!settings.enabled || !config.screenCollectionEnabled || config.effectiveMode() != "accessibility") { stopCapture(); return }
        UploadWorker.heartbeat(this, config)
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            settings.enabled = false
            settings.status("permission_required", MoteI18n.text("通知权限已关闭，为保持采集可见已停止，请授权通知后重新开始"))
            stopCapture(); return
        }
        if (pipeline == null) pipeline = CapturePipeline(this)
        Notifications.show(this, LocalStateRepository.get(this).state.value.captureLabel)
        if (inFlight || android.os.SystemClock.elapsedRealtime() < nextCapture || pipeline!!.isBusy()) return
        nextCapture = android.os.SystemClock.elapsedRealtime() + config.intervalSeconds * 1000L
        val snapshot = windowSnapshot()
        val mode = CapturePipeline.policy(config, snapshot)
        val restricted = snapshot.packages.count { it in PrivacyRules.exclusions(config.excludedPackages) || (config.collectionRules.apps[it] ?: config.collectionRules.defaultMode) != AppCollectionMode.CONTENT }
        val protected = CapturePipeline.protectedWindow(snapshot)
        val decision = "$windowCounts:$restricted:${snapshot.trustworthy}:${snapshot.foreground != null}:$protected:$mode"
        val now = android.os.SystemClock.elapsedRealtime()
        if (decision != lastDecision || now - lastDecisionAt >= 60_000) {
            runCatching { SupportEvents.runtime(this).captureDecision(windowCounts.first, windowCounts.second, windowCounts.third, restricted, snapshot.trustworthy, snapshot.foreground != null, protected, mode) }
            lastDecision = decision; lastDecisionAt = now
        }
        if (mode == AppCollectionMode.ACTIVITY) {
            if (pipeline!!.canCollect(config, snapshot, mode)) {
                nextCapture = android.os.SystemClock.elapsedRealtime() + config.intervalSeconds * 1000L
                pipeline!!.submitActivity(snapshot, config)
            }; return
        }
        if (!pipeline!!.canCapture(config, snapshot)) return
        if (config.uiPageMode != "screen_only" && config.pageRules.any { it.getString("platform") == "android" && it.getString("appId") == snapshot.foreground }) {
            collectPage(snapshot,config); return
        }
        if (config.uiPageMode == "page_only") return
        captureScreen(snapshot,config)
    }
    private fun captureScreen(snapshot: WindowSnapshot, config: CollectorConfig) {
        if (destroyed || settings.read()!=config || !settings.enabled || windowSnapshot()!=snapshot || !CapturePipeline.unlocked(this)) {
            Operations.record(this, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED)
            return
        }
        if (Build.VERSION.SDK_INT < 30) { settings.status("permission_required", MoteI18n.text("此系统需投屏模式采集内容；仅应用活动无需截图API")); return }
        val capturePipeline = pipeline!!
        val generation = configurationGeneration
        inFlight = true
        nextCapture = android.os.SystemClock.elapsedRealtime() + config.intervalSeconds * 1000L
        val at = Instant.now().toString()
        val observedAtMs = android.os.SystemClock.elapsedRealtime()
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        Diagnostics(this).add("captureRequests")
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val current = windowSnapshot()
                    if (generation != configurationGeneration || ConnectionGuard.reconfiguring() || !settings.enabled || current != snapshot || CapturePipeline.policy(settings.read(), current) != AppCollectionMode.CONTENT || !CapturePipeline.unlocked(this@CaptureAccessibilityService)) {
                        result.hardwareBuffer.close(); if (generation == configurationGeneration) inFlight = false
                        Operations.record(this@CaptureAccessibilityService, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED)
                        return
                    }
                    // Transfer ownership to a worker; no full-size pixel copy on the main looper.
                    pixels.execute {
                        val bitmap = try {
                            val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                            try { hardware?.copy(Bitmap.Config.ARGB_8888, false) } finally { hardware?.recycle() }
                        } catch (_: Exception) { null } finally { result.hardwareBuffer.close() }
                        handler.post {
                            if (generation == configurationGeneration) inFlight = false
                            if (bitmap != null) {
                                if (!destroyed && generation == configurationGeneration && settings.enabled && settings.read() == config && windowSnapshot() == snapshot && CapturePipeline.unlocked(this@CaptureAccessibilityService))
                                    capturePipeline.submit(bitmap, snapshot, config, at, observedAtMs)
                                else { bitmap.recycle(); Operations.record(this@CaptureAccessibilityService, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED) }
                            } else Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, OperationReason.PIXEL_COPY)
                        }
                    }
                    return
                } catch (_: java.util.concurrent.RejectedExecutionException) { /* service stopped */ }
                if (generation == configurationGeneration) inFlight = false
                result.hardwareBuffer.close()
            }
            override fun onFailure(errorCode: Int) {
                if (generation != configurationGeneration) return
                inFlight = false
                Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, OperationReason.SYSTEM)
                runCatching { SupportEvents.runtime(this@CaptureAccessibilityService).screenshotFailure(errorCode) }
                pipeline?.pause(MoteI18n.text("系统未提供截图（代码 {0}），可能是安全窗口或权限变化；未保存内容", errorCode))
            }
        })
    }
    private fun collectPage(snapshot: WindowSnapshot, config: CollectorConfig) {
        inFlight=true
        val generation=configurationGeneration
        val activity=if(pagePackage==snapshot.foreground) pageActivity else ""
        ConnectionGuard.processing.incrementAndGet()
        try { pageWorker.execute {
            var suppressScreen=false
            try {
                val appId=snapshot.foreground ?: return@execute
                fun valid() = !destroyed && generation==configurationGeneration && !ConnectionGuard.changing() && settings.enabled && settings.read()==config && CapturePipeline.unlocked(this) && windowSnapshot()==snapshot && (pagePackage!=appId || pageActivity==activity)
                if(!valid())return@execute
                val version=runCatching { packageManager.getPackageInfo(appId,0).versionName.orEmpty() }.getOrDefault("")
                val rules=config.pageRules.filter { it.getString("platform")=="android" && it.getString("appId")==appId && (!it.has("activity")||it.getString("activity")==activity) && (!it.has("appVersion")||it.getString("appVersion")==version) }
                if(rules.isEmpty())return@execute
                val root=rootInActiveWindow ?: return@execute
                val windowId=root.windowId
                val pageSnapshot=try {
                    if(root.packageName?.toString()!=appId)return@execute
                    val viewport=android.graphics.Rect(); root.getBoundsInScreen(viewport)
                    val all=windows; val target=all.firstOrNull { it.id==windowId } ?: return@execute
                    val occlusions=all.filter { it.layer>target.layer }.map { android.graphics.Rect().also(it::getBoundsInScreen) }
                    val size=android.util.DisplayMetrics()
                    @Suppress("DEPRECATION")
                    (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getRealMetrics(size)
                    if(!viewport.intersect(0,0,size.widthPixels,size.heightPixels))return@execute
                    val masks=Mask.parse(config.masks).map { android.graphics.Rect((it.left*size.widthPixels).toInt(),(it.top*size.heightPixels).toInt(),kotlin.math.ceil(it.right*size.widthPixels.toDouble()).toInt(),kotlin.math.ceil(it.bottom*size.heightPixels.toDouble()).toInt()) }
                    UiPageReader.read(root,appId,version,activity,viewport,masks,occlusions)
                } finally { @Suppress("DEPRECATION") root.recycle() }
                if(!valid())return@execute
                val current=rootInActiveWindow
                val sameWindow=current?.windowId==windowId
                @Suppress("DEPRECATION") current?.recycle()
                if(!sameWindow)return@execute
                val page=UiPageRules.extract(pageSnapshot,rules) ?: return@execute
                val allText=UiPageRules.text(pageSnapshot)
                if(UploadGate.review(config.uploadGate){allText}!="allow"){suppressScreen=true;settings.status("paused",MoteI18n.text("页面隐私审查未通过，已跳过"));return@execute}
                val at=Instant.now().toString()
                val event=org.json.JSONObject().put("id",java.util.UUID.randomUUID().toString()).put("deviceId",settings.deviceId)
                    .put("deviceName",config.deviceName).put("platform","android").put("capturedAt",at).put("durationMs",0)
                    .put("appId",appId).put("appName",CollectorMetadata.appName(this,appId)).put("source","ui_page").put("ocrText",UiPageRules.text(page))
                    .put("privacy",org.json.JSONObject().put("excluded",false).put("redacted",true).put("mode","local").put("collection","content"))
                    .put("metadata",org.json.JSONObject().put("version",1).put("observedAt",at).put("collector",org.json.JSONObject().put("method","accessibility")).put("uiPage",page))
                if(!valid())return@execute
                settings.ensureDataOrigin(config)
                queue().enqueue(event,null,config.maxQueueMiB*1024L*1024L)
                settings.captured(at);settings.status("capturing",MoteI18n.text("页面内容已保存"));UploadWorker.schedule(this,config)
                suppressScreen=config.uiPageMode=="ui_preferred" && page.getString("status")=="ok"
            } catch (_: Exception) { settings.status("paused",MoteI18n.text("页面读取失败，等待下一次采样")) }
            finally {
                ConnectionGuard.processing.decrementAndGet()
                handler.post { if(generation==configurationGeneration){inFlight=false;if(!suppressScreen && config.uiPageMode!="page_only") captureScreen(snapshot,config)} }
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { inFlight=false; ConnectionGuard.processing.decrementAndGet() }
    }
    fun stopCapture() {
        handler.removeCallbacks(tick)
        configurationGeneration++; nextCapture = 0; inFlight = false
        pipeline?.close(); pipeline = null
        if (!ProjectionService.running) Notifications.clear(this)
    }
    override fun onDestroy() {
        destroyed = true; connected = false; instance = null
        runCatching { unregisterReceiver(screenReceiver) }; pixels.shutdown(); pageWorker.shutdown()
        handler.removeCallbacks(tick)
        stopCapture()
        if (::settings.isInitialized && settings.enabled) {
            val c = settings.read()
            val media = c.observesSystem() && MediaCollectionService.connected && MediaCollection.permissionAllowed(this)
            settings.status(if (media) "capturing" else "permission_required", MoteI18n.text("无障碍服务未连接，等待系统恢复或打开设置重新启用") + if (media) MoteI18n.text("；媒体采集继续运行") else "")
            MediaCollectionService.refresh()
        }
        if (::settings.isInitialized) runCatching { UploadWorker.schedule(this, settings.read()) }
        super.onDestroy()
    }
    companion object {
        @Volatile var connected = false; private set
        @Volatile var instance: CaptureAccessibilityService? = null; private set
    }
}
