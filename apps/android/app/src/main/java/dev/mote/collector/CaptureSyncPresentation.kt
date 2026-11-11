package dev.mote.collector

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Presentation projection for the Android 采集与同步 page: added sources, sending and local storage. */
internal object CaptureSyncPresentation {
    enum class SourceKind(val titleKey: String) {
        SCREEN("屏幕与应用活动"), MEETING("本机会议录音"), OBSERVATIONS("通知与设备事件"), MEDIA("媒体"), FILES("同步文件夹"), CALENDAR("本机日历")
    }

    enum class AddKind(val titleKey: String, val opensCentral: Boolean = false) {
        FILE("导入文件"), FOLDER("同步文件夹"), CALENDAR("连接本机日历"), SCREEN("屏幕与应用活动"), CLOUD("云端来源", true)
    }
    val addKinds = AddKind.entries.toList()

    /** Single-instance kinds leave the panel once the overview already lists them. */
    fun availableAddKinds(added: Set<SourceKind>): List<AddKind> = addKinds.filterNot { kind ->
        when (kind) {
            AddKind.CALENDAR -> SourceKind.CALENDAR in added
            AddKind.SCREEN -> SourceKind.SCREEN in added
            else -> false
        }
    }

    /** Source states the owner must handle before syncing continues. */
    private val attentionStatuses = mapOf(
        "permission" to "等待采集权限",
        "consent" to "需要确认发送范围",
        "context-conflict" to "资料说明冲突",
        "context-http" to "资料说明等待确认",
        "provider" to "暂时无法读取",
        "paused" to "中央已暂停",
    )

    /** Per-kind collection facts for capture sources that live outside the local source store. */
    data class KindFacts(val present: Boolean, val needsAction: Boolean = false, val paused: Boolean = false, val lastAt: String? = null)

    /** One local source reduced to what the aggregated row needs. */
    data class SourceFacts(val id: String, val enabled: Boolean, val status: String, val lastScan: String)

    data class SourceRow(
        val kind: SourceKind, val title: String, val detail: String, val warn: Boolean,
        val actionLabel: String?, val attentionSourceId: String?,
    )

    enum class SendState { LOCAL, RECONNECT, PAUSED, PENDING, SYNCED }
    data class SendView(val state: SendState, val host: String, val text: String, val warn: Boolean, val actionLabel: String?)

    fun sources(
        screen: KindFacts, observations: KindFacts, media: KindFacts,
        files: List<SourceFacts>, calendars: List<SourceFacts>,
        now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), meeting: KindFacts = KindFacts(false),
    ): List<SourceRow> = buildList {
        fun kindDetail(facts: KindFacts, now: Instant, zone: ZoneId) = when {
            facts.needsAction -> MoteI18n.text("等待采集权限")
            facts.paused -> MoteI18n.text("已暂停")
            else -> recentLabel(facts.lastAt, now, zone)
        }
        if (screen.present) add(SourceRow(SourceKind.SCREEN, MoteI18n.text(SourceKind.SCREEN.titleKey), kindDetail(screen, now, zone),
            warn = screen.needsAction, actionLabel = if (screen.needsAction) MoteI18n.text("处理") else null, attentionSourceId = null))
        if (meeting.present) add(SourceRow(SourceKind.MEETING, MoteI18n.text(SourceKind.MEETING.titleKey), kindDetail(meeting, now, zone),
            warn = meeting.needsAction, actionLabel = if (meeting.needsAction) MoteI18n.text("处理") else null, attentionSourceId = null))
        if (observations.present) add(SourceRow(SourceKind.OBSERVATIONS, MoteI18n.text(SourceKind.OBSERVATIONS.titleKey), kindDetail(observations, now, zone),
            warn = observations.needsAction, actionLabel = if (observations.needsAction) MoteI18n.text("处理") else null, attentionSourceId = null))
        if (media.present) add(SourceRow(SourceKind.MEDIA, MoteI18n.text(SourceKind.MEDIA.titleKey), kindDetail(media, now, zone),
            warn = media.needsAction, actionLabel = if (media.needsAction) MoteI18n.text("处理") else null, attentionSourceId = null))
        kindRow(SourceKind.FILES, files, MoteI18n.text("{0} 个", files.size))?.let(::add)
        kindRow(SourceKind.CALENDAR, calendars,
            calendars.filter { it.enabled }.mapNotNull { it.lastScan.takeIf(String::isNotBlank) }.maxOrNull()
                ?.let { dayLabel(it, now, zone) }?.ifBlank { null }
                ?: MoteI18n.text("{0} 个", calendars.size))?.let(::add)
    }

    private fun kindRow(kind: SourceKind, sources: List<SourceFacts>, detail: String): SourceRow? {
        if (sources.isEmpty()) return null
        val attention = sources.firstOrNull { it.enabled && it.status in attentionStatuses }
        if (attention != null) return SourceRow(kind, MoteI18n.text(kind.titleKey), MoteI18n.text(attentionStatuses.getValue(attention.status)),
            warn = true, actionLabel = MoteI18n.text("处理"), attentionSourceId = attention.id)
        if (sources.all { !it.enabled }) return SourceRow(kind, MoteI18n.text(kind.titleKey), MoteI18n.text("已暂停"),
            warn = false, actionLabel = null, attentionSourceId = null)
        return SourceRow(kind, MoteI18n.text(kind.titleKey), detail, warn = false, actionLabel = null, attentionSourceId = null)
    }

    /** The four owner-visible send states plus the never-connected local state. */
    fun send(
        server: String, connected: Boolean, sendPaused: Boolean, sendState: String, pending: Int?, acknowledgedAt: String?,
        now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
    ): SendView {
        val host = host(server)
        return when {
            server.isBlank() -> SendView(SendState.LOCAL, host, MoteI18n.text("仅保存在本机"), warn = false, actionLabel = null)
            !connected -> SendView(SendState.RECONNECT, host, MoteI18n.text("需要重新连接"), warn = true, actionLabel = MoteI18n.text("连接"))
            sendPaused -> SendView(SendState.PAUSED, host, MoteI18n.text("发送已暂停"), warn = false, actionLabel = null)
            sendState in setOf("error", "blocked") -> SendView(SendState.RECONNECT, host, MoteI18n.text("需要重新连接"), warn = true, actionLabel = MoteI18n.text("连接"))
            (pending ?: 0) > 0 -> SendView(SendState.PENDING, host, MoteI18n.text("待同步 {0} 条", pending), warn = false, actionLabel = MoteI18n.text("立即发送"))
            else -> SendView(SendState.SYNCED, host,
                if (acknowledgedAt != null) MoteI18n.text("已同步 · {0}", timeLabel(acknowledgedAt, now, zone)) else MoteI18n.text("已同步"),
                warn = false, actionLabel = null)
        }
    }

    fun host(server: String): String {
        val trimmed = server.trim().trimEnd('/')
        if (trimmed.isBlank()) return MoteI18n.text("尚未连接")
        return runCatching { java.net.URI(trimmed) }.getOrNull()
            ?.let { uri -> uri.host?.takeIf(String::isNotBlank)?.let { h -> if (uri.port > 0) "$h:${uri.port}" else h } }
            ?: trimmed.substringAfter("://").substringBefore("/").ifBlank { trimmed }
    }

    fun syncModeLabel(mode: String): String = when (mode) {
        "realtime" -> MoteI18n.text("有新内容时发送")
        "interval" -> MoteI18n.text("定时发送")
        "manual" -> MoteI18n.text("仅手动发送")
        else -> MoteI18n.text("凑够一批后发送")
    }

    /** Send-method row value: the Wi-Fi-only summary when it is on, otherwise the sync mode. */
    fun sendMethodLabel(mode: String, wifiOnly: Boolean): String =
        if (wifiOnly) MoteI18n.text("仅 Wi-Fi") else syncModeLabel(mode)

    fun storageLabel(bytes: Long?): String = when {
        bytes == null -> ""
        bytes >= 1L shl 30 -> "%.1f GB".format(bytes / (1024.0 * 1024 * 1024))
        bytes >= 1L shl 20 -> "%.1f MiB".format(bytes / (1024.0 * 1024))
        else -> "%.0f KiB".format(bytes / 1024.0)
    }

    /** Row-trailing recency: same-day time, yesterday, or a short date. */
    fun recentLabel(isoTime: String?, now: Instant, zone: ZoneId): String {
        val at = isoTime?.takeIf(String::isNotBlank)?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
        val time = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        return when (time.toLocalDate()) {
            today -> DateTimeFormatter.ofPattern("HH:mm").format(time)
            today.minusDays(1) -> MoteI18n.text("昨天")
            else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(MoteI18n.locale()).format(time)
        }
    }

    /** Day-level label for the calendar row: 今天 / 昨天 / short date. */
    fun dayLabel(isoTime: String?, now: Instant, zone: ZoneId): String {
        val at = isoTime?.takeIf(String::isNotBlank)?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
        val time = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        return when (time.toLocalDate()) {
            today -> MoteI18n.text("今天")
            today.minusDays(1) -> MoteI18n.text("昨天")
            else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(MoteI18n.locale()).format(time)
        }
    }

    private fun timeLabel(isoTime: String, now: Instant, zone: ZoneId): String =
        runCatching { Instant.parse(isoTime).atZone(zone) }.getOrNull()
            ?.let { DateTimeFormatter.ofPattern("HH:mm").format(it) } ?: isoTime
}
