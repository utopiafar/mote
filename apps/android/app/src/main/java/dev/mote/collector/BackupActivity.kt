package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.io.File
import java.util.UUID

class BackupActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private lateinit var status: TextView
    private lateinit var secrets: CheckBox
    private var includeToken = false
    private var restoring = false
    @Volatile private var closed = false
    private var prepared: QueueArchive.Prepared? = null
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        includeToken = state?.getBoolean("includeToken") ?: false
        val body = moteDetailPage()
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(10), 0, moteDp(10)) }.also(body::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { if (!task.busy) action() } }.also(body::addView)
        text(MoteI18n.text("导入与导出"), 28f)
        text(MoteI18n.text("客户端配置"), 20f)
        text(MoteI18n.text("迁移采集、应用规则、同步、模型和诊断设置。系统权限和来源文件授权需在新设备重新授予。"))
        secrets = CheckBox(this).apply { text = MoteI18n.text("导出时包含节点令牌（文件为明文，请妥善保管）"); isChecked = includeToken }.also(body::addView)
        button(MoteI18n.text("导出配置 JSON")) { includeToken = secrets.isChecked; create(10, "application/json", "mote-settings.json") }
        button(MoteI18n.text("导入配置 JSON")) { open(11, "application/json") }
        text(MoteI18n.text("本机记录"), 20f)
        text(MoteI18n.text("备份本机仍保留的截图、应用活动、通知、媒体和随手记。ZIP 为明文，不含中央归档、来源文件原件、未提交草稿或模型文件。"))
        button(MoteI18n.text("导出本机记录 ZIP")) { create(12, "application/zip", "mote-records.zip") }
        button(MoteI18n.text("导入本机记录 ZIP")) { open(13, "application/zip") }
        status = text(MoteI18n.text("导入前可预览；同 ID 记录不会重复添加。"))
        MoteUi.styleTree(body)
    }
    private fun create(code: Int, mime: String, name: String) = startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name), code)
    private fun open(code: Int, mime: String) = startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime), code)
    @Deprecated("Native document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        when (requestCode) {
            10 -> task.start(MoteI18n.text("正在导出配置…"), { status.text = it }, {
                val json = ConfigurationArchive.encode(Settings(this).read(), includeToken)
                requireNotNull(contentResolver.openOutputStream(uri, "wt")).bufferedWriter().use { it.write(json) }
            }) { result -> status.text = if (result.isSuccess) MoteI18n.text("配置已导出") else MoteI18n.text("导出未完成，请重试") }
            11 -> task.start(MoteI18n.text("正在读取配置…"), { status.text = it }, {
                val current = Settings(this).read()
                val bytes = requireNotNull(contentResolver.openInputStream(uri)).use { input ->
                    val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val count = input.read(buffer); if (count < 0) break; require(out.size() + count <= ConfigurationArchive.MAX_BYTES) { MoteI18n.text("配置文件过大") }; out.write(buffer, 0, count) }
                    out.toByteArray()
                 }
                require(bytes.size <= ConfigurationArchive.MAX_BYTES)
                current to ConfigurationArchive.decode(AppReleaseVerifier.utf8(bytes), current)
            }) { result -> result.onSuccess { (current, next) ->
                AlertDialog.Builder(this).setTitle(MoteI18n.text("导入客户端配置？"))
                    .setMessage(MoteI18n.text("采集间隔 {0} 秒 · 保留 {1} 天\n应用规则 {2} 项\n{3}\n\n将替换当前偏好设置。已有记录和设备身份保留，系统权限不会自动开启。", next.intervalSeconds, next.uploadedRetentionDays, next.collectionRules.apps.size, if (current.server == next.server) MoteI18n.text("中央节点不变") else MoteI18n.text("中央节点将改变；未携带令牌时需重新连接")))
                    .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("导入")) { _, _ ->
                        RuntimeSettings.apply(this, next, expected = current) { applied -> status.text = if (applied.isSuccess) MoteI18n.text("配置已导入") else applied.exceptionOrNull()?.message ?: MoteI18n.text("配置导入失败，原设置保留") }
                    }.show()
            }.onFailure { status.text = MoteI18n.text("配置无法导入：{0}", it.message ?: MoteI18n.text("文件无效")) } }
            12 -> task.start(MoteI18n.text("正在导出本机记录…"), { status.text = it }, {
                ConnectionGuard.sync {
                    QueueArchive.export(queue(), Settings(this).dataOrigin(), requireNotNull(contentResolver.openOutputStream(uri, "wt")))
                } ?: error(MoteI18n.text("设置正在变更，请稍后重试"))
            }) { result -> status.text = result.fold({ MoteI18n.text("已导出 {0} 条记录", it) }, { MoteI18n.text("导出未完成，请删除不完整文件后重试") }) }
            13 -> task.start(MoteI18n.text("正在校验备份…"), { status.text = it }, {
                prepared?.close(); prepared = null
                val settings = Settings(this)
                val staged = QueueArchive.prepare(requireNotNull(contentResolver.openInputStream(uri)), File(cacheDir, "restore-${UUID.randomUUID()}"), settings.read().maxQueueMiB * 1024L * 1024)
                if (staged.origin != settings.dataOrigin()) { staged.close(); error(MoteI18n.text("备份属于不同中央节点，请先连接原节点")) }
                if (closed) { staged.close(); error(MoteI18n.text("页面已关闭")) }
                prepared = staged; staged
            }) { result -> result.onSuccess { staged ->
                AlertDialog.Builder(this).setTitle(MoteI18n.text("导入 {0} 条本机记录？", staged.count))
                    .setMessage(MoteI18n.text("已有记录保留，同 ID 自动去重。同步将切换为手动，检查导入结果后可立即同步。"))
                    .setNegativeButton(MoteI18n.text("取消")) { _, _ -> staged.close(); prepared = null }
                    .setOnCancelListener { staged.close(); prepared = null }
                    .setPositiveButton(MoteI18n.text("导入")) { _, _ ->
                        val settings = Settings(this); val current = settings.read(); val next = current.copy(syncMode = "manual")
                        restoring = true
                        RuntimeSettings.apply(this, next, expected = current, change = {
                            settings.save(next, current)
                            QueueArchive.restore(staged, queue(), settings.dataOrigin(), next.maxQueueMiB * 1024L * 1024)
                        }) { applied ->
                            staged.close(); prepared = null; restoring = false
                            status.text = if (applied.isSuccess) MoteI18n.text("记录已导入 · 手动同步") else MoteI18n.text("导入未完成：{0}。已导入记录保留，可重试同一备份。", applied.exceptionOrNull()?.message)
                        }
                    }.show()
            }.onFailure { status.text = MoteI18n.text("备份无法导入：{0}", it.message ?: MoteI18n.text("文件无效")) } }
        }
    }
    override fun onDestroy() { closed = true; if (!restoring) prepared?.let { java.util.concurrent.Executors.newSingleThreadExecutor().apply { execute { it.close() }; shutdown() } }; super.onDestroy() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putBoolean("includeToken", includeToken); super.onSaveInstanceState(outState) }
}
