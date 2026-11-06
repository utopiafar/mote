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
import dev.mote.collector.ui.MoteGlyph
import java.util.concurrent.Executors

class SyncRecoveryActivity : MoteActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var summary: TextView
    private lateinit var stateDetails: TextView
    private lateinit var issues: LinearLayout
    private lateinit var result: TextView
    private lateinit var stop: Button
    private val task by lazy { UiTask(this) }
    private var reading = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private val refresh = object : Runnable { override fun run() { refreshStatus(); handler.postDelayed(this, 3000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage(title = MoteI18n.text("同步与恢复"))
        val card = SecondaryUi.column(body, card = true)
        summary = SecondaryUi.text(card, MoteI18n.text("正在读取本机同步状态…"), heading = true)
        result = SecondaryUi.text(body, "", muted = true).apply { tag = "recovery-result"; accessibilityLiveRegion = android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        SecondaryUi.row(body, MoteI18n.text("检查两端记录状态"), MoteI18n.text("核对手机仍保留的记录"), icon = MoteGlyph.SEARCH) { runAction { SyncRecoveryWorker.start(this, false) } }.tag = "recovery-check"
        SecondaryUi.row(body, MoteI18n.text("补传本机保留的记录"), MoteI18n.text("仍遵守当前网络和来源设置"), icon = MoteGlyph.UP) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("重新上传本机保留的数据？"))
                .setMessage(MoteI18n.text("会重发本机仍保留的截图、页面、应用活动、通知、设备事件、笔记及已启用来源的保留版本。中央核验相同 ID 去重，继续补齐缺失数据。\n\n已从手机清理的数据无法补传。中央已删除或内容冲突的记录不会覆盖或恢复，暂停的来源不会启用。此操作可能产生较多流量，仍遵守网络设置。"))
                .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("开始补传")) { _, _ -> runAction { SyncRecoveryWorker.start(this, true) } }.show()
        }.tag = "recovery-replay"
        stop = SecondaryUi.action(body, MoteI18n.text("停止本次检查 / 准备补传")) { runAction { WorkManager.getInstance(this).cancelUniqueWork("mote-sync-recovery"); getSharedPreferences("sync-recovery", MODE_PRIVATE).edit().putString("message", MoteI18n.text("已请求停止检查；已进入待发队列的记录按同步策略保留")).apply() } }.apply { tag = "recovery-stop"; visibility = android.view.View.GONE }
        val details = SecondaryUi.disclosure(body, MoteI18n.text("哪些内容可以补传？"), "recovery-scope")
        stateDetails = SecondaryUi.text(details, "", muted = true)
        SecondaryUi.text(details, MoteI18n.text("只检查手机仍保留的采集记录在中央是否可见；不会把“中央存在”直接当作上传确认，也不会删除或恢复记录。"), muted = true)
        SecondaryUi.text(details, MoteI18n.text("需要处理时：\n• 网络或服务暂不可用：自动模式退避重试，手动模式再次点同步。\n• 授权失效：重新连接同一节点后同步。\n• 同 ID 内容冲突 / 中央已删除：保留本机副本，跳过该条继续其他记录，不自动覆盖。\n• 待复核：仅在逐条明确释放后允许上传，更改审查规则不会自动释放。\n\n中央显示的是上次联系时的状态，不是手机实时状态。"))
        issues = SecondaryUi.column(body)
        SecondaryUi.row(details, MoteI18n.text("查看待上传队列")) { startActivity(Intent(this, SyncQueueActivity::class.java)) }
        SecondaryUi.row(details, MoteI18n.text("查看记录与冲突")) { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        SecondaryUi.row(details, MoteI18n.text("查看来源同步状态")) { startActivity(Intent(this, SourcesActivity::class.java)) }
        MoteUi.styleTree(body)
    }
    private fun runAction(action: () -> Unit) {
        task.start(MoteI18n.text("正在提交后台任务…"), { result.text = it }, { action() }) { outcome ->
            outcome.onSuccess { refreshStatus() }.onFailure { result.text = it.message ?: MoteI18n.text("请先配置连接") }
        }
    }
    private fun refreshStatus() {
        if (reading || isDestroyed) return
        reading = true
        executor.execute {
            val value = runCatching {
                val settings = Settings(this); val local = LocalStatusProducer.get(this).state.value; val c = local.active ?: error(MoteI18n.text("正在读取存储状态")); val sources = runCatching { localSources().pendingSync() }.getOrNull()
                val config = settings.read(); val status = settings.storedSyncStatus()
                val translations = if (status.state in setOf("unconfigured", "paused")) MoteI18n.translations(SyncReadiness.obsoleteMessages) else emptyMap()
                val visible = SyncReadiness.visible(config, status, SyncSchedule.waitingReason(this, config), c, local.sourceIssues, local.pending, inventoryUnavailable = local.error != null, sourceUnavailable = local.sourceError || sources == null) { source, value -> source == value || translations[source]?.contains(value) == true }
                val notice = if (settings.syncRequestRejected()) "\n" + MoteI18n.text("配置已发生变化，请刷新后重试。") else ""
                MoteI18n.text("本机保留 {0} 条 · 待发 {1} 条", c.records, local.pending ?: "—") to MoteI18n.text("{0}\n本机保留 {1} 条 · 待发 {2} 条\n需处理 {3} 条\n来源待发 {4} 个版本 / {5} 项设置\n\n{6}\n最后收到上传确认：{7}", local.imageLabel(), c.records, local.pending ?: "—", c.blocked, local.sourcePending ?: "—", sources?.pendingUpdates ?: "—", SyncReadiness.text(visible) + notice, settings.lastUploadAt() ?: MoteI18n.text("尚无"))
            }.getOrElse { MoteI18n.text("本机状态暂不可读：{0}", it.message ?: MoteI18n.text("请检查存储")) to "" }
            val failures = runCatching { queue().syncIssues() }.getOrDefault(emptyList())
            val report = getSharedPreferences("sync-recovery", MODE_PRIVATE).getString("message", "")
            runOnUiThread { reading = false; if (!isDestroyed) { summary.text = value.first; stateDetails.text = value.second; if (!task.busy) result.text = report
                stop.visibility = if (getSharedPreferences("sync-recovery", MODE_PRIVATE).contains("message")) android.view.View.VISIBLE else android.view.View.GONE
                issues.removeAllViews()
                failures.forEach { item -> issues.addView(MoteUi.button(Button(this).apply {
                    text = MoteI18n.text("{0} · {1}\n{2} · 点按查看本机副本", item.getString("reason"), item.getString("capturedAt"), item.getString("id").take(8))
                    setOnClickListener { startActivity(Intent(this@SyncRecoveryActivity, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id"))) }
                }), LinearLayout.LayoutParams(-1,-2))
                    if (item.getBoolean("retryable")) issues.addView(MoteUi.button(Button(this).apply {
                        text = if (item.optBoolean("reviewHeld")) MoteI18n.text("复核后允许上传此记录") else MoteI18n.text("重新核验此冲突 · 不覆盖中央数据")
                        setOnClickListener {
                            isEnabled = false
                            executor.execute {
                                val retried = runCatching { ConnectionGuard.sync {
                                    val config = Settings(this@SyncRecoveryActivity).read(); config.validateConnection()
                                    if (queue().retryConflict(item.getString("id"), config.maxQueueMiB * 1024L * 1024L)) UploadWorker.schedule(this@SyncRecoveryActivity, config, true)
                                } ?: error(MoteI18n.text("正在调整连接，请稍后重试")) }
                                runOnUiThread { if (!isDestroyed) { result.text = if (retried.isSuccess) MoteI18n.text("已请求核验；相同内容会确认，不同内容仍保留冲突") else MoteI18n.text("核验未启动，请检查连接"); refreshStatus() } }
                            }
                        }
                    }), LinearLayout.LayoutParams(-1,-2))
                }
            } }
        }
    }
    override fun onResume() { super.onResume(); localStateJob = observeLocalState { refreshStatus() }; handler.post(refresh) }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); executor.shutdownNow(); super.onDestroy() }
}
