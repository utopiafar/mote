package dev.mote.collector

import android.content.Context
import org.json.JSONObject

/** Local receipts describe transport; central processing facts are separately reported. */
internal object LocalContentPresentation {
    fun fileStatus(row: JSONObject): String = when {
        row.has("pending") -> MoteI18n.text("本机已保存 · 等待中央接收")
        currentReceipt(row) != null -> MoteI18n.text("中央已收到 · 整理状态请打开内容查看")
        row.optJSONObject("candidate")?.let { SourceRules.fileSignature(it) != row.optString("signature") } == true -> MoteI18n.text("本机已清点 · 正在准备保存")
        row.optString("revision").isNotBlank() -> MoteI18n.text("已确认发送 · 中央详情待核对")
        else -> MoteI18n.text("本机已清点 · 正在准备保存")
    }
    fun currentReceipt(row: JSONObject): String? = row.optString("captureId").takeIf {
        !row.has("pending") && row.optJSONObject("candidate")?.let { candidate -> row.optString("signature") == SourceRules.fileSignature(candidate) } == true
    }?.takeIf { it.isNotBlank() }
    fun sourceStatus(source: LocalSource, state: JSONObject): String = when {
        !source.enabled -> MoteI18n.text("此来源已暂停")
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
    .flatMap { source -> fileArchives().rows(source.id).map { row -> JSONObject(row.toString()).put("sourceId", source.id).put("sourceName", source.name).put("syncContinuously", source.syncContinuously) } }
    .sortedByDescending { it.getJSONObject("candidate").optString("observedAt") }
    .take(limit)
