package dev.mote.collector

import android.content.Context

/** A target string returning to A does not revive a request started before A→B→A. */
internal class ConnectionLease(private val context: Context, private val config: CollectorConfig) {
    private val settings = Settings(context)
    val generation = settings.connectionGeneration()
    private val target = SourceRules.target(config.server, config.token)
    fun current(): Boolean = !ConnectionGuard.reconfiguring() && settings.connectionGeneration() == generation && settings.read().let {
        it.hasSyncConnection() && !it.syncPaused && SourceRules.target(it.server, it.token) == target
    }
    fun requireCurrent() {
        check(current()) { MoteI18n.text("目标或原件已变化，已保留上传确认，请稍后重试。") }
        SyncSchedule.requireConditions(context, settings.read())
    }
    fun commit(action: () -> Unit) = synchronized(Settings::class.java) { requireCurrent(); action() }
}
