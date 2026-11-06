package dev.mote.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings as AndroidSettings
import dev.mote.collector.plugins.SystemEntriesPlugin
import java.time.Instant
import java.time.ZoneId

/** One system notification per interruption. A partial problem only updates
 * the ongoing title; leaving the needs-action level recovers the incident, so
 * the next stop alerts again. */
internal class CaptureAttentionDedup {
    private var interrupted = false

    fun update(row: CaptureStatusRow): Boolean {
        if (row.level != CaptureStatusLevel.NEEDS_ACTION) { interrupted = false; return false }
        if (row.id != CaptureStatusId.INTERRUPTED) return false
        if (interrupted) return false
        interrupted = true
        return true
    }
}

/** The ongoing title is the shared status row; the local count lives only in
 * 采集与存储详情. */
internal fun ongoingCaptureTitle(row: CaptureStatusRow): String? =
    row.androidOngoing?.let { MoteI18n.text(it) }

internal fun captureAttentionTitle(row: CaptureStatusRow): String? =
    row.notification?.titleKey?.let { MoteI18n.text(it) }

/** One rendered capture state: the shared row, the ongoing title and the body
 * shown under it. `title` is null when the service is gone and the separate
 * 需要处理 notification replaces the ongoing one. */
internal data class CaptureNotificationStatus(
    val row: CaptureStatusRow, val title: String?, val detail: String,
    val screenCapturing: Boolean, val screenPaused: Boolean,
    val enabled: Boolean, val live: Boolean,
)

/** The capture status notification. The system entries plugin creates and owns
 * this publisher; when that scope is stopped no action is offered and the
 * reason stays visible. */
internal class Notifications(
    context: Context,
    private val gate: () -> SystemEntriesPlugin.Availability,
) {
    private val app = context.applicationContext
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val diagnosticsWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val attention = CaptureAttentionDedup()
    private var lastPublished: String? = null
    private var initialized = false
    private var closed = false
    private var localState: LocalStateSnapshot? = null
    private var liveSeen = false
    private var canceled = false
    private var screenStatus: String? = null
    private var mediaStatus: String? = null
    private var eventStatus: String? = null

    private fun availability() = if (closed) SystemEntriesPlugin.Availability(false, MoteI18n.text("系统入口插件已停用；快捷入口和通知动作不可用。")) else gate()

    @Synchronized fun showLocalState(state: LocalStateSnapshot) {
        if (closed) return
        localState = state
        publish()
    }

    fun create() {
        if (!availability().active) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("采集状态"), NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL, MoteI18n.text("需要处理"), NotificationManager.IMPORTANCE_DEFAULT))
    }

    /** The foreground service needs a notification immediately, before it has
     * finished validating its configuration; the passed text is its fallback
     * title until the first status read succeeds. */
    @Synchronized fun notification(text: String): Notification {
        initialized = true
        val status = currentStatus()
        val rendered = status.copy(title = status.title ?: text)
        lastPublished = publicationKey(rendered)
        canceled = false
        manager.cancel(MEDIA_ID)
        return build(rendered)
    }

    /** A service connected or went away; recompute the shared status row. */
    @Synchronized fun refresh() { if (!closed) publish() }

    @Synchronized fun show(text: String) { if (closed) return; screenStatus = text; publish() }
    @Synchronized fun clear() { if (closed) return; screenStatus = null; publish() }
    @Synchronized fun showMedia(text: String) { if (closed) return; mediaStatus = text; publish() }
    @Synchronized fun clearMedia() { if (closed) return; mediaStatus = null; publish() }
    @Synchronized fun showEvents(text: String?) { if (closed) return; eventStatus = text; publish() }

    private fun diagnostics(name: String) {
        if (closed) return
        runCatching { diagnosticsWorker.execute { Diagnostics(app).add(name) } }
    }

    private fun currentStatus(): CaptureNotificationStatus {
        val settings = runCatching { Settings(app) }.getOrNull()
        val config = runCatching { settings?.read() }.getOrNull()
        if (settings == null || config == null) {
            val row = CaptureStatusMapping.row(CaptureStatusId.CAPTURING)
            return CaptureNotificationStatus(row, ongoingCaptureTitle(row), "", false, false, false, false)
        }
        val state = localState
        val projection = config.effectiveMode() == "projection"
        val screenLive = config.screenCollectionEnabled &&
            (if (projection) ProjectionService.running else CaptureAccessibilityService.connected)
        val systemLive = config.observesSystem() && MediaCollectionService.connected
        val live = screenLive || systemLive
        if (live) liveSeen = true

        val screenAllowed = !config.screenCollectionEnabled || projection || accessibilityGranted()
        val systemAllowed = !config.observesSystem() || MediaCollection.permissionAllowed(app)
        val permissionMissing = !screenAllowed || !systemAllowed
        val screenUnavailable = config.screenCollectionEnabled && (!screenAllowed || !screenLive)
        val systemUnavailable = config.observesSystem() && (!systemAllowed || !systemLive)
        val selected = config.screenCollectionEnabled || config.observesSystem()
        val everCaptured = liveSeen || settings.lastCapture() != null
        val interrupted = if (settings.enabled) {
            selected && !live && !permissionMissing && everCaptured
        } else {
            !RuntimeSettings.stopping && settings.state() in setOf("permission_required", "error") && !permissionMissing && everCaptured
        }
        // One selected source running while another is gone is a partial
        // problem: its title changes but it does not start an incident.
        val partial = live && !permissionMissing && (screenUnavailable || systemUnavailable)
        val pausedAt = settings.screenPausedAt()?.takeIf { !config.screenCollectionEnabled }
        val row = CaptureStatusMapping.status(CaptureStatusFacts(
            connection = connection(config),
            captureEnabled = settings.enabled || interrupted,
            captureLive = live,
            screenPausedAt = pausedAt?.let { Instant.ofEpochMilli(it).toString() },
            permission = if (permissionMissing || partial) CapturePermission.MISSING else null,
            storageFull = queueFull(config, state) && settings.enabled,
            interrupted = interrupted,
            syncState = syncState(config, settings, state),
            pending = state?.pending,
        ))
        val screenPaused = row.id == CaptureStatusId.SCREEN_PAUSED
        val screenCapturing = config.screenCollectionEnabled && (screenLive || screenStatus != null) && row.level != CaptureStatusLevel.NEEDS_ACTION
        return CaptureNotificationStatus(
            row = row,
            title = ongoingCaptureTitle(row),
            detail = detail(row, config, settings, state, screenLive, systemLive, screenUnavailable, systemUnavailable),
            screenCapturing = screenCapturing,
            screenPaused = screenPaused,
            enabled = settings.enabled,
            live = live,
        )
    }

    private fun connection(config: CollectorConfig): CaptureConnection = when {
        config.hasSyncConnection() -> CaptureConnection.CONNECTED
        config.server.isNotBlank() && config.token.isNotBlank() -> CaptureConnection.RECONNECT
        else -> CaptureConnection.UNCONFIGURED
    }

    private fun syncState(config: CollectorConfig, settings: Settings, state: LocalStateSnapshot?): CaptureSyncState = when {
        !config.hasSyncConnection() -> CaptureSyncState.UNCONFIGURED
        config.syncPaused -> CaptureSyncState.PAUSED
        state?.error != null || (state?.active?.blocked ?: 0) > 0 -> CaptureSyncState.BLOCKED
        settings.syncState() == "error" -> CaptureSyncState.ERROR
        settings.syncState() == "uploading" -> CaptureSyncState.UPLOADING
        settings.syncState() == "waiting" -> CaptureSyncState.WAITING
        settings.syncState() == "paused" -> CaptureSyncState.PAUSED
        else -> CaptureSyncState.IDLE
    }

    private fun queueFull(config: CollectorConfig, state: LocalStateSnapshot?): Boolean =
        state?.active?.quotaBytes?.let { it >= config.maxQueueMiB.toLong() * 1024 * 1024 } ?: false

    private fun accessibilityGranted(): Boolean = runCatching {
        AndroidSettings.Secure.getString(app.contentResolver, AndroidSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?.split(':')
            ?.any { android.content.ComponentName.unflattenFromString(it) == android.content.ComponentName(app, CaptureAccessibilityService::class.java) } == true
    }.getOrDefault(false)

    private fun channels(config: CollectorConfig, screenLive: Boolean, systemLive: Boolean, folders: Int): String = listOfNotNull(
        MoteI18n.text("屏幕").takeIf { config.screenCollectionEnabled && screenLive },
        MoteI18n.text("通知").takeIf { config.notificationCollectionEnabled && systemLive },
        MoteI18n.text("设备事件").takeIf { config.deviceEventCollectionEnabled && systemLive },
        MoteI18n.text("媒体").takeIf { config.mediaCollectionEnabled && config.metadataEnabled && systemLive },
        MoteI18n.text("{0} 个文件夹", folders).takeIf { folders > 0 },
    ).joinToString(" · ")

    private fun selectedChannels(config: CollectorConfig, folders: Int): String = listOfNotNull(
        MoteI18n.text("屏幕").takeIf { config.screenCollectionEnabled },
        MoteI18n.text("通知").takeIf { config.notificationCollectionEnabled },
        MoteI18n.text("设备事件").takeIf { config.deviceEventCollectionEnabled },
        MoteI18n.text("媒体").takeIf { config.mediaCollectionEnabled && config.metadataEnabled },
        MoteI18n.text("{0} 个文件夹", folders).takeIf { folders > 0 },
    ).joinToString(" · ")

    private fun missingSources(config: CollectorConfig, screenUnavailable: Boolean, systemUnavailable: Boolean): String = listOfNotNull(
        MoteI18n.text("屏幕").takeIf { screenUnavailable },
        MoteI18n.text("通知").takeIf { systemUnavailable && (config.notificationCollectionEnabled || !config.deviceEventCollectionEnabled && !config.mediaCollectionEnabled) },
        MoteI18n.text("设备事件").takeIf { systemUnavailable && config.deviceEventCollectionEnabled },
        MoteI18n.text("媒体").takeIf { systemUnavailable && config.mediaCollectionEnabled },
    ).joinToString(" · ")

    private fun detail(
        row: CaptureStatusRow, config: CollectorConfig, settings: Settings, state: LocalStateSnapshot?,
        screenLive: Boolean, systemLive: Boolean, screenUnavailable: Boolean, systemUnavailable: Boolean,
    ): String {
        val channels = channels(config, screenLive, systemLive, state?.folders ?: 0)
        val sourceStatus = listOfNotNull(screenStatus, mediaStatus, eventStatus).joinToString(" · ")
        return when (row.id) {
            CaptureStatusId.SCREEN_PAUSED -> settings.screenPausedAt()
                ?.let { CaptureOverview.since(it, Instant.now(), ZoneId.systemDefault()) }.orEmpty()
            CaptureStatusId.PERMISSION -> missingSources(config, screenUnavailable, systemUnavailable)
                .ifBlank { MoteI18n.text("等待采集权限") }
            CaptureStatusId.RECONNECT -> config.server.ifBlank { channels }
            CaptureStatusId.INTERRUPTED -> selectedChannels(config, state?.folders ?: 0)
            CaptureStatusId.PAUSED -> channels.ifBlank { sourceStatus.ifBlank { state?.captureMessage.orEmpty() } }
            else -> channels.ifBlank { sourceStatus }
        }
    }

    private fun shouldPublish(status: CaptureNotificationStatus): Boolean =
        status.enabled || status.live || screenStatus != null || mediaStatus != null || eventStatus != null

    private fun publicationKey(status: CaptureNotificationStatus): String = listOf(
        status.title.orEmpty(), status.detail, availability().active.toString(),
        SystemEntriesPlugin.notificationActions(availability(), status.screenCapturing, status.screenPaused, status.row.level == CaptureStatusLevel.NEEDS_ACTION).joinToString(","),
    ).joinToString("\n")

    private fun build(status: CaptureNotificationStatus): Notification {
        val availability = availability()
        val text = SystemEntriesPlugin.surfaceText(availability, status.detail)
        // The status panel opens on top of the existing task, so a draft or reader underneath stays where it was.
        val open = PendingIntent.getActivity(app, 0, Intent(app, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = status.title ?: MoteI18n.text("采集中")
        val builder = Notification.Builder(app, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle(title)
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text.ifBlank { title })).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true)
        for (action in SystemEntriesPlugin.notificationActions(availability, status.screenCapturing, status.screenPaused, status.row.level == CaptureStatusLevel.NEEDS_ACTION)) when (action) {
            SystemEntriesPlugin.Action.PAUSE_SCREEN -> builder.addAction(Notification.Action.Builder(null, MoteI18n.text("暂停屏幕采集"),
                PendingIntent.getBroadcast(app, 2, Intent(app, PauseScreenReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            SystemEntriesPlugin.Action.RESUME_SCREEN -> builder.addAction(Notification.Action.Builder(null, MoteI18n.text("恢复屏幕采集"),
                PendingIntent.getActivity(app, 3, Intent(app, MainActivity::class.java).putExtra("captureAction", CaptureOverview.Action.RESUME.name)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            SystemEntriesPlugin.Action.STOP_CAPTURE -> builder.addAction(Notification.Action.Builder(null, MoteI18n.text("停止采集"),
                PendingIntent.getBroadcast(app, 1, Intent(app, StopReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            SystemEntriesPlugin.Action.RECORD -> MoteQuickEntry.RECORD.pendingIntent(app)?.let { entry ->
                builder.addAction(Notification.Action.Builder(null, MoteQuickEntry.RECORD.label, entry).build())
            }
            SystemEntriesPlugin.Action.ATTENTION -> builder.addAction(Notification.Action.Builder(null, SystemEntriesPlugin.attentionLabel(status.row.notification?.operation), open).build())
        }
        return builder.build()
    }

    /** One alert per interruption. Partial problems never reach this channel;
     * they only change the ongoing title above. */
    private fun postAttention(status: CaptureNotificationStatus) {
        val row = status.row
        val title = captureAttentionTitle(row) ?: MoteI18n.text("采集已中断")
        val text = SystemEntriesPlugin.surfaceText(availability(), status.detail).ifBlank { title }
        val open = PendingIntent.getActivity(app, 10, Intent(app, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(app, ATTENTION_CHANNEL).setSmallIcon(R.drawable.ic_mote)
            .setContentTitle(title).setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open).setAutoCancel(true).setCategory(Notification.CATEGORY_ERROR)
        row.notification?.operation?.let { operation ->
            val target = when (operation) {
                CaptureStatusOperation.RESTART_CAPTURE -> Intent(app, MainActivity::class.java)
                    .putExtra("captureAction", CaptureOverview.Action.RESTART.name)
                else -> Intent(app, CaptureStatusActivity::class.java)
            }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            builder.addAction(Notification.Action.Builder(null, SystemEntriesPlugin.attentionLabel(operation),
                PendingIntent.getActivity(app, 11, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
        }
        if (manager.areNotificationsEnabled()) {
            manager.notify(ATTENTION_ID, builder.build())
            diagnostics("attentionPublishes")
        }
    }

    private fun publish() {
        if (closed) { manager.cancel(MEDIA_ID); manager.cancel(ID); manager.cancel(ATTENTION_ID); return }
        if (!initialized) { manager.cancel(MEDIA_ID); manager.cancel(ID); initialized = true }
        val status = currentStatus()
        if (status.row.id == CaptureStatusId.INTERRUPTED) {
            if (manager.areNotificationsEnabled() && attention.update(status.row)) postAttention(status)
            manager.cancel(ID); manager.cancel(MEDIA_ID)
            lastPublished = null
            return
        }
        attention.update(status.row)
        manager.cancel(ATTENTION_ID)
        if (!shouldPublish(status)) {
            manager.cancel(ID); manager.cancel(MEDIA_ID); lastPublished = null
            if (!canceled) { canceled = true; diagnostics("notificationCancels") }
            return
        }
        canceled = false
        val key = publicationKey(status)
        if (key == lastPublished) return
        if (manager.areNotificationsEnabled()) {
            manager.notify(ID, build(status)); lastPublished = key; diagnostics("notificationPublishes")
        }
    }

    /** Idempotent: a stopped scope leaves no publisher, executor or status
     * notification behind. */
    @Synchronized fun close() {
        if (closed) return
        closed = true
        manager.cancel(ID); manager.cancel(MEDIA_ID); manager.cancel(ATTENTION_ID)
        diagnosticsWorker.shutdownNow()
    }

    companion object {
        const val ID = 4101
        private const val MEDIA_ID = 4102
        internal const val ATTENTION_ID = 4103
        private const val CHANNEL = "mote_capture"
        private const val ATTENTION_CHANNEL = "mote_attention"
    }
}

/** The publisher installed by the system entries plugin. */
internal fun Context.systemEntries(): Notifications = SystemEntriesPlugin.notifications(this)

class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = holdUntilDone { done -> dev.mote.collector.plugins.CapturePlugin.controls().stopAll(context) { done() } }
}

/** The recording notification belongs to the microphone service, not screen capture. */
internal fun recordingNotification(context: Context, snapshot: dev.mote.collector.recording.RecordingSnapshot): Notification {
    val channel = "mote_recording"
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(channel, MoteI18n.text("录音"), NotificationManager.IMPORTANCE_LOW))
    val open = PendingIntent.getActivity(context, 4103, Intent(context, RecordEditorActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun action(name: String, request: Int) = PendingIntent.getService(context, request,
        Intent(context, dev.mote.collector.recording.RecordingService::class.java).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val paused = snapshot.phase == dev.mote.collector.recording.RecordingPhase.PAUSED
    val stopping = snapshot.phase == dev.mote.collector.recording.RecordingPhase.STOPPING
    val builder = Notification.Builder(context, channel).setSmallIcon(R.drawable.ic_mote)
        .setContentTitle(MoteI18n.text(if (paused) "录音已暂停" else "录音"))
        .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
        .setWhen(System.currentTimeMillis() - snapshot.elapsedMs).setShowWhen(true).setUsesChronometer(!paused && !stopping)
    if (!stopping) {
        builder.addAction(Notification.Action.Builder(null, MoteI18n.text(if (paused) "继续" else "暂停"),
            action(if (paused) dev.mote.collector.recording.RecordingService.ACTION_RESUME else dev.mote.collector.recording.RecordingService.ACTION_PAUSE, 4104)).build())
        builder.addAction(Notification.Action.Builder(null, MoteI18n.text("停止"), action(dev.mote.collector.recording.RecordingService.ACTION_STOP, 4105)).build())
    }
    return builder.build()
}
