package dev.mote.collector

import android.content.Context
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** One owner-facing line for capture and sending. Device facts only; nothing is inferred from captured content. */
internal object CaptureOverview {
    enum class Kind { HIDDEN, ACTIVE, SCREEN_PAUSED, PAUSED, ATTENTION }
    /** Resume and restart return to the app's preview or the system consent; pausing never needs either. */
    enum class Action { RESUME, RESTART, PERMISSIONS, STORAGE }
    data class Facts(
        val enabled: Boolean, val state: String, val message: String, val used: Boolean,
        val screenSelected: Boolean, val screenLive: Boolean, val projection: Boolean, val screenPausedAt: Long?,
        val notifications: Boolean, val deviceEvents: Boolean, val media: Boolean, val systemLive: Boolean,
        val queueFull: Boolean, val folders: Int,
        val connected: Boolean, val sendPaused: Boolean, val sendState: String, val pending: Int?, val acknowledged: Boolean
    ) {
        val observesSystem get() = notifications || deviceEvents || media
        val live get() = screenLive || systemLive
        val missingSource get() = screenSelected && !screenLive || observesSystem && !systemLive
    }
    data class Line(val kind: Kind, val title: String, val detail: String, val send: String, val sendAttention: Boolean, val action: Action?)

    /** Capture facts only; sending keeps its own line and never turns a live capture into an attention state. */
    fun attention(enabled: Boolean, state: String, live: Boolean, missingSource: Boolean, queueFull: Boolean): Boolean {
        // A safe stop leaves the old error state behind; it is still an interruption the owner must repair.
        val interrupted = interrupted(state)
        return CaptureStatusMapping.status(CaptureStatusFacts(
            connection = CaptureConnection.CONNECTED, captureEnabled = enabled || interrupted, captureLive = live,
            permission = if (missingSource) CapturePermission.MISSING else null, storageFull = queueFull && enabled,
            interrupted = interrupted, syncState = CaptureSyncState.IDLE
        )).level == CaptureStatusLevel.NEEDS_ACTION
    }

    /** The shared status row view of these device facts; the ongoing notification and Quick Settings tiles read it. */
    fun statusFacts(f: Facts): CaptureStatusFacts {
        val interrupted = interrupted(f.state)
        return CaptureStatusFacts(
            connection = if (f.connected) CaptureConnection.CONNECTED else CaptureConnection.UNCONFIGURED,
            captureEnabled = f.enabled || interrupted, captureLive = f.live,
            screenPausedAt = f.screenPausedAt?.let { Instant.ofEpochMilli(it).toString() },
            permission = if (f.missingSource) CapturePermission.MISSING else null,
            storageFull = f.queueFull && f.enabled, interrupted = interrupted,
            syncState = when (f.sendState) {
                "unconfigured" -> CaptureSyncState.UNCONFIGURED; "waiting" -> CaptureSyncState.WAITING
                "uploading" -> CaptureSyncState.UPLOADING; "paused" -> CaptureSyncState.PAUSED
                "blocked" -> CaptureSyncState.BLOCKED; "error" -> CaptureSyncState.ERROR
                else -> CaptureSyncState.IDLE
            },
            pending = f.pending
        )
    }

    private fun interrupted(state: String) = state in setOf("permission_required", "error")

    fun kind(f: Facts): Kind = when {
        attention(f.enabled, f.state, f.live, f.missingSource, f.queueFull) -> Kind.ATTENTION
        screenPaused(f) -> Kind.SCREEN_PAUSED
        !f.enabled -> if (f.used) Kind.PAUSED else Kind.HIDDEN
        else -> Kind.ACTIVE
    }

    /**
     * Only an explicit temporary pause is a screen pause; turning screen capture off in settings is not. It describes the
     * state while other sources run or when the screen was the only source. Stopping everything while other sources are
     * selected is a full pause, whose resume brings the paused screen back through the preview.
     */
    fun screenPaused(f: Facts) = f.screenPausedAt != null && !f.screenSelected && (f.enabled || !f.observesSystem)

    fun line(f: Facts, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Line {
        val (send, sendAttention) = send(f)
        return when (val kind = kind(f)) {
            Kind.HIDDEN -> Line(kind, "", "", send, sendAttention, null)
            Kind.ACTIVE -> Line(kind, MoteI18n.text("采集中"), channels(f).joinToString(separator()), send, sendAttention, null)
            Kind.SCREEN_PAUSED -> Line(kind, MoteI18n.text("屏幕采集已暂停"),
                listOfNotNull(since(f.screenPausedAt!!, now, zone), MoteI18n.text("其他来源照常采集").takeIf { f.enabled }).joinToString(" · "), send, sendAttention, Action.RESUME)
            Kind.PAUSED -> Line(kind, MoteI18n.text("采集已暂停"), if (f.folders > 0) MoteI18n.text("文件夹照常同步") else "", send, sendAttention, Action.RESUME)
            Kind.ATTENTION -> {
                val (title, action) = when {
                    !f.enabled -> MoteI18n.text("采集已中断") to Action.RESTART
                    // A projection session ends with the lock screen or process; only new system consent restarts it.
                    f.screenSelected && !f.screenLive && f.projection -> (if (f.systemLive) MoteI18n.text("部分来源等待权限") else MoteI18n.text("等待采集权限")) to Action.RESTART
                    !f.live -> MoteI18n.text("等待采集权限") to Action.PERMISSIONS
                    f.missingSource -> MoteI18n.text("部分来源等待权限") to Action.PERMISSIONS
                    f.queueFull -> MoteI18n.text("本机空间已满") to Action.STORAGE
                    else -> MoteI18n.text("需要处理") to Action.PERMISSIONS
                }
                Line(kind, title, f.message, send, sendAttention, action)
            }
        }
    }

    fun label(action: Action): String = when (action) {
        Action.RESUME -> MoteI18n.text("恢复采集")
        Action.RESTART -> MoteI18n.text("重新开启")
        Action.PERMISSIONS, Action.STORAGE -> MoteI18n.text("处理")
    }

    /** Sending stays independent: local save, pending and Central acknowledgement are reported as they are. */
    fun send(f: Facts): Pair<String, Boolean> = when {
        !f.connected -> MoteI18n.text("仅保存在本机") to false
        f.sendPaused -> MoteI18n.text("发送已暂停") to false
        f.sendState in setOf("error", "blocked") -> MoteI18n.text("发送需要处理") to true
        (f.pending ?: 0) > 0 -> MoteI18n.text("待同步 {0} 条", f.pending) to false
        f.acknowledged && f.pending == 0 -> MoteI18n.text("已同步") to false
        else -> "" to false
    }

    fun channels(f: Facts): List<String> = listOfNotNull(
        MoteI18n.text("屏幕").takeIf { f.screenSelected && f.screenLive },
        MoteI18n.text("通知").takeIf { f.notifications && f.systemLive },
        MoteI18n.text("设备事件").takeIf { f.deviceEvents && f.systemLive },
        MoteI18n.text("媒体").takeIf { f.media && f.systemLive },
        MoteI18n.text("{0} 个文件夹", f.folders).takeIf { f.folders > 0 }
    )

    fun since(at: Long, now: Instant, zone: ZoneId): String {
        val time = Instant.ofEpochMilli(at).atZone(zone)
        val label = if (time.toLocalDate() == now.atZone(zone).toLocalDate()) DateTimeFormatter.ofPattern("HH:mm").format(time)
            else DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(MoteI18n.locale()).format(time)
        return MoteI18n.text("{0} 起", label)
    }

    private fun separator() = if (MoteI18n.language() in setOf("zh-CN", "ja")) "、" else ", "

    /** Reads cached settings and service flags; call off the main thread because local sources may wait for storage. */
    fun facts(context: Context, settings: Settings, c: CollectorConfig, local: LocalStateSnapshot): Facts {
        val projection = c.effectiveMode() == "projection"
        val screenLive = c.screenCollectionEnabled && (if (projection) ProjectionService.running else CaptureAccessibilityService.connected)
        val pausedAt = settings.screenPausedAt()
        if (pausedAt != null && c.screenCollectionEnabled) settings.screenPaused(null)
        val bytes = local.active?.quotaBytes?.div(1024.0 * 1024)
        return Facts(settings.enabled, settings.state(), settings.message(), settings.capturePreviewSeen() || settings.lastCapture() != null,
            c.screenCollectionEnabled, screenLive, projection, pausedAt?.takeIf { !c.screenCollectionEnabled },
            c.notificationCollectionEnabled, c.deviceEventCollectionEnabled, c.mediaCollectionEnabled && c.metadataEnabled, c.observesSystem() && MediaCollectionService.connected,
            bytes != null && bytes >= c.maxQueueMiB, runCatching { context.localSources().sources().count { it.tree && it.enabled } }.getOrDefault(0),
            c.hasSyncConnection(), c.syncPaused,
            when { UploadHistoryRecovery.unavailable -> "error"; local.error != null || (local.active?.blocked ?: 0) > 0 -> "blocked"; else -> settings.syncState() },
            local.pending, settings.lastAcknowledgedAt() != null)
    }
}
