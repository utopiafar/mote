package dev.mote.collector

import android.content.Context
import org.json.JSONObject

/** Local receipts describe transport; central processing facts are separately reported. */
internal object LocalContentPresentation {
    fun fileStatus(row: JSONObject, now: Long = System.currentTimeMillis()): String {
        val entry = FileSyncEntry.from(row, row.optBoolean("syncImmediately"))
        val active = row.optString("syncPhase").takeIf { it in setOf("PREPARING", "UPLOADING") }?.let { FileSyncTransfer(entry.key, FileSyncPhase.valueOf(it)) }
        val failure = row.optJSONObject("syncFailure")
        val status = when (entry.phase(now, active)) {
            FileSyncPhase.RECEIVED -> if (currentReceipt(row) != null) MoteI18n.text("中央已收到 · 整理状态请打开内容查看") else MoteI18n.text("已确认发送 · 中央详情待核对")
            FileSyncPhase.BASELINE -> MoteI18n.text("首次仅清点 · 不在发送范围内")
            FileSyncPhase.STABILITY -> MoteI18n.text("等待文件稳定 · 至少还需 {0} 秒", ((entry.stableAt - now + 999) / 1000).coerceAtLeast(1))
            FileSyncPhase.QUEUED -> if (row.has("pending")) MoteI18n.text("本机已保存 · 排队等待上传或续传") else MoteI18n.text("已清点 · 排队等待保存与上传")
            FileSyncPhase.PREPARING -> MoteI18n.text("正在保存文件 · 保存后上传")
            FileSyncPhase.UPLOADING -> MoteI18n.text("正在上传 · 等待中央确认")
            FileSyncPhase.RETRY -> if (failure?.optString("phase") == "prepare" || row.has("nextPrepareAt")) MoteI18n.text("保存失败 · 等待重试") else MoteI18n.text("上传失败 · 等待重试")
            FileSyncPhase.BLOCKED -> MoteI18n.text("发送失败 · 需要处理后重试")
        }
        return status + if (failure != null && !failure.isNull("httpStatus") && entry.phase(now, active) in setOf(FileSyncPhase.RETRY, FileSyncPhase.BLOCKED)) MoteI18n.text("（HTTP {0}）", failure.getInt("httpStatus")) else ""
    }
    fun folderStatus(context: Context, source: LocalSource): String {
        val queue = context.fileArchives()
        val progress = queue.progress(source)
        val config = Settings(context).read()
        val state = context.localSources().state(source.id)
        val transferring = progress.count(FileSyncPhase.UPLOADING) + progress.count(FileSyncPhase.PREPARING) > 0
        val issue = if (transferring) "" else when (state.optString("status")) {
            "permission", "provider", "consent", "offline", "ack", "http" -> sourceStatus(source, state)
            "paused" -> MoteI18n.text("中央已暂停；请在中央恢复后重试")
            "context-conflict" -> MoteI18n.text("资料说明与中央版本冲突；请打开设置处理，文件保留待发。")
            "context-http" -> MoteI18n.text("资料说明尚未获中央确认；请检查连接或升级中央，文件保留待发。")
            else -> ""
        }
        val waiting = when {
            !source.enabled -> MoteI18n.text("此来源已暂停")
            !config.hasSyncConnection() -> MoteI18n.text("仅保存在本机 · 连接节点后可同步")
            else -> SyncSchedule.waitingReason(context, config) ?: when (config.syncMode) {
                "manual" -> if (progress.count(FileSyncPhase.UPLOADING) + progress.count(FileSyncPhase.PREPARING) == 0) MoteI18n.text("手动同步 · 点击立即同步发送或重试") else ""
                "interval", "batch" -> if (progress.count(FileSyncPhase.UPLOADING) + progress.count(FileSyncPhase.PREPARING) == 0) MoteI18n.text("排队文件遵守当前定时或批量同步设置") else ""
                else -> ""
            }
        }
        return listOf(progress.summary(), issue, if (progress.received < progress.total || !source.enabled || config.syncPaused) waiting else "").filter { it.isNotBlank() }.joinToString("\n")
    }
    fun currentReceipt(row: JSONObject): String? = row.optString("captureId").takeIf {
        !row.has("pending") && !row.optBoolean("recheck") && row.optJSONObject("candidate")?.let { candidate -> row.optString("signature") == SourceRules.fileSignature(candidate) } == true
    }?.takeIf { it.isNotBlank() }
    fun sourceStatus(source: LocalSource, state: JSONObject): String = when {
        !source.enabled -> MoteI18n.text("此来源已暂停")
        state.optBoolean("fileTransferring") -> MoteI18n.text("正在同步来源记录")
        state.optString("status") == "permission" -> MoteI18n.text("需要重新授权 · 点击修复这个来源")
        state.optString("status") == "provider" -> MoteI18n.text("暂时无法读取 · 已保存内容保留")
        state.optString("status") == "consent" -> MoteI18n.text("需要确认完整文件的发送范围")
        state.optString("status") == "offline" -> MoteI18n.text("等待中央恢复 · 本机内容保留")
        state.optString("status") in setOf("ack", "http") -> MoteI18n.text("中央尚未确认 · 待发版本保留")
        state.optString("status") == "synced" -> MoteI18n.text("中央已接收 · 整理状态在内容详情查看")
        else -> MoteI18n.text("持续同步 · 最近扫描 {0}", state.optString("lastScan").ifBlank { MoteI18n.text("尚无") })
    }
    fun centralStatus(file: JSONObject?, material: JSONObject?): String {
        val indexing = material?.optJSONObject("indexing")?.optString("state")
        val coverage = material?.optJSONObject("coverage")?.optString("state")
        return when {
            indexing == "indexed" && material?.optJSONObject("indexing")?.optString("revision") == material?.optString("revision") && coverage == "complete" -> MoteI18n.text("资料已完整整理并建立索引")
            indexing == "indexed" && material?.optJSONObject("indexing")?.optString("revision") == material?.optString("revision") && coverage == "partial" -> MoteI18n.text("资料已部分整理并建立索引")
            indexing == "failed" -> MoteI18n.text("建立索引失败 · 原始依据保留")
            indexing == "disabled" -> MoteI18n.text("未安排建立索引 · 原始依据保留")
            indexing in setOf("pending", "running") -> MoteI18n.text("正在建立资料索引")
            file?.optJSONObject("job")?.optString("state") in setOf("failed", "blocked", "cancelled") -> MoteI18n.text("整理需要处理 · 已接收的内容保留")
            file?.optJSONObject("job")?.optString("state") in setOf("waiting", "running") -> MoteI18n.text("中央已收到 · 正在整理")
            else -> MoteI18n.text("中央已收到 · 可搜索状态尚未确认")
        }
    }
}

internal fun Context.localFileContents(limit: Int): List<JSONObject> = localSources().sources()
    .filter { it.binaryFiles() }
    .flatMap { source -> fileArchives().let { queue -> queue.recentRows(source, limit).map { row -> row.put("sourceId", source.id).put("sourceName", source.name).put("syncContinuously", source.syncContinuously) } } }
    .sortedByDescending { it.getJSONObject("candidate").optString("observedAt") }
    .take(limit)
