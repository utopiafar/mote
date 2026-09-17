package dev.mote.collector

import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.Executors

class StorageStatisticsActivity : MoteActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var body: LinearLayout
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(); body.addView(TextView(this).apply { text = MoteI18n.text("统计中心"); textSize = 27f })
        body.addView(TextView(this).apply { text = MoteI18n.text("当前磁盘占用，按文件类型和最后修改日期（UTC）汇总。共享文件只计一次；日期分布不是每日新增量。") })
        val result = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(result)
        val refresh = Button(this).apply { text = MoteI18n.text("刷新") }; body.addView(refresh)
        fun load() { refresh.isEnabled = false
            worker.execute {
                val report = runCatching {
                    val seen = mutableSetOf<String>(); val types = sortedMapOf<String, Long>(); val days = sortedMapOf<String, Long>(); var total = 0L; var count = 0; var skipped = 0
                    fun visit(file: File) {
                        try { val path = file.absolutePath; if (!seen.add(path)) return; if (file.canonicalPath != path) { skipped++; return }
                            if (file.isDirectory) { val children = file.listFiles(); if (children == null) skipped++ else children.forEach(::visit) }
                            else if (file.isFile) { val size = file.length(); total += size; count++; val day = Instant.ofEpochMilli(file.lastModified()).atZone(ZoneOffset.UTC).toLocalDate().toString(); days[day] = (days[day] ?: 0L) + size
                                val kind = when(file.extension) { "blob" -> "image"; "event", "enc", "json", "ndjson" -> "json"; "gguf", "bin", "onnx" -> "model"; "db", "sqlite" -> "database"; else -> file.extension.ifBlank { "other" } }; types[kind] = (types[kind] ?: 0L) + size }
                        } catch (_: Exception) { skipped++ }
                    }
                    listOf(File(applicationInfo.dataDir).canonicalFile, File(QueueStorage(this).current().path).canonicalFile).forEach(::visit)
                    Triple("${"%.2f".format(total / 1048576.0)} MiB · $count ${MoteI18n.text("文件")}" + if (skipped > 0) "\n" + MoteI18n.text("部分文件无法读取，统计可能不完整。") else "", types, days)
                }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    refresh.isEnabled = true; result.removeAllViews()
                    report.onSuccess { (summary, types, days) ->
                        result.addView(TextView(this).apply { text = summary; textSize = 20f })
                        for ((title, rows) in listOf(MoteI18n.text("按文件类型") to types, MoteI18n.text("按日期") to days)) {
                            result.addView(TextView(this).apply { text = title; textSize = 20f }); val maximum = rows.values.maxOrNull()?.coerceAtLeast(1L) ?: 1L
                            for ((label, bytes) in rows) { result.addView(TextView(this).apply { text = "$label · ${"%.2f".format(bytes / 1048576.0)} MiB" }); result.addView(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; progress = (bytes.toDouble() / maximum * 1000).toInt() }) }
                        }
                    }.onFailure { result.addView(TextView(this).apply { text = MoteI18n.text("统计读取失败，请重试。") }) }
                    MoteUi.styleTree(body)
                }
            }
        }
        refresh.setOnClickListener { load() }; load()
    }
    override fun onDestroy() { worker.shutdownNow(); super.onDestroy() }
}
