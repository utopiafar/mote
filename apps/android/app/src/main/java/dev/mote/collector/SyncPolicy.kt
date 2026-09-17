package dev.mote.collector

/** Timing and explicit user preferences only; never interprets captured content. */
data class SyncPolicy(val mode: String = "realtime", val intervalMinutes: Int = 15, val batchSize: Int = 20) {
    fun validate() {
        require(mode in setOf("realtime", "interval", "batch", "manual")) { MoteI18n.text("请选择有效同步方式") }
        require(intervalMinutes in 15..1440) { MoteI18n.text("同步间隔为 15..1440 分钟") }
        require(batchSize in 1..500) { MoteI18n.text("批量同步数量为 1..500 条") }
    }
    fun delayMillis(now: Long, pending: Int, oldestAt: Long?, lastDispatch: Long, explicit: Boolean = false, pendingUpdates: Int = 0): Long? {
        validate()
        if (explicit) return 0
        if (pending == 0 && pendingUpdates == 0) return null
        val interval = intervalMinutes * 60_000L
        return when (mode) {
            "manual" -> null
            "realtime" -> 0
            "batch" -> when { pending >= batchSize -> 0; pending == 0 && pendingUpdates == 0 -> null; else -> ((oldestAt ?: now) + interval - now).coerceAtLeast(0) }
            else -> ((if (lastDispatch > 0) lastDispatch else oldestAt ?: now) + interval - now).coerceAtLeast(0)
        }
    }
}

data class PendingSync(val count: Int, val oldestAt: Long?, val pendingUpdates: Int = 0) {
    val hasWork get() = count > 0 || pendingUpdates > 0
}
