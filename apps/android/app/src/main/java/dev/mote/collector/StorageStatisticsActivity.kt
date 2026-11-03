package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.StorageBackupPlugin
import dev.mote.collector.plugins.StorageReport
import java.time.Instant

/** Renders the storage plugin's statistics scan; this Activity only requests
 * the report and lays out the returned facts. */
class StorageStatisticsActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private val owner get() = StorageBackupPlugin.owner(this)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(title = MoteI18n.text("本机统计"))
        SecondaryUi.text(body, MoteI18n.text("本机存量与累计观测"), muted = true)
        val result = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(result)
        val refresh = Button(this).apply { text = MoteI18n.text("刷新统计"); tag = "statistics-refresh" }; body.addView(refresh, LinearLayout.LayoutParams(-2, -2))
        fun load() {
            refresh.isEnabled = false
            owner.statistics { report ->
                if (isFinishing || isDestroyed) return@statistics
                refresh.isEnabled = true; result.removeAllViews()
                report.onSuccess { value -> render(result, value) }
                    .onFailure { result.addView(TextView(this).apply { text = MoteI18n.text("统计读取失败，请重试。") }) }
                MoteUi.styleTree(body)
            }
        }
        refresh.setOnClickListener { load() }; load()
    }
    private fun render(result: LinearLayout, value: StorageReport) {
        val facts = SecondaryUi.column(result)
        SecondaryUi.fact(facts, MoteI18n.text("本机记录"), MoteI18n.text("{0} 条", value.inventory.records))
        SecondaryUi.fact(facts, MoteI18n.text("待发送"), MoteI18n.text("{0} 条", value.inventory.pending))
        SecondaryUi.fact(facts, MoteI18n.text("图片"), "%.2f MiB".format((value.types["image"] ?: 0L) / 1048576.0))
        SecondaryUi.fact(facts, MoteI18n.text("其他文件"), "%.2f MiB".format((value.total - (value.types["image"] ?: 0L)) / 1048576.0))
        val counts = value.ledger?.optJSONObject("counts")
        val saved = counts?.let { c -> listOf("SCREEN_QUEUED", "NOTE_QUEUED", "ACTIVITY_QUEUED", "MEDIA_QUEUED", "SYSTEM_EVENT_QUEUED", "PAGE_QUEUED").sumOf(c::optLong) }
        SecondaryUi.fact(facts, MoteI18n.text("本周期累计保存"), saved?.let { MoteI18n.text("{0} 条", it) } ?: MoteI18n.text("累计统计暂不可读取"))
        // FRAME_BLOCKED also includes window/state changes; it is not a privacy-only count.
        SecondaryUi.fact(facts, MoteI18n.text("隐私拦截"), MoteI18n.text("未单独统计"))
        val boundary = SecondaryUi.disclosure(result, MoteI18n.text("计数边界"), "statistics-scope")
        SecondaryUi.text(boundary, MoteI18n.text("累计保存、当前本机存量、请求上传和 Central 接收是不同事实。空间按现有文件统计，不代表每日新增量。"), muted = true)
        SecondaryUi.text(boundary, MoteI18n.text("当前磁盘占用，按文件类型和最后修改日期（UTC）汇总。共享文件只计一次；日期分布不是每日新增量。"), muted = true)
        value.ledger?.let { SecondaryUi.text(boundary, MoteI18n.text("起算：{0}\n", Instant.ofEpochMilli(it.getLong("epochAtMs"))), muted = true) }
        SecondaryUi.row(result, MoteI18n.text("采集与存储详情"), MoteI18n.text("查看累计结果、队列与使用空间")) { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
        val storage = SecondaryUi.disclosure(result, MoteI18n.text("磁盘占用详情"), "statistics-disk")
        SecondaryUi.text(storage, value.summary, heading = true)
        for ((title, rows) in listOf(MoteI18n.text("按文件类型") to value.types, MoteI18n.text("按日期") to value.days)) {
            storage.addView(TextView(this).apply { text = title; MoteUi.type(this, NativeFontRole.SECTION, medium = true); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, moteDp(MoteTheme.spaceItem), 0, moteDp(MoteTheme.spaceInline)) }); val maximum = rows.values.maxOrNull()?.coerceAtLeast(1L) ?: 1L
            for ((label, bytes) in rows) { storage.addView(TextView(this).apply { text = "$label · ${"%.2f".format(bytes / 1048576.0)} MiB" }); storage.addView(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; progress = (bytes.toDouble() / maximum * 1000).toInt() }) }
        }
    }
}
