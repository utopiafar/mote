package dev.mote.collector

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.plugins.StorageBackupPlugin
import dev.mote.collector.plugins.StorageStatus

/** Routes storage-location reads and migration to the storage plugin; this
 * Activity only renders the returned status and confirms the user intent. */
class StorageActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var content: LinearLayout
    private var working = false
    private var migrationLabel: TextView? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val poll = object : Runnable { override fun run() { migrationLabel?.text = RuntimeSettings.progressLabel(); handler.postDelayed(this, 500) } }
    private var configured = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private lateinit var inventory: TextView
    private val owner get() = StorageBackupPlugin.owner(this)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage(title = MoteI18n.text("本机存储位置"))
        inventory = SecondaryUi.text(body, MoteI18n.text("正在读取本机同步状态…"), muted = true)
        content = SecondaryUi.column(body)
        val details = SecondaryUi.disclosure(body, MoteI18n.text("迁移时会发生什么"), "storage-migration-details")
        text(details, MoteI18n.text("选择内部应用空间，或系统提供的本机／存储卡应用空间。迁移会自动暂停处理、复制并验证已有记录，然后继续原来的采集与同步。草稿、设置及来源缓存保留在内部空间。"))
        text(details, MoteI18n.text("记录和索引为 JSON，图片保留原始格式。这些是本应用专用目录，不是共享相册；卸载应用会删除本机文件。移除存储卡后不会自动改到空目录。"))
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); localStateJob = observeLocalState { inventory.text = it.active?.let { count -> MoteI18n.text("本机保留 {0} 条 · 待发 {1} 条", count.records, count.pending) } ?: it.imageLabel() }; handler.post(poll); refresh() }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; handler.removeCallbacks(poll); super.onPause() }
    private fun text(parent: LinearLayout, value: String, size: Float = 15f) {
        parent.addView(TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)); MoteUi.textColor(this, NativeColorRole.INK) })
    }
    private fun refresh() {
        if (working) return
        working = true; content.removeAllViews(); text(content, MoteI18n.text("正在读取存储位置…"))
        content.addView(android.widget.ProgressBar(this))
        owner.loadStorage { result ->
            working = false; if (isDestroyed) return@loadStorage
            content.removeAllViews()
            result.onFailure { text(content, MoteI18n.text("无法读取系统存储位置：{0}", it.message)) }
            val status: StorageStatus? = result.getOrNull()
            configured = status?.config != null
            if (status != null) {
                val selected = status.selected.getOrNull()
                selected?.let { location ->
                    val currentCard = SecondaryUi.column(content, card = true)
                    SecondaryUi.text(currentCard, MoteI18n.text("当前保存位置"), muted = true)
                    SecondaryUi.text(currentCard, status.choices.getOrNull()?.firstOrNull { it.id == location.baseId }?.title ?: MoteI18n.text("本机存储位置"), heading = true)
                    val path = SecondaryUi.disclosure(currentCard, MoteI18n.text("查看实际目录"), "storage-current-path")
                    text(path, location.path)
                }
                status.current.exceptionOrNull()?.let { text(content, MoteI18n.text("位置不可用：{0}\n已保留原位置，请重新连接原介质后重试。", it.message)) }
                status.choices.onSuccess { entries ->
                    for (choice in entries) {
                        val chosen = selected?.baseId == choice.id
                        SecondaryUi.row(content, choice.title + if (chosen) MoteI18n.text("（当前）") else "", MoteI18n.text("可用 {0}", size(choice.availableBytes))) { confirm(choice) }.apply {
                            tag = "storage-choice:${choice.id}"
                            isEnabled = configured && status.current.isSuccess && !chosen && !ConnectionGuard.reconfiguring()
                        }
                    }
                }.onFailure { text(content, MoteI18n.text("无法读取系统存储位置：{0}", it.message)) }
            }
            content.addView(Button(this).apply { text = MoteI18n.text("刷新存储状态"); setOnClickListener { refresh() } })
            MoteUi.styleTree(content)
        }
    }
    private fun confirm(choice: QueueStorageChoice) {
        if (working || ConnectionGuard.reconfiguring()) return
        MoteDialogBuilder(this).setTitle(MoteI18n.text("迁移本机保存位置"))
            .setMessage(MoteI18n.text("迁移到{0}：\n{1}\n\n已有图片和队列记录会一起迁移。验证成功后切换位置并清理旧副本。中央归档位置保持不变。", choice.title, choice.base.absolutePath))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("迁移并应用")) { _, _ -> migrate(choice) }.show()
    }
    private fun migrate(choice: QueueStorageChoice) {
        if (working || ConnectionGuard.reconfiguring()) return
        working = true; content.removeAllViews()
        migrationLabel = SecondaryUi.text(content, MoteI18n.text("正在迁移并验证记录，请保持存储介质连接…")).apply { tag="storage-migration-progress"; accessibilityLiveRegion=android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        content.addView(android.widget.ProgressBar(this))
        owner.migrate(this, choice) { result ->
            migrationLabel = null; working = false; if (isDestroyed) return@migrate
            result.onSuccess {
                android.widget.Toast.makeText(this, MoteI18n.text("保存位置已生效"), android.widget.Toast.LENGTH_LONG).show()
                if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
            }.onFailure { MoteDialogBuilder(this).setTitle(MoteI18n.text("迁移未完成")).setMessage(it.message ?: MoteI18n.text("请检查存储位置后重试，保留应用数据。")) .setPositiveButton(MoteI18n.text("关闭"), null).show() }
            refresh()
        }
    }
    private fun size(bytes: Long) = if (bytes >= 1024L * 1024 * 1024) "%.2f GiB".format(bytes / 1024.0 / 1024 / 1024) else "%.1f MiB".format(bytes / 1024.0 / 1024)
}
