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
    private val instanceGeneration = instances.incrementAndGet()
    private val handler = Handler(Looper.getMainLooper())
    private val stateWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    private lateinit var settings: Settings
    private var pipeline: CapturePipeline? = null
    private val pixels = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(1))
    @Volatile private var destroyed = false
    @Volatile private var pageActivity = ""
    @Volatile private var pagePackage = ""
    private val activityClasses = linkedMapOf<Pair<String,String>, Boolean>()
    private val pageWorker = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(1))
    private val pageMerge = UiPageMerge()
    private val screenReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: android.content.Intent) { refreshSchedule() }
    }
    private var inFlight = false
    private var preparing = false
    private var nextCapture = 0L
    private var windowCounts = Triple(0, 0, 0)
    private var lastDecision = ""
    private var lastDecisionAt = 0L
    @Volatile private var configurationGeneration = 0L
    private val tick = object : Runnable {
        override fun run() { collectIfEnabled() }
    }
    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this; connected = true
        val filter = android.content.IntentFilter().apply {
            addAction(android.content.Intent.ACTION_SCREEN_OFF); addAction(android.content.Intent.ACTION_SCREEN_ON)
            addAction(android.content.Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(screenReceiver, filter)
        refreshSchedule()
    }
    private fun shouldSchedule(config: CollectorConfig): Boolean = !destroyed && ::settings.isInitialized && settings.enabled &&
        config.screenCollectionEnabled && config.effectiveMode() == "accessibility" && CapturePipeline.unlocked(this)
    fun refreshSchedule() {
        handler.post {
            if (destroyed) return@post
            configurationGeneration++; inFlight = false; nextCapture = 0
            pageMerge.reset()
            handler.removeCallbacks(tick)
            handler.post(tick)
        }
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        ProjectionService.instance?.onWindowChanged()
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val app = event.packageName?.toString().orEmpty()
            val className = event.className?.toString().orEmpty()
            // Only a manifest-declared Activity can replace the page identity; dialogs and custom Views cannot.
            val candidate = app to className
            val declared = if (app.isBlank() || !className.contains('.') || className.startsWith("android.widget.") || className.startsWith("android.view.") || className.startsWith("android.webkit.")) false
                else activityClasses.getOrPut(candidate) { runCatching { packageManager.getActivityInfo(android.content.ComponentName(app,className),0);true }.getOrDefault(false) }
            while(activityClasses.size>256)activityClasses.remove(activityClasses.keys.first())
            val activity = className.takeIf { declared }
            val changed = app != pagePackage || activity != null && activity != pageActivity
            if (app != pagePackage) pageActivity = ""
            pagePackage = app
            if (activity != null) pageActivity = activity
            if (changed) {
                configurationGeneration++; inFlight = false; nextCapture = 0; pageMerge.reset()
                handler.removeCallbacks(tick); handler.post(tick)
            }
        }
    }
    override fun onInterrupt() {
        if (!destroyed) stateWorker.execute { runCatching { Settings(this).status("permission_required", MoteI18n.text("无障碍服务中断，请检查系统设置")) } }
    }
    fun windowSnapshot(): WindowSnapshot {
        return try {
            val all = windows
            val metrics = if (Build.VERSION.SDK_INT >= 30) runCatching { getSystemService(android.view.WindowManager::class.java).maximumWindowMetrics }.getOrNull() else null
            val barInsets = if (Build.VERSION.SDK_INT >= 30) metrics?.windowInsets?.getInsetsIgnoringVisibility(android.view.WindowInsets.Type.systemBars()) else null
            val navigationBottom = if (Build.VERSION.SDK_INT >= 30) metrics?.windowInsets?.getInsets(android.view.WindowInsets.Type.navigationBars())?.bottom ?: 0 else 0
            val displayBounds = if (Build.VERSION.SDK_INT >= 30) metrics?.bounds?.let { CaptureBounds(it.left, it.top, it.right, it.bottom) } else null
            val miuiSystemOwner = runCatching {
                @Suppress("DEPRECATION")
                val info = packageManager.getApplicationInfo(SystemBarRegion.MIUI_HOME, 0)
                info.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0
            }.getOrDefault(false)
            val observed = all.map { window ->
                val root = window.root
                val name = root?.packageName?.toString()
                @Suppress("DEPRECATION") root?.recycle()
                val bounds = android.graphics.Rect(); window.getBoundsInScreen(bounds)
                val inBar = if (displayBounds != null && barInsets != null) SystemBarRegion.contains(
                        CaptureBounds(bounds.left, bounds.top, bounds.right, bounds.bottom),
                        displayBounds,
                        CaptureBounds(barInsets.left, barInsets.top, barInsets.right, barInsets.bottom))
                    else {
                        // Android 10 projection mode has no WindowMetrics API.
                        val display = resources.displayMetrics; val limit = (96 * display.density).toInt()
                        window.title?.toString() in setOf("StatusBar", "NavigationBar") &&
                            (bounds.width() >= display.widthPixels * .9 && bounds.height() <= limit && (bounds.top <= 0 || bounds.bottom >= display.heightPixels) ||
                             bounds.height() >= display.heightPixels * .9 && bounds.width() <= limit && (bounds.left <= 0 || bounds.right >= display.widthPixels))
                    }
                val miuiBar = displayBounds != null && SystemBarRegion.miuiNavigation(
                    CaptureBounds(bounds.left, bounds.top, bounds.right, bounds.bottom),
                    displayBounds,
                    navigationBottom, resources.displayMetrics.density, name, miuiSystemOwner,
                    window.type, window.isActive, window.isFocused)
                val chrome = (window.type == 3 && name == "com.android.systemui" && !window.isActive && !window.isFocused && inBar) || miuiBar
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
        if (destroyed || preparing) return
        if (ConnectionGuard.changing()) { handler.postDelayed(tick, 1000); return }
        preparing = true
        val generation = configurationGeneration
        val previous = pipeline
        stateWorker.execute {
            val prepared = runCatching {
                val opened = if (::settings.isInitialized) settings else Settings(this)
                val config = opened.read()
                val capture = previous ?: if (opened.enabled && config.screenCollectionEnabled && config.effectiveMode() == "accessibility") CapturePipeline(this) else null
                Triple(opened, config, capture)
            }
            handler.post {
                preparing = false
                if (destroyed || generation != configurationGeneration) {
                    prepared.getOrNull()?.third?.takeIf { it !== previous }?.close()
                    if (!destroyed) handler.post(tick)
                    return@post
                }
                prepared.onSuccess { (opened, config, capture) ->
                    settings = opened; pipeline = capture
                    runCatching { collectWithConfig(config) }.onFailure { error ->
                        inFlight = false
                        Operations.record(this, OperationKind.CAPTURE_FAILED, Operations.failure(error, EventStage.CAPTURE))
                        stateWorker.execute { settings.status("paused", MoteI18n.text("无障碍采集暂不可用，下一周期重试")) }
                    }
                    if (shouldSchedule(config)) handler.postDelayed(tick, (nextCapture - android.os.SystemClock.elapsedRealtime()).coerceIn(1000L, 300_000L))
                    else if (settings.enabled && config.screenCollectionEnabled && config.effectiveMode() == "accessibility")
                        pipeline?.pause(MoteI18n.text("锁屏或熄屏，暂停采集"), OperationReason.LOCKED)
                }.onFailure { if (!destroyed) handler.postDelayed(tick, 1000) }
            }
        }
    }
    private fun collectWithConfig(config: CollectorConfig) {
        if (destroyed || ConnectionGuard.changing()) return
        if (!settings.enabled || !config.screenCollectionEnabled || config.effectiveMode() != "accessibility") { stopCapture(); return }
        stateWorker.execute { if (!destroyed) UploadWorker.heartbeat(this, config) }
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            stopCapture()
            stateWorker.execute { if (!destroyed && settings.read() == config) {
                settings.enabled = false
                settings.status("permission_required", MoteI18n.text("通知权限已关闭，为保持采集可见已停止，请授权通知后重新开始"))
            } }
            return
        }
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
                val generation = configurationGeneration
                pipeline!!.submitActivity(snapshot, config, isCurrent = { captureCurrent(snapshot,config,generation,AppCollectionMode.ACTIVITY) })
            }; return
        }
        if (!pipeline!!.canCapture(config, snapshot)) return
        if (config.uiPageMode != "screen_only" && config.pageRules.any { it.optInt("formatVersion", 1) == 2 && it.getString("platform") == "android" && it.getString("appId") == snapshot.foreground }) {
            collectPage(snapshot,config); return
        }
        captureScreen(snapshot,config)
    }
    private fun captureScreen(snapshot: WindowSnapshot, config: CollectorConfig) {
        if (destroyed || ConnectionGuard.changing() || !settings.enabled || windowSnapshot()!=snapshot || !CapturePipeline.unlocked(this)) {
            Operations.record(this, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED)
            return
        }
        val generation = configurationGeneration
        stateWorker.execute {
            val current = runCatching { settings.read() == config && settings.enabled && !ConnectionGuard.changing() }.getOrDefault(false)
            handler.post {
                if (!destroyed && generation == configurationGeneration && current && !ConnectionGuard.changing() && settings.enabled && windowSnapshot() == snapshot && CapturePipeline.unlocked(this))
                    requestScreen(snapshot, config)
            }
        }
    }
    private fun requestScreen(snapshot: WindowSnapshot, config: CollectorConfig) {
        if (Build.VERSION.SDK_INT < 30) { stateWorker.execute { settings.status("permission_required", MoteI18n.text("此系统需投屏模式采集内容；仅应用活动无需截图API")) }; return }
        val capturePipeline = pipeline!!
        val generation = configurationGeneration
        inFlight = true
        nextCapture = android.os.SystemClock.elapsedRealtime() + config.intervalSeconds * 1000L
        val at = Instant.now().toString()
        val observedAtMs = android.os.SystemClock.elapsedRealtime()
        Operations.record(this, OperationKind.CAPTURE_REQUESTED)
        stateWorker.execute { Diagnostics(this).add("captureRequests") }
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val current = windowSnapshot()
                    if (generation != configurationGeneration || ConnectionGuard.changing() || !settings.enabled || current != snapshot || CapturePipeline.policy(config, current) != AppCollectionMode.CONTENT || !CapturePipeline.unlocked(this@CaptureAccessibilityService)) {
                        result.hardwareBuffer.close(); if (generation == configurationGeneration) inFlight = false
                        Operations.record(this@CaptureAccessibilityService, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED)
                        return
                    }
                    // Transfer ownership to a worker; no full-size pixel copy on the main looper.
                    pixels.execute {
                        val settingsValid = runCatching { !destroyed && generation == configurationGeneration && !ConnectionGuard.changing() && settings.enabled && settings.read() == config }.getOrDefault(false)
                        val bitmap = try {
                            val hardware = if (settingsValid) Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) else null
                            try { hardware?.copy(Bitmap.Config.ARGB_8888, false) } finally { hardware?.recycle() }
                        } catch (_: Exception) { null } finally { result.hardwareBuffer.close() }
                        handler.post {
                            if (generation == configurationGeneration) inFlight = false
                            if (bitmap != null) {
                                if (!destroyed && generation == configurationGeneration && !ConnectionGuard.changing() && settings.enabled && windowSnapshot() == snapshot && CapturePipeline.unlocked(this@CaptureAccessibilityService))
                                    capturePipeline.submit(bitmap, snapshot, config, at, observedAtMs) { captureCurrent(snapshot, config, generation) }
                                else { bitmap.recycle(); Operations.record(this@CaptureAccessibilityService, OperationKind.FRAME_BLOCKED, OperationReason.WINDOW_CHANGED) }
                            } else if (settingsValid) Operations.record(this@CaptureAccessibilityService, OperationKind.CAPTURE_FAILED, OperationReason.PIXEL_COPY)
                            else Operations.record(this@CaptureAccessibilityService, OperationKind.FRAME_BLOCKED, OperationReason.STATE_CHANGED)
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
    private fun captureCurrent(snapshot: WindowSnapshot, config: CollectorConfig, generation: Long, collection: AppCollectionMode = AppCollectionMode.CONTENT): Boolean =
        runCatching { !destroyed && generation == configurationGeneration && !ConnectionGuard.changing() && settings.enabled && settings.read() == config &&
            CapturePipeline.unlocked(this) && windowSnapshot() == snapshot && CapturePipeline.policy(config, snapshot) == collection }.getOrDefault(false)
    private fun collectPage(snapshot: WindowSnapshot, config: CollectorConfig) {
        inFlight=true
        val generation=configurationGeneration
        val sampledAt=Instant.now().toString()
        val observedAtMs=android.os.SystemClock.elapsedRealtime()
        val activity=if(pagePackage==snapshot.foreground) pageActivity else ""
        ConnectionGuard.processing.incrementAndGet()
        try { pageWorker.execute {
            var outcome = UiPageOutcome.STATE_CHANGED
            var queued = 0
            try {
                val appId=snapshot.foreground ?: return@execute
                fun valid() = captureCurrent(snapshot, config, generation) && (pagePackage != appId || pageActivity == activity)
                if(!valid())return@execute
                outcome = UiPageOutcome.EMPTY
                val version=runCatching { packageManager.getPackageInfo(appId,0).versionName.orEmpty() }.getOrDefault("")
                val rules=config.pageRules.filter { it.optInt("formatVersion", 1) == 2 && it.getString("platform")=="android" && it.getString("appId")==appId && (!it.has("activity")||it.getString("activity")==activity) && it.getString("appVersion")==version }
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
                    UiPageReader.read(root,appId,version,activity,viewport,masks,occlusions).put("observedAt", sampledAt)
                } finally { @Suppress("DEPRECATION") root.recycle() }
                if(!valid())return@execute
                val current=rootInActiveWindow
                val sameWindow=current?.windowId==windowId
                @Suppress("DEPRECATION") current?.recycle()
                if(!sameWindow)return@execute
                val allText=UiPageRules.text(pageSnapshot)
                if(UploadGate.review(config.uploadGate){allText}!="allow"){outcome=UiPageOutcome.PRIVACY_REJECTED;pipeline?.pause(MoteI18n.text("页面隐私审查未通过，已跳过"));return@execute}
                val pages=UiPageRules.extractAll(pageSnapshot,rules,sampledAt)
                if (pages.isEmpty()) return@execute
                // Structured success excludes the screenshot even for partial visible content.
                // A queue failure retries next sample instead of switching representation or losing a fragment.
                outcome=UiPageOutcome.EXTRACTED
                val context = "$generation:$appId"
                for (extracted in pages) {
                    val page=pageMerge.merge(extracted, context)
                    val event=org.json.JSONObject().put("id",java.util.UUID.randomUUID().toString()).put("deviceId",settings.deviceId)
                        .put("deviceName",config.deviceName).put("platform","android").put("capturedAt",sampledAt).put("durationMs",0)
                        .put("appId",appId).put("appName",CollectorMetadata.appName(this,appId)).put("source","ui_page").put("ocrText",UiPageRules.text(page))
                        .put("privacy",org.json.JSONObject().put("excluded",false).put("redacted",true).put("mode","local").put("collection","content"))
                        .put("metadata",org.json.JSONObject().put("version",1).put("observedAt",sampledAt).put("collector",org.json.JSONObject().put("method","accessibility")).put("uiPage",page))
                    UiPageRules.validateEvent(event)
                    if(!valid()) { outcome=UiPageOutcome.STATE_CHANGED; return@execute }
                    queue().enqueue(event,null,config.maxQueueMiB*1024L*1024L)
                    queued++
                    if(valid())pageMerge.accepted(page,context)
                }
                outcome=UiPageOutcome.CAPTURED
                if(valid()){settings.captured(sampledAt);settings.status("capturing",MoteI18n.text("页面内容已保存"))}
            } catch (_: Exception) {
                if (outcome in setOf(UiPageOutcome.EXTRACTED,UiPageOutcome.CAPTURED)) outcome=UiPageOutcome.SAVE_FAILED
                else if (outcome != UiPageOutcome.PRIVACY_REJECTED) outcome=UiPageOutcome.FAILED
                if(captureCurrent(snapshot,config,generation))settings.status("paused",MoteI18n.text("页面读取失败，等待下一次采样"))
            }
            finally {
                // Durable records belong to the queue after collection ends; stopping or changing
                // windows must not postpone their existing upload policy. Bind scheduling to the
                // current transport configuration while holding the reconfiguration guard.
                if(queued>0)runCatching { ConnectionGuard.sync {
                    val current=settings.read()
                    if(SyncSchedule.stamp(current)==SyncSchedule.stamp(config))UploadWorker.schedule(this,current)
                } }
                ConnectionGuard.processing.decrementAndGet()
                handler.post { if(generation==configurationGeneration){
                    inFlight=false
                    if (!captureCurrent(snapshot,config,generation)) return@post
                    if (outcome==UiPageOutcome.CAPTURED && pipeline?.canCapture(config,snapshot)==true)
                        pipeline!!.submitPageActivity(snapshot,config,sampledAt,observedAtMs) { captureCurrent(snapshot,config,generation) }
                    else if(UiPageCaptureChoice.screenshot(config.uiPageMode,outcome)) captureScreen(snapshot,config)
                } }
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { inFlight=false; ConnectionGuard.processing.decrementAndGet() }
    }
    fun stopCapture() {
        handler.removeCallbacks(tick)
        configurationGeneration++; nextCapture = 0; inFlight = false
        pageMerge.reset()
        pipeline?.close(); pipeline = null
        if (!ProjectionService.running) Notifications.clear(this)
    }
    override fun onDestroy() {
        destroyed = true
        if (instance === this) { connected = false; instance = null }
        runCatching { unregisterReceiver(screenReceiver) }; pixels.shutdown(); pageWorker.shutdown()
        handler.removeCallbacks(tick)
        stopCapture()
        stateWorker.execute {
            if (instanceGeneration != instances.get()) return@execute
            if (::settings.isInitialized && settings.enabled) runCatching {
                val c = settings.read()
                val media = c.observesSystem() && MediaCollectionService.connected && MediaCollection.permissionAllowed(this)
                settings.status(if (media) "capturing" else "permission_required", MoteI18n.text("无障碍服务未连接，等待系统恢复或打开设置重新启用") + if (media) MoteI18n.text("；媒体采集继续运行") else "")
                MediaCollectionService.refresh()
            }
            if (::settings.isInitialized) runCatching { UploadWorker.schedule(this, settings.read()) }
        }
        stateWorker.shutdown()
        super.onDestroy()
    }
    companion object {
        private val instances = java.util.concurrent.atomic.AtomicLong()
        @Volatile var connected = false; private set
        @Volatile var instance: CaptureAccessibilityService? = null; private set
    }
}
