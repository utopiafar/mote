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

/** Selects actual app-owned queue storage; encrypted files stay outside shared photos. */
class StorageActivity : Activity() {
    private lateinit var body: LinearLayout
    private lateinit var content: LinearLayout
    private val executor = Executors.newSingleThreadExecutor()
    private var working = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        body = moteDetailPage()
        text(body, "图片保存位置", 27f)
        text(body, "这里保存本机待同步、待 OCR 的加密图片，以及同一队列的随手记和应用活动。已归档图片仍保存在中央节点，可在采集记录中查看。")
        text(body, "选择内部应用空间，或系统提供的本机／存储卡应用空间。迁移会自动暂停处理、复制并验证已有记录，然后继续原来的采集与同步。模型、草稿、设置及来源缓存保留在内部空间。")
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(content)
        text(body, "这些是本应用专用目录，图片保持加密，不是共享相册；卸载应用会删除本机文件。移除存储卡后会停止使用该位置并提示，不会切到空目录；重新连接后可恢复。")
        MoteUi.styleTree(body)
    }
    override fun onResume() { super.onResume(); refresh() }
    private fun text(parent: LinearLayout, value: String, size: Float = 15f) {
        parent.addView(TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)); setTextColor(MoteUi.ink) })
    }
    private fun refresh() {
        if (working) return
        working = true; content.removeAllViews(); text(content, "正在读取存储位置…")
        executor.execute {
            val storage = QueueStorage(applicationContext)
            val selected = runCatching { storage.selected() }
            val current = runCatching { storage.current() }
            val choices = runCatching { storage.choices() }
            val bytes = runCatching { applicationContext.queue().diskBytes() }
            runOnUiThread {
                working = false; if (isDestroyed) return@runOnUiThread
                content.removeAllViews()
                selected.getOrNull()?.let { location -> text(content, "当前保存位置\n${location.path}\n本机加密队列：${bytes.getOrNull()?.let(::size) ?: "暂不可读取"}") }
                current.exceptionOrNull()?.let { text(content, "位置不可用：${it.message}\n已保留原位置，请重新连接原介质后重试。") }
                choices.onSuccess { entries ->
                    for (choice in entries) {
                        content.addView(Button(this).apply {
                            val chosen = selected.getOrNull()?.baseId == choice.id
                            text = "${choice.title}${if (chosen) "（当前）" else ""}\n可用 ${size(choice.availableBytes)}\n${choice.base.absolutePath}"
                            isAllCaps = false; isEnabled = current.isSuccess && !chosen && !ConnectionGuard.reconfiguring()
                            setOnClickListener { confirm(choice) }
                        })
                    }
                }.onFailure { text(content, "无法读取系统存储位置：${it.message}") }
                content.addView(Button(this).apply { text = "刷新存储状态"; setOnClickListener { refresh() } })
                MoteUi.styleTree(content)
            }
        }
    }
    private fun confirm(choice: QueueStorageChoice) {
        if (working || ConnectionGuard.reconfiguring()) return
        AlertDialog.Builder(this).setTitle("迁移本机保存位置")
            .setMessage("迁移到${choice.title}：\n${choice.base.absolutePath}\n\n已有加密图片、待 OCR 结果和队列记录会一起迁移。验证成功后切换位置并清理旧副本。中央归档位置保持不变。")
            .setNegativeButton("取消", null).setPositiveButton("迁移并应用") { _, _ -> migrate(choice) }.show()
    }
    private fun migrate(choice: QueueStorageChoice) {
        working = true; content.removeAllViews(); text(content, "正在迁移并验证加密记录，请保持存储介质连接…")
        RuntimeSettings.apply(this, Settings(this).read(), change = { QueueStorage(applicationContext).migrate(choice.id) }) { result ->
            working = false; if (isDestroyed) return@apply
            result.onSuccess {
                android.widget.Toast.makeText(this, "保存位置已生效", android.widget.Toast.LENGTH_LONG).show()
                if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
            }.onFailure { AlertDialog.Builder(this).setTitle("迁移未完成").setMessage(it.message ?: "请检查存储位置后重试，保留应用数据。") .setPositiveButton("关闭", null).show() }
            refresh()
        }
    }
    private fun size(bytes: Long) = if (bytes >= 1024L * 1024 * 1024) "%.2f GiB".format(bytes / 1024.0 / 1024 / 1024) else "%.1f MiB".format(bytes / 1024.0 / 1024)
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
}
