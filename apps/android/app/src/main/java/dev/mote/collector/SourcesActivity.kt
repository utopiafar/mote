package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors

/** Native opt-in connection UI. No calendar query occurs before the user requests a connection. */
class SourcesActivity : MoteActivity() {
    private lateinit var list: LinearLayout
    private val worker = Executors.newSingleThreadExecutor()
    private val selectedUris = mutableSetOf<String>()
    private val task by lazy { UiTask(this, worker, ownsExecutor = false) }
    private lateinit var operationStatus: TextView
    private var rendering = false
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable { override fun run() { render(); handler.postDelayed(this, 2500) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = moteDetailPage()
        content.addView(TextView(this).apply { text = MoteI18n.text("日历与文件"); textSize = 28f })
        content.addView(TextView(this).apply { text = MoteI18n.text("选择要归档的日历与文件。"); textSize = 14f })
        fun action(label: String, callback: () -> Unit) { content.addView(Button(this).apply { text = label; setOnClickListener { callback() } }) }
        operationStatus = TextView(this); content.addView(operationStatus)
        action(MoteI18n.text("连接本机日历")) {
            if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) chooseCalendars()
            else requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 301)
        }
        action(MoteI18n.text("选择一个文件")) { pick(false) }
        action(MoteI18n.text("选择文件目录")) { pick(true) }
        action(MoteI18n.text("选择录音目录 · 原件归档")) { pick(true, true) }
        action(MoteI18n.text("立即扫描并同步")) { work(MoteI18n.text("正在调度扫描与同步…")) { SourceWork.schedule(applicationContext, true, syncExplicit = true) } }
        action(MoteI18n.text("来源限制与同步说明")) { AlertDialog.Builder(this).setTitle(MoteI18n.text("来源说明")).setMessage(MoteI18n.text("默认扩展名 md/txt/json/csv/ics，正文只接受 UTF-8；单文件 100 KiB、100000 字符，单次最多 200 项和 4 MiB，来源缓存最多 64 MiB（也遵守采集与存储中的队列上限）。超限或扫描不完整会提示，绝不把漏扫项当作删除。\n系统后台任务约每 15 分钟检查一次来源各自的间隔；省电或强行停止可能推迟，重新打开应用可恢复。原件归档每文件最多 512 MiB，Mote 文件暂存最多 1 GiB；自动等待稳定后上传，断网续传。引用模式不读取原件，不受原件大小限制。")).setPositiveButton(MoteI18n.text("知道了"), null).show() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(list)
        MoteUi.styleTree(content)
    }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() {
        // FIFO cleanup runs after any accepted provider read/save, even if its UI result was discarded.
        val uris = selectedUris.toList()
        worker.execute { uris.forEach { uri -> runCatching { releaseUnused(uri) } } }
        worker.shutdown(); super.onDestroy()
    }
    private fun render() {
        if (isDestroyed || !::list.isInitialized || rendering || worker.isShutdown) return
        rendering = true
        worker.execute {
            val rows = runCatching {
                val store = localSources()
                store.sources().map { source ->
                    val state = if (source.binaryFiles()) fileArchives().state(source.id).put("status", store.state(source.id).optString("status")) else store.state(source.id); val pending = if (source.binaryFiles()) fileArchives().pendingCount(source.id) else state.optJSONArray("pending")?.length() ?: 0
                    val status = when (state.optString("status")) {
                        "permission" -> MoteI18n.text("权限丢失，请重新授权"); "paused" -> MoteI18n.text("中央已暂停；请在中央恢复后重试"); "provider" -> MoteI18n.text("提供者不可用或缓存已满；保留旧快照，稍后重试")
                        "offline" -> MoteI18n.text("等待网络/节点恢复"); "http", "ack" -> MoteI18n.text("节点未确认，原版本保留待发"); "synced" -> MoteI18n.text("已同步"); "partial" -> MoteI18n.text("扫描不完整"); "scanned" -> MoteI18n.text("已扫描，等待发送"); else -> MoteI18n.text("等待首次扫描")
                    }
                    source to MoteI18n.text("\n{0}\n{1} · {2} · {3}\n待发 {4} 个版本 · 最近扫描 {5}\n{6}", source.name, if (source.kind == "local-calendar") MoteI18n.text("日历") else MoteI18n.text("文件"), when (source.retention) { "reference" -> MoteI18n.text("仅引用"); "archive" -> MoteI18n.text("原件归档"); else -> MoteI18n.text("正文快照") }, if (source.enabled) status else MoteI18n.text("本机已停用"), pending, state.optString("lastScan", MoteI18n.text("尚无")), if (state.has("scanComplete") && !state.optBoolean("scanComplete")) MoteI18n.text("本次扫描未完整：跳过 {0} 项；没有推断这些项已删除。", state.optInt("skipped")) else "")
                }
            }
            runOnUiThread {
                rendering = false
                if (isDestroyed || isFinishing) return@runOnUiThread
                list.removeAllViews()
                if (rows.isFailure) list.addView(TextView(this).apply { text = MoteI18n.text("来源配置不可读；请保留应用数据，检查存储状态。") })
                else {
                    if (rows.getOrThrow().isEmpty()) list.addView(TextView(this).apply { text = MoteI18n.text("尚未连接来源。权限只在点击连接时申请。") })
                    for ((source, summary) in rows.getOrThrow()) {
                        list.addView(TextView(this).apply { text = summary; textSize = 15f })
                        list.addView(Button(this).apply { text = MoteI18n.text("设置 · {0}", source.name); setOnClickListener { edit(source) } })
                    }
                }
                MoteUi.styleTree(list)
            }
        }
    }
    private fun work(label: String, action: () -> Unit) {
        task.start(label, { operationStatus.text = it }, { action() }) { result ->
            operationStatus.text = if (result.isSuccess) MoteI18n.text("操作已完成；同步进度会自动刷新") else result.exceptionOrNull()?.message ?: MoteI18n.text("操作失败，请重试")
            render()
        }
    }
    private fun chooseCalendars() {
        task.start(MoteI18n.text("正在读取本机日历…"), { operationStatus.text = it }, {
            SourceProviders(contentResolver).calendars() to localSources().sources()
        }) { result ->
            result.onSuccess { (calendars, sources) ->
                operationStatus.text = MoteI18n.text("已读取 {0} 个日历", calendars.size)
                if (calendars.isEmpty()) { toast(MoteI18n.text("系统日历提供者暂无日历；只有保存在本机提供者中的日历可连接")); return@onSuccess }
                AlertDialog.Builder(this).setTitle(MoteI18n.text("选择一个本机日历")).setItems(calendars.map { it.name }.toTypedArray()) { _, index ->
                    val item = calendars[index]
                    if (!item.visible) { toast(MoteI18n.text("该日历在系统中已隐藏，请先启用显示后再连接")); return@setItems }
                    edit(sources.find { it.kind == "local-calendar" && it.calendarId == item.id }
                        ?: LocalSource(name = item.name.take(200).ifBlank { MoteI18n.text("本机日历") }, kind = "local-calendar", calendarId = item.id))
                }.setNegativeButton(MoteI18n.text("取消"), null).show()
            }.onFailure { operationStatus.text = MoteI18n.text("无法读取日历列表，请检查权限与日历应用") }
        }
    }
    private fun pick(tree: Boolean, archive: Boolean = false) {
        val intent = if (tree) Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        @Suppress("DEPRECATION") startActivityForResult(intent, if (archive) 405 else if (tree) 403 else 402)
    }
    @Deprecated("Platform permission callback")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 301 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) chooseCalendars()
        else if (requestCode == 301) toast(MoteI18n.text("未授权，不读取日历；可在系统应用权限中重新允许"))
    }
    @Deprecated("Platform document callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || requestCode !in setOf(402, 403, 405)) return
        val uri = data?.data ?: return
        if (task.busy) { toast(MoteI18n.text("正在处理上一项操作，请稍后重新选择文件")); return }
        selectedUris.add(uri.toString())
        task.start(MoteI18n.text("正在读取所选文件…"), { operationStatus.text = it }, {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                val name = runCatching { contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } }.getOrNull()
                localSources().sources().find { it.uri == uri.toString() }
                    ?: LocalSource(name = (name ?: if (requestCode != 402) MoteI18n.text("选择的文件目录") else MoteI18n.text("选择的文件")).take(200), kind = "local-files", uri = uri.toString(), tree = requestCode != 402, retention = if (requestCode == 405) "archive" else "snapshot", extensions = if (requestCode == 405) "m4a,mp3,wav,aac,amr,ogg,flac,opus" else "md,txt,json,csv,ics")
            } catch (error: Exception) { releaseUnused(uri.toString()); throw error }
        }) { result ->
            result.onSuccess { operationStatus.text = MoteI18n.text("文件已读取，请确认来源设置"); edit(it) }
                .onFailure { operationStatus.text = MoteI18n.text("无法读取文件或持久授权，请重新选择") }
        }
    }
    private fun releaseUnused(uri: String) {
        if (localSources().sources().none { it.uri == uri }) runCatching { contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
    private fun edit(source: LocalSource) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 12, 28, 12) }
        fun field(label: String, value: String, numeric: Boolean = false): EditText {
            form.addView(TextView(this).apply { text = label })
            return EditText(this).apply { setText(value); if (numeric) inputType = InputType.TYPE_CLASS_NUMBER; form.addView(this) }
        }
        val name = field(MoteI18n.text("来源名称"), source.name)
        val enabled = CheckBox(this).apply { text = MoteI18n.text("允许本机扫描并发送这个来源"); isChecked = source.enabled }; form.addView(enabled)
        form.addView(TextView(this).apply { text = MoteI18n.text("保存方式（中央已有历史不会随设置更改而删除）") })
        val modes = if (source.kind == "local-files") listOf("snapshot", "reference", "archive") else listOf("snapshot", "reference")
        val retention = Spinner(this).apply { adapter = ArrayAdapter(this@SourcesActivity, android.R.layout.simple_spinner_dropdown_item, modes.map { when(it) { "archive" -> MoteI18n.text("原件归档 · 中央保留文件"); "reference" -> MoteI18n.text("仅引用 · 不读取正文"); else -> MoteI18n.text("文字快照") } }); setSelection(modes.indexOf(source.retention).coerceAtLeast(0)) }; form.addView(retention)
        form.addView(TextView(this).apply { text = MoteI18n.text("首次同步范围") })
        val initial = Spinner(this).apply { adapter = ArrayAdapter(this@SourcesActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("已有内容分批导入（默认）"), MoteI18n.text("首次清点后仅同步新条目"))); setSelection(if (source.initialSync == "new_only") 1 else 0) }; form.addView(initial)
        form.addView(TextView(this).apply { text = MoteI18n.text("本地删除不影响中央原件；上传后仅清理 Mote 暂存，保留手机原文件。仅同步新增以首次完整清单为基线，重启不会重置。") })
        val interval = field(MoteI18n.text("扫描间隔 / 分钟（15–1440，系统可能推迟）"), source.intervalMinutes.toString(), true)
        val before = if (source.kind == "local-calendar") field(MoteI18n.text("过去多少天（0–365）"), source.daysBefore.toString(), true) else null
        val after = if (source.kind == "local-calendar") field(MoteI18n.text("未来多少天（1–365）"), source.daysAfter.toString(), true) else null
        val extensions = if (source.kind == "local-files") field(MoteI18n.text("允许扩展名，逗号分隔"), source.extensions) else null
        val excludes = if (source.kind == "local-files") field(MoteI18n.text("排除相对路径：每行一项，* 表示任意字符；区分大小写"), source.excluded) else null
        form.addView(TextView(this).apply { text = MoteI18n.text("更改选择、过滤或保留方式会清除这个来源的本机旧待发缓存，按新设置重新扫描；不会自动删除中央历史。停用仅暂停本机检查与同步，中央的启用状态与历史保持不变。移除只影响本机连接。") })
        MoteUi.styleTree(form)
        val dialog = AlertDialog.Builder(this).setTitle(MoteI18n.text("来源设置")).setView(ScrollView(this).apply { addView(form) }).setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("保存来源设置"), null)
            .setNeutralButton(MoteI18n.text("移除连接")) { _, _ ->
                work(MoteI18n.text("正在移除来源连接…")) {
                    localSources().remove(source.id); fileArchives().remove(source.id); source.uri?.let(::releaseUnused); SourceWork.schedule(applicationContext)
                }
            }.create()
        // A cancelled new connection must not consume a persisted URI grant indefinitely.
        dialog.setOnDismissListener {
            if (!worker.isShutdown) source.uri?.let { uri -> worker.execute { runCatching { releaseUnused(uri) } } }
        }
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                val next = source.copy(name = name.text.toString(), enabled = enabled.isChecked, retention = modes[retention.selectedItemPosition], initialSync = if (initial.selectedItemPosition == 1) "new_only" else "all",
                    intervalMinutes = interval.text.toString().toInt(), daysBefore = before?.text?.toString()?.toInt() ?: source.daysBefore,
                    daysAfter = after?.text?.toString()?.toInt() ?: source.daysAfter, extensions = extensions?.text?.toString() ?: source.extensions, excluded = excludes?.text?.toString() ?: source.excluded)
                if (task.busy) return@setOnClickListener
                next.validate()
                dialog.setCancelable(false)
                listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = false }
                task.start(MoteI18n.text("正在保存来源设置…"), { operationStatus.text = it; dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = it }, {
                    localSources().save(next); SourceWork.schedule(applicationContext, true)
                }) { result ->
                    dialog.setCancelable(true)
                    listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = true }
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = MoteI18n.text("保存来源设置")
                    result.onSuccess { dialog.dismiss(); operationStatus.text = MoteI18n.text("来源已保存，正在等待后台扫描"); render() }
                        .onFailure { toast(it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
                }
            } catch (error: Exception) { toast(if (error is IllegalArgumentException) error.message ?: MoteI18n.text("请检查来源设置") else MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
        } }
        dialog.show()
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
