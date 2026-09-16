package dev.mote.collector

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Explicit, process-owned work: navigation and rotation never restart a migration. */
internal object LocalContentDecryptor {
    data class Snapshot(
        val running: Boolean = false,
        val message: String = "关闭内容加密并保存后，可一次性解密已有本地数据。",
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
        snapshot = Snapshot(running = true, message = "正在准备批量解密…")
        executor.execute {
            var migrated = 0
            val failures = mutableListOf<String>()
            fun shouldStop() = stop.get() || preferences.getBoolean("contentEncryptionEnabled", false)
            val tasks = listOf<Pair<String, ((Int, Int) -> Unit) -> Int>>(
                "采集图片与记录" to { progress -> app.queue().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "待决定区" to { progress -> BulkDedupeStore(app).quarantine().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "去重扫描结果" to { progress -> BulkDedupeStore(app).migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "随手记草稿" to { progress -> QuickNotes.draft(app).migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "来源记录" to { progress -> app.localSources().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "来源文件" to { progress -> app.fileArchives().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) },
                "图片对比诊断" to { progress -> app.imageDedupeDiagnostics().migrateLegacyContent(shouldStop = ::shouldStop, onProgress = progress) }
            )
            for ((index, task) in tasks.withIndex()) {
                if (shouldStop()) break
                val (label, migrate) = task
                snapshot = Snapshot(true, "正在解密：$label · 区域 ${index + 1}/${tasks.size}", migrated = migrated)
                runCatching {
                    migrated += migrate { checked, total ->
                        snapshot = Snapshot(true, "${if (stop.get()) "正在取消" else "正在解密"}：$label · $checked/$total 个文件 · 区域 ${index + 1}/${tasks.size}", checked, total, migrated)
                    }
                }.onFailure {
                    failures += label
                    SupportEvents.record(app, EventStage.QUEUE, EventCode.STORAGE)
                }
            }
            val cancelled = shouldStop()
            val count = if (failures.isEmpty()) "$migrated" else "至少 $migrated"
            val result = if (cancelled) "已取消 · 已解密 $count 个文件；其余文件保持原样，可再次运行。"
                else if (failures.isEmpty()) "批量解密完成 · 已解密 $count 个文件。"
                else "批量解密结束 · 已解密 $count 个文件。"
            snapshot = Snapshot(message = result + if (failures.isEmpty()) "" else "\n${failures.joinToString("、")}未完成，原文件已保留，可重试。", migrated = migrated)
            LocalStateChanges.changed(records = true, immediate = true)
        }
        return true
    }

    @Synchronized fun cancel() {
        if (!snapshot.running) return
        cancellation.set(true)
        snapshot = snapshot.copy(message = "正在取消，当前文件完成后停止…")
    }
}
