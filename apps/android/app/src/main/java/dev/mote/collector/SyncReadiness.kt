package dev.mote.collector

internal data class StoredSyncStatus(val state: String, val message: String)

internal sealed interface VisibleSyncStatus {
    data class Message(val text: String) : VisibleSyncStatus
    data object Loading : VisibleSyncStatus
    data object Unavailable : VisibleSyncStatus
    data object SourceUnavailable : VisibleSyncStatus
    data object Disconnected : VisibleSyncStatus
    data object SendAsConfigured : VisibleSyncStatus
    data class NeedsAttention(val blocked: Int, val pending: Int) : VisibleSyncStatus
    data class NeedsSourceAttention(val sources: Int, val pending: Int) : VisibleSyncStatus
    data class Many(val items: List<VisibleSyncStatus>) : VisibleSyncStatus
}

/** Projects known stale configuration labels; never changes stored state or receipts. */
internal object SyncReadiness {
    const val NOT_CONFIGURED = "仅保存在本机 · 连接节点后可同步"
    const val WORKER_NOT_CONFIGURED = "仅保存在本机 · 尚未配置完整连接"
    const val PAUSED = "已暂停全部发送 · 本机继续保存"
    val obsoleteMessages = listOf(NOT_CONFIGURED, WORKER_NOT_CONFIGURED, PAUSED)

    private fun obsolete(status: StoredSyncStatus, matches: (String, String) -> Boolean) =
        when (status.state) {
            "unconfigured" -> matches(NOT_CONFIGURED, status.message) || matches(WORKER_NOT_CONFIGURED, status.message)
            "paused" -> matches(PAUSED, status.message)
            else -> false
        }

    fun visible(config: CollectorConfig, status: StoredSyncStatus, waitingReason: String?,
        inventory: QueueInventory?, sourceIssues: Int?, totalPending: Int?, inventoryUnavailable: Boolean = false, sourceUnavailable: Boolean = false,
        labelsReady: Boolean = true, labelsFailed: Boolean = false, matches: (String, String) -> Boolean): VisibleSyncStatus {
        val connected = config.hasSyncConnection()
        val parts = mutableListOf<VisibleSyncStatus>()
        if (!connected) parts += VisibleSyncStatus.Disconnected
        if (waitingReason != null) parts += VisibleSyncStatus.Message(waitingReason)
        if (inventoryUnavailable) parts += VisibleSyncStatus.Unavailable
        else if (inventory != null && inventory.blocked > 0) parts += if (totalPending != null) VisibleSyncStatus.NeedsAttention(inventory.blocked, totalPending) else VisibleSyncStatus.Message(MoteI18n.text("部分记录需要处理"))
        if (sourceUnavailable) parts += VisibleSyncStatus.SourceUnavailable
        else if (sourceIssues != null && sourceIssues > 0) parts += if (totalPending != null) VisibleSyncStatus.NeedsSourceAttention(sourceIssues, totalPending) else VisibleSyncStatus.Message(MoteI18n.text("来源需要处理"))
        if ((!inventoryUnavailable && inventory == null) || (!sourceUnavailable && sourceIssues == null) || (!inventoryUnavailable && !sourceUnavailable && totalPending == null)) parts += VisibleSyncStatus.Loading
        val ambiguous = status.state in setOf("unconfigured", "paused") && !labelsReady
        if (ambiguous) {
            if (labelsFailed) { parts += VisibleSyncStatus.Unavailable; parts += VisibleSyncStatus.Message(status.message) }
            else parts += VisibleSyncStatus.Loading
        } else if (!obsolete(status, matches)) {
            if (status.message != waitingReason) parts += VisibleSyncStatus.Message(status.message)
        } else if (config.syncPaused) {
            if (waitingReason == null) parts += VisibleSyncStatus.Message(MoteI18n.text(PAUSED))
        } else if (parts.isEmpty()) parts += VisibleSyncStatus.SendAsConfigured
        val distinct = parts.distinct()
        return if (distinct.size == 1) distinct.single() else VisibleSyncStatus.Many(distinct)
    }

    fun heartbeatState(config: CollectorConfig, status: StoredSyncStatus, blocked: Int, pending: PendingSync, sourceIssues: Int?,
        matches: (String, String) -> Boolean): String {
        if (blocked > 0 || sourceIssues == null || sourceIssues > 0 || status.state == "error") return "error"
        if (config.syncPaused) return status.state
        if (!obsolete(status, matches)) return status.state
        if (!config.hasSyncConnection()) return "unconfigured"
        return if (pending.hasWork) "waiting" else "idle"
    }

    fun text(status: VisibleSyncStatus): String = when (status) {
        is VisibleSyncStatus.Message -> status.text
        VisibleSyncStatus.Loading -> MoteI18n.text("正在读取本机同步状态…")
        VisibleSyncStatus.Unavailable -> MoteI18n.text("本机状态暂不可读取")
        VisibleSyncStatus.SourceUnavailable -> MoteI18n.text("来源需要处理") + " · " + MoteI18n.text("本机状态暂不可读取")
        VisibleSyncStatus.Disconnected -> MoteI18n.text("未连接中央")
        VisibleSyncStatus.SendAsConfigured -> MoteI18n.text("按设置发送")
        is VisibleSyncStatus.NeedsAttention -> MoteI18n.text("{0} 条记录需要处理（冲突或中央不可用） · 待发 {1} 条；请打开同步与恢复", status.blocked, status.pending)
        is VisibleSyncStatus.NeedsSourceAttention -> MoteI18n.text("{0} 个来源同步需要处理 · 待发 {1} 条；请在来源页面检查上传授权、权限或连接", status.sources, status.pending)
        is VisibleSyncStatus.Many -> status.items.joinToString("\n") { text(it) }
    }
}
