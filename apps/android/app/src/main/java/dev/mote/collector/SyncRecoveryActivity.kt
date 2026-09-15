package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.work.WorkManager
import java.util.concurrent.Executors

class SyncRecoveryActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var summary: TextView
    private lateinit var issues: LinearLayout
    private lateinit var result: TextView
    private var reading = false
    private val refresh = object : Runnable { override fun run() { refreshStatus(); handler.postDelayed(this, 3000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0,moteDp(8),0,moteDp(8)) }.also(body::addView)
        fun button(label: String, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; setOnClickListener { action() } }).also { body.addView(it, LinearLayout.LayoutParams(-1,-2)) }
        text("同步与恢复", 27f)
        text("手机负责采集，中央端负责归档。手机收到确认后会清理已完成处理的副本，因此两端记录数量通常不同。")
        summary = text("正在读取本机同步状态…")
        button("立即同步待发记录") { runAction { UploadWorker.schedule(this, Settings(this).read(), true) } }
        text("从未确认的记录继续发送；上传中断只重发未确认记录。同一条记录重试不会生成重复副本。仍遵守 Wi-Fi 设置。")
        button("检查两端记录状态") { runAction { SyncRecoveryWorker.start(this, false) } }
        text("只检查手机仍保留的采集记录在中央端是否可见；不会把“中央存在”直接当作上传确认，也不会删除或恢复记录。")
        button("全量补传 · 本机保留的记录") {
            AlertDialog.Builder(this).setTitle("重新上传本机保留的数据？")
                .setMessage("会重发本机仍保留的截图、OCR 原始事件、通知、设备事件、笔记及已启用来源的保留版本。中央端核验相同 ID 去重，继续补齐缺失数据。\n\n已从手机清理的数据无法补传。中央已删除或内容冲突的记录不会覆盖或恢复，暂停的来源不会启用。此操作可能产生较多流量，仍遵守网络设置。")
                .setNegativeButton("取消", null).setPositiveButton("开始补传") { _, _ -> runAction { SyncRecoveryWorker.start(this, true) } }.show()
        }
        result = text("尚未执行检查或全量补传")
        button("停止本次检查 / 准备补传") { WorkManager.getInstance(this).cancelUniqueWork("mote-sync-recovery"); getSharedPreferences("sync-recovery", MODE_PRIVATE).edit().putString("message", "已请求停止检查；已进入待发队列的记录按同步策略保留").apply(); refreshStatus() }
        issues = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(issues)
        button("查看记录与冲突") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        button("查看来源同步状态") { startActivity(Intent(this, SourcesActivity::class.java)) }
        text("需要处理时：\n• 网络或服务暂不可用：自动模式退避重试，手动模式再次点同步。\n• 授权失效：重新连接同一节点后同步。\n• 同 ID 内容冲突 / 中央已删除：保留本机副本，跳过该条继续其他记录，不自动覆盖。\n• 等待 OCR：图片已归档不代表识别完成，识别结果会另行确认。\n\n中央端显示的是上次联系时的状态，不是手机实时状态。")
        MoteUi.styleTree(body)
    }
    private fun runAction(action: () -> Unit) {
        runCatching { action() }.onFailure { result.text = it.message ?: "请先配置连接" }
        refreshStatus()
    }
    private fun refreshStatus() {
        if (reading || isDestroyed) return
        reading = true
        executor.execute {
            val value = runCatching {
                val settings = Settings(this); val c = queue().syncInventory(); val sources = localSources().pendingSync()
                "本机保留 ${c.getInt("retained")} 条 · 待发 ${c.getInt("pending")} 条\n需处理 ${c.getInt("blocked")} 条 · 等待 OCR ${c.getInt("awaitingOcr")} 张\n来源待发 ${sources.count} 个版本 / ${sources.pendingUpdates} 项设置\n\n${SyncSchedule.waitingReason(this, settings.read()) ?: settings.uploadStatus()}\n最后收到上传确认：${settings.lastUploadAt() ?: "尚无"}"
            }.getOrElse { "本机状态暂不可读：${it.message ?: "请检查存储"}" }
            val failures = runCatching { queue().syncIssues() }.getOrDefault(emptyList())
            val report = getSharedPreferences("sync-recovery", MODE_PRIVATE).getString("message", "尚未执行检查或全量补传")
            runOnUiThread { reading = false; if (!isDestroyed) { summary.text = value; result.text = report
                issues.removeAllViews()
                failures.forEach { item -> issues.addView(MoteUi.button(Button(this).apply {
                    text = "${item.getString("reason")} · ${item.getString("capturedAt")}\n${item.getString("id").take(8)} · 点按查看本机副本"
                    setOnClickListener { startActivity(Intent(this@SyncRecoveryActivity, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id"))) }
                }), LinearLayout.LayoutParams(-1,-2))
                    if (item.getBoolean("retryable")) issues.addView(MoteUi.button(Button(this).apply {
                        text = "重新核验此冲突 · 不覆盖中央数据"
                        setOnClickListener {
                            isEnabled = false
                            executor.execute {
                                val retried = runCatching { ConnectionGuard.sync {
                                    val config = Settings(this@SyncRecoveryActivity).read(); config.validateConnection()
                                    if (queue().retryConflict(item.getString("id"), config.maxQueueMiB * 1024L * 1024L)) UploadWorker.schedule(this@SyncRecoveryActivity, config, true)
                                } ?: error("正在调整连接，请稍后重试") }
                                runOnUiThread { if (!isDestroyed) { result.text = if (retried.isSuccess) "已请求核验；相同内容会确认，不同内容仍保留冲突" else "核验未启动，请检查连接"; refreshStatus() } }
                            }
                        }
                    }), LinearLayout.LayoutParams(-1,-2))
                }
            } }
        }
    }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); executor.shutdownNow(); super.onDestroy() }
}
