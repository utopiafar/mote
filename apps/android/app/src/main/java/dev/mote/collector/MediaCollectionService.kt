package dev.mote.collector

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.HandlerThread
import android.os.Build
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** System-bound observer; never reads notifications, records sound, or sends transport controls. */
class MediaCollectionService : NotificationListenerService() {
    private lateinit var thread: HandlerThread
    private lateinit var worker: Handler
    private lateinit var settings: Settings
    private lateinit var preferences: SharedPreferences
    private val timeline = MediaTimeline()
    private var timelineEpoch = -1L
    private data class Bound(val controller: MediaController, val id: String, val callback: MediaController.Callback)
    private val controllers = linkedMapOf<MediaSession.Token, Bound>()
    private var manager: MediaSessionManager? = null
    private var listenerAttached = false
    private var platformConnected = false
    private var previousConfig: CollectorConfig? = null
    private var lastStatus: String? = null
    private var lastNotified: String? = null
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_BATTERY_CHANGED) { timeline.reset(); MediaCollection.clear() }
            refresh()
        }
    }
    private val sessionListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
        if (eligible()) { bind(list.orEmpty()); sample() }
    }
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        // Settings status/counters also use this preferences file; they must not trigger observation loops.
        if (key in configurationKeys) worker.post { refresh() }
    }
    private val tick = object : Runnable {
        override fun run() { refresh(); worker.postDelayed(this, 30_000) }
    }
    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        thread = HandlerThread("mote-media-observer").apply { start() }
        worker = Handler(thread.looper)
        preferences = getSharedPreferences("mote", MODE_PRIVATE)
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_BATTERY_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, null, worker, Context.RECEIVER_NOT_EXPORTED)
        else { @Suppress("DEPRECATION") registerReceiver(screenReceiver, filter, null, worker) }
        instance = this
        worker.post(tick)
    }
    override fun onListenerConnected() {
        super.onListenerConnected()
        worker.post { platformConnected = true; connected = true; refresh() }
    }
    override fun onListenerDisconnected() {
        connected = false; MediaCollection.clear()
        worker.post {
            platformConnected = false; connected = false
            detach(); timeline.reset(); publishUnavailable("unavailable")
        }
        super.onListenerDisconnected()
    }
    private fun eligible(): Boolean = runCatching {
        val c = settings.read()
        platformConnected && connected && settings.enabled && c.mediaCollectionEnabled && c.metadataEnabled &&
            MediaCollection.permissionAllowed(this) &&
            getSystemService(NotificationManager::class.java).areNotificationsEnabled() &&
            MediaPrivacy.powerAllowed(c, Diagnostics.battery(this)) && !ConnectionGuard.changing() && !QueueStorage.recovering
    }.getOrDefault(false)
    private fun refresh() {
        try {
            val c = settings.read()
            if (previousConfig != c) { timeline.reset(); lastStatus = null; previousConfig = c; detach() }
            if (!settings.enabled || !c.mediaCollectionEnabled || !c.metadataEnabled) {
                detach(); timeline.reset(); lastStatus = null
                MediaCollection.update(c, MediaPrivacy.snapshot("disabled", emptyList()))
                Notifications.clearMedia(this); lastNotified = null; return
            }
            if (ConnectionGuard.changing() || QueueStorage.recovering) { detach(); timeline.reset(); MediaCollection.clear(); return }
            if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
                settings.enabled = false; detach(); timeline.reset(); MediaCollection.clear(); Notifications.clearMedia(this); return
            }
            if (!MediaPrivacy.powerAllowed(c, Diagnostics.battery(this))) {
                detach(); timeline.reset(); MediaCollection.clear()
                notifyStatus("媒体采集等待充电或电量恢复"); return
            }
            if (!platformConnected) { publishUnavailable(if (MediaCollection.permissionAllowed(this)) "unavailable" else "permission_required"); return }
            if (!listenerAttached) {
                val service = getSystemService(MediaSessionManager::class.java)
                service.addOnActiveSessionsChangedListener(sessionListener, ComponentName(this, MediaCollectionService::class.java), worker)
                manager = service; listenerAttached = true
            }
            bind(manager!!.getActiveSessions(ComponentName(this, MediaCollectionService::class.java)))
            sample()
        } catch (_: SecurityException) { detach(); timeline.reset(); publishUnavailable("permission_required") }
        catch (_: Exception) { detach(); timeline.reset(); publishUnavailable("unavailable") }
    }
    private fun notifyStatus(message: String) {
        if (message != lastNotified) { Notifications.showMedia(this, message); lastNotified = message }
        val c = settings.read()
        val screenAlive = c.screenCollectionEnabled && (if (c.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected)
        if (!screenAlive && settings.enabled) {
            val state = if (eligible() && lastStatus == "available") "capturing" else if (!MediaCollection.permissionAllowed(this)) "permission_required" else "paused"
            if (settings.state() != state || settings.message() != message) settings.status(state, message)
        }
    }
    private fun bind(list: List<MediaController>) {
        val selected = list.sortedWith(compareBy<MediaController> { it.packageName }.thenBy { it.sessionToken.hashCode() }).take(16)
        val active = selected.map { it.sessionToken }.toSet()
        controllers.keys.filter { it !in active }.toList().forEach { token -> controllers.remove(token)?.let { it.controller.unregisterCallback(it.callback) } }
        val c = settings.read()
        for (controller in selected) {
            val token = controller.sessionToken
            if (token in controllers || MediaPrivacy.mode(controller.packageName, c) == AppCollectionMode.OFF) continue
            val callback = object : MediaController.Callback() {
                override fun onPlaybackStateChanged(state: PlaybackState?) { requestSample() }
                override fun onMetadataChanged(metadata: MediaMetadata?) { requestSample() }
                override fun onAudioInfoChanged(info: MediaController.PlaybackInfo) { requestSample() }
                override fun onSessionDestroyed() { worker.post { refresh() } }
            }
            controller.registerCallback(callback, worker)
            controllers[token] = Bound(controller, UUID.randomUUID().toString(), callback)
        }
    }
    private val changed = Runnable {
        if (eligible()) runCatching { sample() }.onFailure { timeline.reset(); publishUnavailable("unavailable") }
        else { timeline.reset(); MediaCollection.clear(); refresh() }
    }
    private fun requestSample() { worker.removeCallbacks(changed); worker.postDelayed(changed, 250) }
    private fun sample() {
        if (!eligible()) { timeline.reset(); MediaCollection.clear(); return }
        ConnectionGuard.sync {
            if (!eligible()) { timeline.reset(); return@sync }
            val c = settings.read()
            val epoch = MediaCollection.epoch.get()
            if (timelineEpoch != epoch) { timeline.reset(); lastStatus = null; timelineEpoch = epoch }
            ConnectionGuard.processing.incrementAndGet()
            try {
                val elapsed = SystemClock.elapsedRealtime(); val awake = SystemClock.uptimeMillis(); val wall = System.currentTimeMillis()
                val visible = runCatching { ForegroundApps.snapshot(this) }.getOrDefault(WindowSnapshot(emptySet(), null, false))
                val locked = !CapturePipeline.unlocked(this)
                val sessions = controllers.values.mapNotNull { bound -> readSession(bound, c, visible, locked) }
                MediaCollection.update(c, MediaPrivacy.snapshot("available", sessions), epoch)
                if (lastStatus != "available") timeline.reset()
                lastStatus = "available"
                val stateKey = "${getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked}:${getSystemService(android.os.PowerManager::class.java).isInteractive}"
                val samples = timeline.observe(elapsed, awake, wall, sessions, stateKey)
                for (sample in samples) enqueue(c, "available", sample.sessions, sample.durationMs, wall, epoch)
                notifyStatus("媒体采集已启用 · ${sessions.count { it.optString("playbackState") == "playing" }} 个会话正在播放 · 可随时停止")
                UploadWorker.heartbeat(this, c)
            } catch (error: Exception) {
                timeline.reset()
                Operations.record(this, OperationKind.MEDIA_FAILED, if (error is QueueFull) OperationReason.QUEUE_FULL else OperationReason.STORAGE)
                notifyStatus(if (error is QueueFull) "媒体记录等待本机存储空间" else "媒体记录暂未保存，下一周期重试")
            } finally { ConnectionGuard.processing.decrementAndGet() }
        } ?: run { timeline.reset(); MediaCollection.clear() }
    }
    private fun readSession(bound: Bound, c: CollectorConfig, visible: WindowSnapshot, locked: Boolean): JSONObject? {
        val controller = bound.controller; val app = controller.packageName
        val mode = MediaPrivacy.mode(app, c)
        if (mode == AppCollectionMode.OFF) return null
        val playback = controller.playbackState
        val result = JSONObject().put("sessionId", bound.id).put("appId", app.take(300)).put("appName", CollectorMetadata.appName(this, app))
            .put("playbackState", when (playback?.state) {
                PlaybackState.STATE_PLAYING -> "playing"; PlaybackState.STATE_PAUSED -> "paused"; PlaybackState.STATE_STOPPED -> "stopped"
                PlaybackState.STATE_BUFFERING -> "buffering"; PlaybackState.STATE_CONNECTING -> "connecting"
                PlaybackState.STATE_FAST_FORWARDING, PlaybackState.STATE_REWINDING -> "seeking"
                PlaybackState.STATE_SKIPPING_TO_NEXT, PlaybackState.STATE_SKIPPING_TO_PREVIOUS, PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM -> "skipping"
                PlaybackState.STATE_ERROR -> "error"; PlaybackState.STATE_NONE -> "none"; else -> "unknown"
            }).put("appVisibility", when {
                locked -> "background"; visible.foreground == app -> "foreground"
                visible.foreground != null || visible.trustworthy -> "background"; else -> "unknown"
            }).put("playbackType", when (controller.playbackInfo?.playbackType) {
                MediaController.PlaybackInfo.PLAYBACK_TYPE_LOCAL -> "local"; MediaController.PlaybackInfo.PLAYBACK_TYPE_REMOTE -> "remote"; else -> "unknown"
            })
        playback?.let {
            if (it.position in 0..9_007_199_254_740_991L) result.put("positionMs", it.position)
            if (it.playbackSpeed.isFinite() && it.playbackSpeed in -16f..16f) result.put("playbackSpeed", it.playbackSpeed.toDouble())
        }
        // In activity mode do not even request the player's textual metadata.
        if (mode == AppCollectionMode.CONTENT) controller.metadata?.let { metadata ->
            mapOf("title" to MediaMetadata.METADATA_KEY_TITLE, "artist" to MediaMetadata.METADATA_KEY_ARTIST,
                "album" to MediaMetadata.METADATA_KEY_ALBUM, "displaySubtitle" to MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE,
                "mediaId" to MediaMetadata.METADATA_KEY_MEDIA_ID).forEach { (key, field) ->
                metadata.getText(field)?.toString()?.takeIf(String::isNotBlank)?.let { result.put(key, it.take(1000)) }
            }
            if (metadata.containsKey(MediaMetadata.METADATA_KEY_DURATION)) metadata.getLong(MediaMetadata.METADATA_KEY_DURATION)
                .takeIf { it in 0..9_007_199_254_740_991L }?.let { result.put("durationMs", it) }
        }
        return result
    }
    private fun enqueue(c: CollectorConfig, status: String, sessions: List<JSONObject>, duration: Long, wall: Long, epoch: Long = MediaCollection.epoch.get()) {
        if (epoch != MediaCollection.epoch.get() || !settings.enabled || settings.read() != c || ConnectionGuard.changing() ||
            status == "available" && !MediaCollection.permissionAllowed(this)) { timeline.reset(); MediaCollection.clear(); return }
        val one = sessions.singleOrNull()
        val activityOnly = sessions.all { MediaPrivacy.mode(it.getString("appId"), c) == AppCollectionMode.ACTIVITY }
        val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId)
            .put("deviceName", c.deviceName).put("platform", "android").put("capturedAt", Instant.ofEpochMilli(wall).toString())
            .put("durationMs", duration).put("source", "media")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", if (activityOnly) "activity" else "content"))
            .put("metadata", CollectorMetadata.snapshot(this, "media_session", 30_000, activityOnly)
                .put("media", MediaPrivacy.snapshot(status, sessions, Instant.ofEpochMilli(wall).toString())))
        one?.let { event.put("appId", it.getString("appId")).put("appName", it.getString("appName")) }
        settings.ensureDataOrigin(c)
        queue().enqueue(event, null, c.maxQueueMiB * 1024L * 1024L)
        UploadWorker.schedule(this, c)
    }
    private fun publishUnavailable(status: String) {
        runCatching {
            val c = settings.read()
            if (!settings.enabled || !c.mediaCollectionEnabled || !c.metadataEnabled) { MediaCollection.clear(); return }
            MediaCollection.update(c, MediaPrivacy.snapshot(status, emptyList()))
            if (lastStatus != status && !ConnectionGuard.changing() && !QueueStorage.recovering && MediaPrivacy.powerAllowed(c, Diagnostics.battery(this))) {
                ConnectionGuard.sync {
                    enqueue(c, status, emptyList(), 0, System.currentTimeMillis())
                    lastStatus = status
                }
            }
            notifyStatus(if (status == "permission_required") "媒体采集等待系统通知使用权授权" else "媒体服务暂不可用，等待系统恢复")
        }
    }
    private fun detach() {
        worker.removeCallbacks(changed)
        if (listenerAttached) runCatching { manager?.removeOnActiveSessionsChangedListener(sessionListener) }
        listenerAttached = false; manager = null
        controllers.values.forEach { runCatching { it.controller.unregisterCallback(it.callback) } }; controllers.clear()
    }
    override fun onDestroy() {
        instance = null; connected = false
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        unregisterReceiver(screenReceiver)
        worker.removeCallbacksAndMessages(null)
        worker.post { platformConnected = false; detach(); timeline.reset(); publishUnavailable("unavailable"); MediaCollection.clear(); Notifications.clearMedia(this); thread.quitSafely() }
        super.onDestroy()
    }
    companion object {
        @Volatile var instance: MediaCollectionService? = null; private set
        @Volatile var connected = false; private set
        private val configurationKeys = setOf("enabled", "screenCollectionEnabled", "mediaCollectionEnabled", "metadataEnabled", "appCollectionRules", "excluded", "chargingOnly", "batteryPauseBelowPct", "server", "token", "maxQueue", "syncMode", "wifiOnly")
        fun suspendObservation() { MediaCollection.epoch.incrementAndGet(); MediaCollection.clear(); instance?.let { it.worker.post { it.detach(); it.timeline.reset() } } }
        fun refresh() { instance?.let { it.worker.post { it.refresh() } } }
    }
}

/** Immutable, short-lived process snapshot, revalidated against the complete current privacy configuration. */
object MediaCollection {
    internal val epoch = java.util.concurrent.atomic.AtomicLong(0)
    private data class Cached(val config: CollectorConfig, val elapsed: Long, val json: String, val epoch: Long)
    @Volatile private var cached: Cached? = null
    internal fun update(config: CollectorConfig, media: JSONObject, epoch: Long = this.epoch.get()) { cached = Cached(config, SystemClock.elapsedRealtime(), media.toString(), epoch) }
    internal fun clear() { cached = null }
    fun permissionAllowed(context: Context) = runCatching {
        context.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(ComponentName(context, MediaCollectionService::class.java))
    }.getOrDefault(false)
    fun snapshot(context: Context, activityOnly: Boolean = false): JSONObject {
        val settings = Settings(context); val c = settings.read()
        if (!settings.enabled || !c.metadataEnabled || !c.mediaCollectionEnabled) return MediaPrivacy.snapshot("disabled", emptyList())
        if (!permissionAllowed(context)) return MediaPrivacy.snapshot("permission_required", emptyList())
        val current = cached
        if (!MediaCollectionService.connected || ConnectionGuard.changing() || !MediaPrivacy.powerAllowed(c, Diagnostics.battery(context)) || current == null ||
            current.epoch != epoch.get() || current.config != c || SystemClock.elapsedRealtime() - current.elapsed !in 0..60_000) return MediaPrivacy.snapshot("unavailable", emptyList())
        val value = JSONObject(current.json); val sessions = value.getJSONArray("sessions")
        return MediaPrivacy.snapshot(value.getString("status"), (0 until sessions.length()).mapNotNull { MediaPrivacy.session(sessions.getJSONObject(it), c, activityOnly) }, value.getString("observedAt"))
    }
    fun statusLabel(context: Context): String = when (snapshot(context).optString("status")) {
        "available" -> "媒体已连接（前台、后台与锁屏）"; "disabled" -> "媒体未启用"
        "permission_required" -> "媒体等待通知使用权授权"; else -> "媒体暂不可用或正在等待电量条件"
    }
}
