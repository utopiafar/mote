package dev.mote.collector

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Explicit, process-owned work: navigation and rotation never restart a migration. */
internal object LocalContentDecryptor {
    data class Snapshot(
        val running: Boolean = false,
        val message: String = MoteI18n.text("关闭内容加密并保存后，可一次性解密已有本地数据。"),
        val checked: Int = 0,
        val total: Int = 0,
        val migrated: Int = 0
    )
    @Volatile var snapshot = Snapshot(); private set
    private val executor = Executors.newSingleThreadExecutor()
    private var cancellation = AtomicBoolean(false)

    @Synchronized fun start(context: Context): Boolean {
        val app = context.applicationContext
        val preferences = app.getSharedPreferences("mote", Context.MODE_PRIVATE)
        if (snapshot.running || preferences.getBoolean("contentEncryptionEnabled", false)) return false
        val stop = AtomicBoolean(false); cancellation = stop
        snapshot = Snapshot(running = true, message = MoteI18n.text("正在准备批量解密…"))
        executor.execute {
            var migrated = 0
            val failures = mutableListOf<String>()
            fun shouldStop() = stop.get() || preferences.getBoolean("contentEncryptionEnabled", false)
            val tasks = listOf<Pair<String, ((Int, Int) -> Unit) -> Int>>(
                MoteI18n.text("采集图片与记录") to { progress -> app.queue().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("待决定区") to { progress -> BulkDedupeStore(app).quarantine().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("去重扫描结果") to { progress -> BulkDedupeStore(app).migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("随手记草稿") to { progress -> QuickNotes.draft(app).migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("来源记录") to { progress -> app.localSources().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("来源文件") to { progress -> app.fileArchives().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                MoteI18n.text("图片对比诊断") to { progress -> app.imageDedupeDiagnostics().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) }
            )
            for ((index, task) in tasks.withIndex()) {
                if (shouldStop()) break
                val (label, migrate) = task
                snapshot = Snapshot(true, MoteI18n.text("正在解密：{0} · 区域 {1}/{2}", label, index + 1, tasks.size), migrated = migrated)
                runCatching {
                    migrated += migrate { checked, total ->
                        snapshot = Snapshot(true, MoteI18n.text("{0}：{1} · {2}/{3} 个文件 · 区域 {4}/{5}", if (stop.get()) MoteI18n.text("正在取消") else MoteI18n.text("正在解密"), label, checked, total, index + 1, tasks.size), checked, total, migrated)
                    }
                }.onFailure {
                    failures += label
                    SupportEvents.record(app, EventStage.QUEUE, EventCode.STORAGE)
                }
            }
            val cancelled = shouldStop()
            val count = if (failures.isEmpty()) "$migrated" else MoteI18n.text("至少 {0}", migrated)
            val result = if (cancelled) MoteI18n.text("已取消 · 已解密 {0} 个文件；其余文件保持原样，可再次运行。", count)
                else if (failures.isEmpty()) MoteI18n.text("批量解密完成 · 已解密 {0} 个文件。", count)
                else MoteI18n.text("批量解密结束 · 已解密 {0} 个文件。", count)
            snapshot = Snapshot(message = result + if (failures.isEmpty()) "" else MoteI18n.text("\n{0}未完成，原文件已保留，可重试。", failures.joinToString("、")), migrated = migrated)
            LocalStateChanges.changed(records = true, immediate = true)
        }
        return true
    }

    @Synchronized fun cancel() {
        if (!snapshot.running) return
        cancellation.set(true)
        snapshot = snapshot.copy(message = MoteI18n.text("正在取消，当前文件完成后停止…"))
    }
}
