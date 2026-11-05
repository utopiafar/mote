package dev.mote.collector

/** Mirrors @mote/shared/native-status; capture-status-cases.json is the shared contract. */
internal enum class CaptureStatusLevel(val wire: String) { NORMAL("normal"), REMINDER("reminder"), NEEDS_ACTION("needs_action") }
internal enum class CaptureStatusId(val wire: String) {
    CAPTURING("capturing"), PENDING_SYNC("pending_sync"), SCREEN_PAUSED("screen_paused"), PAUSED("paused"),
    SEND_PAUSED("send_paused"), LOCAL_ONLY("local_only"), RECONNECT("reconnect"), STORAGE_FULL("storage_full"),
    INTERRUPTED("interrupted"), PERMISSION("permission"), SEND_ATTENTION("send_attention"), DISCONNECTED("disconnected")
}
internal enum class CaptureStatusOperation(val wire: String) {
    RESUME_CAPTURE("resume_capture"), RESUME_SEND("resume_send"), RECONNECT("reconnect"), RESTART_CAPTURE("restart_capture"),
    OPEN_PERMISSIONS("open_permissions"), OPEN_STORAGE("open_storage"), OPEN_SYNC("open_sync")
}
internal enum class CaptureStatusPlatform(val wire: String) { IOS("ios"), ANDROID("android"), MACOS("macos") }
internal enum class CaptureStatusTone(val wire: String) { OK("ok"), NEUTRAL("neutral"), WARN("warn") }
internal enum class CaptureStatusMacIcon(val wire: String) { NORMAL("normal"), PAUSED("paused"), ALERT("alert") }
internal enum class CaptureConnection(val wire: String) { CONNECTED("connected"), UNCONFIGURED("unconfigured"), RECONNECT("reconnect") }
internal enum class CaptureSyncState(val wire: String) {
    UNCONFIGURED("unconfigured"), IDLE("idle"), WAITING("waiting"), UPLOADING("uploading"), PAUSED("paused"), BLOCKED("blocked"), ERROR("error")
}
internal enum class CapturePermission(val wire: String) { MISSING("missing"), PARTIAL("partial") }

internal data class CaptureStatusHome(val titleKey: String, val operation: CaptureStatusOperation)
internal data class CaptureStatusNotification(val titleKey: String, val operation: CaptureStatusOperation, val platforms: List<CaptureStatusPlatform>)
internal data class CaptureStatusCentral(val textKey: String, val tone: CaptureStatusTone)
internal data class CaptureStatusRow(
    val id: CaptureStatusId, val level: CaptureStatusLevel,
    val home: CaptureStatusHome?, val notification: CaptureStatusNotification?,
    val androidOngoing: String?, val macIcon: CaptureStatusMacIcon?, val central: CaptureStatusCentral?
)
internal data class CaptureStatusFacts(
    val connection: CaptureConnection, val captureEnabled: Boolean, val captureLive: Boolean,
    val screenPausedAt: String? = null, val permission: CapturePermission? = null,
    val storageFull: Boolean? = null, val interrupted: Boolean? = null,
    val syncState: CaptureSyncState, val pending: Int? = null, val disconnected: Boolean? = null
)

/** The only shift from facts to a displayed row; the level and every display column come from the table. */
internal object CaptureStatusMapping {
    private val allPlatforms = listOf(CaptureStatusPlatform.IOS, CaptureStatusPlatform.ANDROID, CaptureStatusPlatform.MACOS)
    private val mobileAndDesktop = listOf(CaptureStatusPlatform.ANDROID, CaptureStatusPlatform.MACOS)
    private fun home(titleKey: String, operation: CaptureStatusOperation) = CaptureStatusHome(titleKey, operation)
    private fun notification(titleKey: String, operation: CaptureStatusOperation, platforms: List<CaptureStatusPlatform> = allPlatforms) =
        CaptureStatusNotification(titleKey, operation, platforms)

    val table: List<CaptureStatusRow> = listOf(
        CaptureStatusRow(CaptureStatusId.CAPTURING, CaptureStatusLevel.NORMAL, null, null, "采集中", CaptureStatusMacIcon.NORMAL, CaptureStatusCentral("正在采集", CaptureStatusTone.OK)),
        CaptureStatusRow(CaptureStatusId.PENDING_SYNC, CaptureStatusLevel.NORMAL, null, null, "采集中 · 待同步 {0} 条", CaptureStatusMacIcon.NORMAL, CaptureStatusCentral("正在采集", CaptureStatusTone.OK)),
        CaptureStatusRow(CaptureStatusId.SCREEN_PAUSED, CaptureStatusLevel.REMINDER, home("屏幕采集已暂停", CaptureStatusOperation.RESUME_CAPTURE), null, "屏幕采集已暂停", CaptureStatusMacIcon.PAUSED, CaptureStatusCentral("正在采集", CaptureStatusTone.OK)),
        CaptureStatusRow(CaptureStatusId.PAUSED, CaptureStatusLevel.REMINDER, home("采集已暂停", CaptureStatusOperation.RESUME_CAPTURE), null, "采集已暂停", CaptureStatusMacIcon.PAUSED, CaptureStatusCentral("已暂停", CaptureStatusTone.NEUTRAL)),
        CaptureStatusRow(CaptureStatusId.SEND_PAUSED, CaptureStatusLevel.REMINDER, home("发送已暂停", CaptureStatusOperation.RESUME_SEND), null, "采集中 · 发送已暂停", CaptureStatusMacIcon.NORMAL, null),
        CaptureStatusRow(CaptureStatusId.LOCAL_ONLY, CaptureStatusLevel.REMINDER, null, null, "采集中", CaptureStatusMacIcon.NORMAL, null),
        CaptureStatusRow(CaptureStatusId.RECONNECT, CaptureStatusLevel.NEEDS_ACTION, home("需要重新连接", CaptureStatusOperation.RECONNECT), notification("需要重新连接", CaptureStatusOperation.RECONNECT), "需要重新连接", CaptureStatusMacIcon.ALERT, CaptureStatusCentral("需要处理", CaptureStatusTone.WARN)),
        CaptureStatusRow(CaptureStatusId.STORAGE_FULL, CaptureStatusLevel.NEEDS_ACTION, home("本机空间已满", CaptureStatusOperation.OPEN_STORAGE), notification("本机空间已满", CaptureStatusOperation.OPEN_STORAGE), "本机空间已满", CaptureStatusMacIcon.ALERT, CaptureStatusCentral("需要处理", CaptureStatusTone.WARN)),
        CaptureStatusRow(CaptureStatusId.INTERRUPTED, CaptureStatusLevel.NEEDS_ACTION, home("采集已中断", CaptureStatusOperation.RESTART_CAPTURE), notification("采集已中断", CaptureStatusOperation.RESTART_CAPTURE, mobileAndDesktop), null, CaptureStatusMacIcon.ALERT, CaptureStatusCentral("需要处理", CaptureStatusTone.WARN)),
        CaptureStatusRow(CaptureStatusId.PERMISSION, CaptureStatusLevel.NEEDS_ACTION, home("等待采集权限", CaptureStatusOperation.OPEN_PERMISSIONS), notification("等待采集权限", CaptureStatusOperation.OPEN_PERMISSIONS), "部分来源等待权限", CaptureStatusMacIcon.ALERT, CaptureStatusCentral("等待权限", CaptureStatusTone.WARN)),
        CaptureStatusRow(CaptureStatusId.SEND_ATTENTION, CaptureStatusLevel.NEEDS_ACTION, home("发送需要处理", CaptureStatusOperation.OPEN_SYNC), notification("发送需要处理", CaptureStatusOperation.OPEN_SYNC), "采集中 · 发送需要处理", CaptureStatusMacIcon.ALERT, null),
        CaptureStatusRow(CaptureStatusId.DISCONNECTED, CaptureStatusLevel.NEEDS_ACTION, null, null, null, null, CaptureStatusCentral("失联", CaptureStatusTone.WARN))
    )

    private val byId = table.associateBy { it.id }
    fun row(id: CaptureStatusId): CaptureStatusRow = byId.getValue(id)

    /** Needs-action facts win over reminders; disconnected is Central-only. */
    fun status(facts: CaptureStatusFacts): CaptureStatusRow {
        if (facts.disconnected == true) return row(CaptureStatusId.DISCONNECTED)
        if (facts.connection == CaptureConnection.RECONNECT) return row(CaptureStatusId.RECONNECT)
        if (facts.storageFull == true) return row(CaptureStatusId.STORAGE_FULL)
        if (facts.captureEnabled && facts.interrupted == true) return row(CaptureStatusId.INTERRUPTED)
        if (facts.captureEnabled && facts.permission != null) return row(CaptureStatusId.PERMISSION)
        if (facts.captureEnabled && !facts.captureLive) return row(CaptureStatusId.PERMISSION)
        if (facts.connection == CaptureConnection.CONNECTED && facts.syncState in setOf(CaptureSyncState.ERROR, CaptureSyncState.BLOCKED)) return row(CaptureStatusId.SEND_ATTENTION)
        if (facts.captureEnabled && facts.screenPausedAt != null) return row(CaptureStatusId.SCREEN_PAUSED)
        if (!facts.captureEnabled) return row(CaptureStatusId.PAUSED)
        if (facts.connection == CaptureConnection.UNCONFIGURED || facts.syncState == CaptureSyncState.UNCONFIGURED) return row(CaptureStatusId.LOCAL_ONLY)
        if (facts.connection == CaptureConnection.CONNECTED && facts.syncState == CaptureSyncState.PAUSED) return row(CaptureStatusId.SEND_PAUSED)
        if ((facts.pending ?: 0) > 0) return row(CaptureStatusId.PENDING_SYNC)
        return row(CaptureStatusId.CAPTURING)
    }
}
