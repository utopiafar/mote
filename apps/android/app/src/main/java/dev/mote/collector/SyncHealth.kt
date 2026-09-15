package dev.mote.collector

import android.content.Context

/** Completion describes retained exceptions as well as runnable work, across both upload lanes. */
internal object SyncHealth {
    fun finish(context: Context) {
        val inventory = context.queue().syncInventory()
        val pending = SyncSchedule.pending(context)
        val blocked = inventory.getInt("blocked")
        val awaiting = inventory.getInt("awaitingOcr")
        val sources = context.localSources()
        val sourceErrors = sources.sources().count { source ->
            val state = sources.state(source.id)
            ((state.optJSONArray("pending")?.length() ?: 0) > 0 || !state.optBoolean("registered")) && state.optString("status") in setOf("offline", "permission", "configuration", "storage", "provider", "http", "ack", "paused")
        }
        val state: String
        val message: String
        when {
            blocked > 0 -> { state = "error"; message = "$blocked 条记录需要处理（冲突或中央不可用） · 待发 ${pending.count} 条；请打开同步与恢复" }
            sourceErrors > 0 -> { state = "error"; message = "$sourceErrors 个来源同步需要处理 · 待发 ${pending.count} 条；请在来源页面检查权限或连接" }
            pending.hasWork -> { state = "waiting"; message = "仍有 ${pending.count} 条待发及 ${pending.pendingUpdates} 项来源设置待确认；暂停或权限不可用的来源需恢复后同步" }
            awaiting > 0 -> { state = "idle"; message = "当前待发已确认 · $awaiting 张图片等待本机 OCR，完成后继续同步" }
            else -> { state = "idle"; message = "当前待发记录已获中央确认；这不表示两端保留数量相同" }
        }
        Settings(context).syncStatus(state, message)
    }
}
