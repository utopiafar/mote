package dev.mote.collector

import android.content.Context

/** Completion describes retained exceptions as well as runnable work, across both upload lanes. */
internal object SyncHealth {
    fun finish(context: Context) {
        if (UploadHistoryRecovery.unavailable) { Settings(context).syncStatus("error", UploadHistoryRecovery.message()); return }
        val inventory = context.queue().syncInventory()
        val pending = SyncSchedule.pending(context)
        val blocked = inventory.getInt("blocked")
        val sourceErrors = sourceAttentionCount(context)
        val state: String
        val message: String
        when {
            blocked > 0 -> { state = "error"; message = MoteI18n.text("{0} 条待处理 · 待发 {1} 条", blocked, pending.count) }
            sourceErrors > 0 -> { state = "error"; message = MoteI18n.text("{0} 个来源待处理 · 待发 {1}", sourceErrors, pending.count) }
            pending.hasWork -> { state = "waiting"; message = MoteI18n.text("{0} 条待发 · {1} 项来源待确认", pending.count, pending.pendingUpdates) }
            else -> { state = "idle"; message = MoteI18n.text("当前待发记录已获中央确认；这不表示两端保留数量相同") }
        }
        Settings(context).syncStatus(state, message)
    }
    internal fun sourceAttentionCount(context: Context): Int =
        sourceAttentionCount(context.localSources()) { source -> context.fileArchives().pendingCount(source.id) }

    internal fun sourceAttentionCount(sources: LocalSourceStore, filePending: (LocalSource) -> Int): Int =
        sources.sources().count { source ->
            if (!source.enabled) return@count false
            val metadata = sources.state(source.id)
            val pendingVersions = if (source.binaryFiles()) filePending(source) else metadata.optJSONArray("pending")?.length() ?: 0
            sourceRequiresAttention(source, metadata, pendingVersions)
        }
    internal fun sourceRequiresAttention(source: LocalSource, metadata: org.json.JSONObject, pendingVersions: Int): Boolean {
        if (!source.enabled) return false
        if (source.kind == "local-files" && source.retention == "snapshot" && !source.centralProcessingConsent) return true
        return (pendingVersions > 0 || source.contextDirty || !metadata.optBoolean("registered")) && metadata.optString("status") in
            setOf("offline", "permission", "configuration", "storage", "provider", "http", "ack", "paused", "consent", "context-conflict", "context-http")
    }

}
