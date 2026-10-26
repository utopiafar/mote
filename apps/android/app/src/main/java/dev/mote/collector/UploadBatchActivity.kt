package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*

class UploadBatchActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage(primary = MotePrimaryTab.SOURCES, title = MoteI18n.text("上传批次详情"))
        val status = TextView(this).also(body::addView)
        val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        fun load() { task.start(MoteI18n.text("正在读取…"), { status.text = it }, { UploadHistoryModel.read(applicationContext).singleOrNull { it.id == intent.getStringExtra("batchId") } }) { result ->
            rows.removeAllViews()
            result.onSuccess { batch ->
                if (batch == null) { status.text = MoteI18n.text("该批次不在当前节点保留的历史中。"); return@onSuccess }
                status.text = MoteI18n.text("已确认 {0} · 未确认 {1}", batch.received, batch.unconfirmed)
                batch.items.forEach { item -> rows.addView(MoteUi.button(Button(this).apply {
                    text = MoteI18n.text("查看原件") + " · " + if (item.received) MoteI18n.text("已确认") else MoteI18n.text("未确认")
                    tag = "history-original-${item.captureId}"
                    setOnClickListener {
                        val destination = if (item.identity == null) Intent(this@UploadBatchActivity, CaptureRecordsActivity::class.java).putExtra("recordId", item.captureId).putExtra("historyOriginalVersion", item.originalVersion)
                        else Intent(this@UploadBatchActivity, UploadOriginalActivity::class.java).putExtra("batchId", batch.id).putExtra("itemKey", item.key)
                        startActivity(destination)
                    }
                })) }
                batch.attempts.forEach { attempt -> rows.addView(TextView(this).apply {
                    text = java.time.Instant.ofEpochMilli(attempt.startedAt).toString() + "\n" +
                        when (attempt.state) { "received" -> MoteI18n.text("已确认"); "partial" -> MoteI18n.text("部分确认"); "cancelled" -> MoteI18n.text("已取消"); "rejected" -> MoteI18n.text("请求被拒绝"); "sending" -> MoteI18n.text("发送中"); else -> MoteI18n.text("未确认") } +
                        " · HTTP " + (attempt.status.takeIf { it > 0 }?.toString() ?: "—") + "\n" + MoteI18n.text("请求体字节：{0}", attempt.bodyBytes)
                }) }
                batch.itemAttempts.forEach { attempt -> rows.addView(TextView(this).apply {
                    val kind = when(attempt.identity.kind) { "file" -> MoteI18n.text("文件"); "attachment" -> MoteI18n.text("附件"); else -> MoteI18n.text("来源记录") }
                    val phase = when(attempt.phase) { "part" -> MoteI18n.text("文件块"); "commit" -> MoteI18n.text("完成确认"); "manifest" -> MoteI18n.text("文件清单"); else -> MoteI18n.text("来源记录") }
                    val state = when(attempt.state) { "received" -> MoteI18n.text("已确认"); "transferred" -> MoteI18n.text("请求已完成，等待原件确认"); "cancelled" -> MoteI18n.text("已取消"); "sending" -> MoteI18n.text("发送中"); else -> MoteI18n.text("未确认") }
                    text = java.time.Instant.ofEpochMilli(attempt.startedAt).toString() + "\n" + kind + " · " + phase + " · " + state + " · HTTP " + (attempt.status.takeIf { it > 0 }?.toString() ?: "—") + "\n" + MoteI18n.text("请求体字节：{0}", attempt.bodyBytes)
                }) }
                MoteUi.styleTree(rows)
            }.onFailure { status.text = MoteI18n.text("上传历史暂不可读取，请刷新重试。") }
        } }
        body.addView(Button(this).apply { text = MoteI18n.text("刷新"); setOnClickListener { load() } })
        MoteUi.styleTree(body); load()
    }
}
