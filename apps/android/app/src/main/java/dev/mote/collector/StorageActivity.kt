package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/** Selects actual app-owned queue storage; files stay outside shared photos. */
class StorageActivity : MoteActivity() {
    private lateinit var body: LinearLayout
    private lateinit var content: LinearLayout
    private val executor = Executors.newSingleThreadExecutor()
    private var working = false
    private var migrationLabel: TextView? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val poll = object : Runnable { override fun run() { migrationLabel?.text = RuntimeSettings.progressLabel(); handler.postDelayed(this, 500) } }
    private var config: CollectorConfig? = null
    private var localStateJob: kotlinx.coroutines.Job? = null
    private lateinit var inventory: TextView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage()
        text(body, MoteI18n.text("图片保存位置"), 27f)
        text(body, MoteI18n.text("本机保存待同步、待 OCR 与保留期内的记录和图片。上传后仍可回看，到期才清理。"))
        text(body, MoteI18n.text("选择内部应用空间，或系统提供的本机／存储卡应用空间。迁移会自动暂停处理、复制并验证已有记录，然后继续原来的采集与同步。模型、草稿、设置及来源缓存保留在内部空间。"))
        inventory = TextView(this).apply { textSize = 15f }; body.addView(inventory)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(content)
        text(body, MoteI18n.text("默认明文保存：记录和索引为 JSON，图片保留原始格式。开发者选项可开启本地内容加密，也可批量解密旧文件。这些是本应用专用目录，不是共享相册；卸载应用会删除本机文件。移除存储卡后会停止使用该位置并提示，不会切到空目录；重新连接后可恢复。"))
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); localStateJob = observeLocalState { inventory.text = it.storageLabel() }; handler.post(poll); refresh() }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; handler.removeCallbacks(poll); super.onPause() }
    private fun text(parent: LinearLayout, value: String, size: Float = 15f) {
        parent.addView(TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)); setTextColor(MoteUi.ink) })
    }
    private fun refresh() {
        if (working) return
        working = true; content.removeAllViews(); text(content, MoteI18n.text("正在读取存储位置…"))
        content.addView(android.widget.ProgressBar(this))
        executor.execute {
            val storage = QueueStorage(applicationContext)
            val selected = runCatching { storage.selected() }
            val current = runCatching { storage.current() }
            val choices = runCatching { storage.choices() }
            val settings = runCatching { Settings(applicationContext).read() }
            runOnUiThread {
                working = false; if (isDestroyed) return@runOnUiThread
                config = settings.getOrNull(); content.removeAllViews()
                selected.getOrNull()?.let { location -> text(content, MoteI18n.text("当前保存位置\n{0}", location.path)) }
                current.exceptionOrNull()?.let { text(content, MoteI18n.text("位置不可用：{0}\n已保留原位置，请重新连接原介质后重试。", it.message)) }
                choices.onSuccess { entries ->
                    for (choice in entries) {
                        content.addView(Button(this).apply {
                            val chosen = selected.getOrNull()?.baseId == choice.id
                            text = MoteI18n.text("{0}{1}\n可用 {2}\n{3}", choice.title, if (chosen) MoteI18n.text("（当前）") else "", size(choice.availableBytes), choice.base.absolutePath)
                            isAllCaps = false; isEnabled = config != null && current.isSuccess && !chosen && !ConnectionGuard.reconfiguring()
                            setOnClickListener { confirm(choice) }
                        })
                    }
                }.onFailure { text(content, MoteI18n.text("无法读取系统存储位置：{0}", it.message)) }
                content.addView(Button(this).apply { text = MoteI18n.text("刷新存储状态"); setOnClickListener { refresh() } })
                MoteUi.styleTree(content)
            }
        }
    }
    private fun confirm(choice: QueueStorageChoice) {
        if (working || ConnectionGuard.reconfiguring()) return
        MoteDialogBuilder(this).setTitle(MoteI18n.text("迁移本机保存位置"))
            .setMessage(MoteI18n.text("迁移到{0}：\n{1}\n\n已有图片、待 OCR 结果和队列记录会一起迁移。验证成功后切换位置并清理旧副本。中央归档位置保持不变。", choice.title, choice.base.absolutePath))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("迁移并应用")) { _, _ -> migrate(choice) }.show()
    }
    private fun migrate(choice: QueueStorageChoice) {
        val current = config ?: return
        working = true; content.removeAllViews()
        migrationLabel = TextView(this).apply { text = MoteI18n.text("正在迁移并验证记录，请保持存储介质连接…"); content.addView(this) }
        content.addView(android.widget.ProgressBar(this))
        RuntimeSettings.apply(this, current, change = { QueueStorage(applicationContext).migrate(choice.id) }) { result ->
            migrationLabel = null; working = false; if (isDestroyed) return@apply
            result.onSuccess {
                android.widget.Toast.makeText(this, MoteI18n.text("保存位置已生效"), android.widget.Toast.LENGTH_LONG).show()
                if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
            }.onFailure { MoteDialogBuilder(this).setTitle(MoteI18n.text("迁移未完成")).setMessage(it.message ?: MoteI18n.text("请检查存储位置后重试，保留应用数据。")) .setPositiveButton(MoteI18n.text("关闭"), null).show() }
            refresh()
        }
    }
    private fun size(bytes: Long) = if (bytes >= 1024L * 1024 * 1024) "%.2f GiB".format(bytes / 1024.0 / 1024 / 1024) else "%.1f MiB".format(bytes / 1024.0 / 1024)
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
}
