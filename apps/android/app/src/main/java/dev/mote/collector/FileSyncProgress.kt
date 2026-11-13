package dev.mote.collector

import org.json.JSONObject

internal enum class FileSyncPhase { STABILITY, QUEUED, PREPARING, UPLOADING, RETRY, BLOCKED, RECEIVED, BASELINE }

/** Only transport facts. A receipt applies to the current candidate, never an older version. */
internal data class FileSyncEntry(
    val key: String, val observedAt: String, val received: Boolean, val baseline: Boolean, val saved: Boolean,
    val stableAt: Long, val retry: Boolean, val blocked: Boolean
) {
    fun phase(now: Long, active: FileSyncTransfer? = null): FileSyncPhase = when {
        received -> FileSyncPhase.RECEIVED
        baseline -> FileSyncPhase.BASELINE
        active?.key == key -> active.phase
        blocked -> FileSyncPhase.BLOCKED
        retry -> FileSyncPhase.RETRY
        !saved && now < stableAt -> FileSyncPhase.STABILITY
        else -> FileSyncPhase.QUEUED
    }
    companion object {
        fun from(row: JSONObject, immediate: Boolean = false): FileSyncEntry {
            val item = row.getJSONObject("candidate")
            val saved = row.has("pending")
            val received = !saved && !row.optBoolean("recheck") && row.optString("revision").isNotBlank() && row.optString("signature") == SourceRules.fileSignature(item)
            return FileSyncEntry(SourceRules.hash(item.getString("externalId")), item.optString("observedAt"), received, row.optBoolean("baseline"), saved,
                if (immediate || item.optString("layer") == "reference" || item.optBoolean("deleted")) 0 else row.optLong("stableSince", System.currentTimeMillis()) + 60_000,
                row.has("syncFailure") || row.has("nextPrepareAt"), row.optJSONObject("syncFailure")?.optBoolean("blocked") == true)
        }
    }
}

internal data class FileSyncTransfer(val key: String, val phase: FileSyncPhase)

/** A live attempt is deliberately process-local. Restarted/persisted pending work is queued. */
internal object FileSyncTransfers {
    private data class Attempt(val owner: Any, val transfer: FileSyncTransfer)
    private val active = mutableMapOf<String, Attempt>()
    @Synchronized fun get(source: String): FileSyncTransfer? = active[source]?.transfer
    @Synchronized fun set(source: String, owner: Any, transfer: FileSyncTransfer) { active[source] = Attempt(owner, transfer) }
    @Synchronized fun clear(source: String, owner: Any) { if (active[source]?.owner === owner) active.remove(source) }
}

internal data class FileSyncProgress(val counts: Map<FileSyncPhase, Int>, val scanComplete: Boolean) {
    fun count(phase: FileSyncPhase) = counts[phase] ?: 0
    val total get() = counts.values.sum() - count(FileSyncPhase.BASELINE)
    val received get() = count(FileSyncPhase.RECEIVED)
    fun summary(): String {
        val progress = when {
            total > 0 -> MoteI18n.text("文件夹进度：中央已接收 {0}/{1} 个当前版本（{2}%）", received, total, received * 100 / total)
            scanComplete -> MoteI18n.text("文件夹进度：当前没有需要发送的文件版本")
            else -> MoteI18n.text("文件夹进度：正在清点文件")
        }
        val stages = MoteI18n.text("等待稳定 {0} · 排队 {1} · 正在保存 {2} · 正在上传 {3} · 失败重试 {4} · 需处理 {5}",
            count(FileSyncPhase.STABILITY), count(FileSyncPhase.QUEUED), count(FileSyncPhase.PREPARING), count(FileSyncPhase.UPLOADING), count(FileSyncPhase.RETRY), count(FileSyncPhase.BLOCKED))
        return listOf(progress, stages,
            if (!scanComplete) MoteI18n.text("扫描尚未完成，总数会继续更新") else "",
            if (count(FileSyncPhase.BASELINE) > 0) MoteI18n.text("首次仅清点、不发送：{0} 个文件", count(FileSyncPhase.BASELINE)) else "",
            MoteI18n.text("接收进度不代表中央整理或索引已完成")).filter { it.isNotBlank() }.joinToString("\n")
    }
}
