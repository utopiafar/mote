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
class SourcesActivity : Activity() {
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
        content.addView(TextView(this).apply { text = "日历与文件"; textSize = 28f })
        content.addView(TextView(this).apply { text = "只读取你主动选择的来源。日历记录计划时间，不代表实际参加；文件由系统选择器授权，不扫描整个手机。\n环境：${BuildConfig.MOTE_PROFILE}。中央节点沿用「连接与同步」中已保存的配置。"; textSize = 14f })
        fun action(label: String, callback: () -> Unit) { content.addView(Button(this).apply { text = label; setOnClickListener { callback() } }) }
        operationStatus = TextView(this); content.addView(operationStatus)
        action("连接本机日历") {
            if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) chooseCalendars()
            else requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 301)
        }
        action("选择一个文件") { pick(false) }
        action("选择文件目录") { pick(true) }
        action("立即扫描并同步") { work("正在调度扫描与同步…") { SourceWork.schedule(applicationContext, true, syncExplicit = true) } }
        content.addView(TextView(this).apply { text = "默认扩展名 md/txt/json/csv/ics，正文只接受 UTF-8；单文件 100 KiB、100000 字符，单次最多 200 项和 4 MiB，来源缓存最多 64 MiB（也遵守采集与存储中的队列上限）。超限或扫描不完整会提示，绝不把漏扫项当作删除。\n系统后台任务约每 15 分钟检查一次来源各自的间隔；省电或强行停止可能推迟，重新打开应用可恢复。引用模式仅同步名称/URI/时间元数据。"; textSize = 13f })
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
                    val state = store.state(source.id); val pending = state.optJSONArray("pending")?.length() ?: 0
                    val status = when (state.optString("status")) {
                        "permission" -> "权限丢失，请重新授权"; "paused" -> "中央已暂停；请在中央恢复后重试"; "provider" -> "提供者不可用或缓存已满；保留旧快照，稍后重试"
                        "offline" -> "等待网络/节点恢复"; "http", "ack" -> "节点未确认，原版本保留待发"; "synced" -> "已同步"; "partial" -> "扫描不完整"; "scanned" -> "已扫描，等待发送"; else -> "等待首次扫描"
                    }
                    source to "\n${source.name}\n${if (source.kind == "local-calendar") "日历" else "文件"} · ${if (source.retention == "reference") "仅引用" else "正文快照"} · ${if (source.enabled) status else "本机已停用"}\n待发 $pending 个版本 · 最近扫描 ${state.optString("lastScan", "尚无")}\n${if (state.has("scanComplete") && !state.optBoolean("scanComplete")) "本次扫描未完整：跳过 ${state.optInt("skipped")} 项；没有推断这些项已删除。" else ""}"
                }
            }
            runOnUiThread {
                rendering = false
                if (isDestroyed || isFinishing) return@runOnUiThread
                list.removeAllViews()
                if (rows.isFailure) list.addView(TextView(this).apply { text = "加密来源配置不可读；请保留应用数据，检查设备密钥。" })
                else {
                    if (rows.getOrThrow().isEmpty()) list.addView(TextView(this).apply { text = "尚未连接来源。权限只在点击连接时申请。" })
                    for ((source, summary) in rows.getOrThrow()) {
                        list.addView(TextView(this).apply { text = summary; textSize = 15f })
                        list.addView(Button(this).apply { text = "设置 · ${source.name}"; setOnClickListener { edit(source) } })
                    }
                }
                MoteUi.styleTree(list)
            }
        }
    }
    private fun work(label: String, action: () -> Unit) {
        task.start(label, { operationStatus.text = it }, { action() }) { result ->
            operationStatus.text = if (result.isSuccess) "操作已完成；同步进度会自动刷新" else result.exceptionOrNull()?.message ?: "操作失败，请重试"
            render()
        }
    }
    private fun chooseCalendars() {
        task.start("正在读取本机日历…", { operationStatus.text = it }, {
            SourceProviders(contentResolver).calendars() to localSources().sources()
        }) { result ->
            result.onSuccess { (calendars, sources) ->
                operationStatus.text = "已读取 ${calendars.size} 个日历"
                if (calendars.isEmpty()) { toast("系统日历提供者暂无日历；只有保存在本机提供者中的日历可连接"); return@onSuccess }
                AlertDialog.Builder(this).setTitle("选择一个本机日历").setItems(calendars.map { it.name }.toTypedArray()) { _, index ->
                    val item = calendars[index]
                    if (!item.visible) { toast("该日历在系统中已隐藏，请先启用显示后再连接"); return@setItems }
                    edit(sources.find { it.kind == "local-calendar" && it.calendarId == item.id }
                        ?: LocalSource(name = item.name.take(200).ifBlank { "本机日历" }, kind = "local-calendar", calendarId = item.id))
                }.setNegativeButton("取消", null).show()
            }.onFailure { operationStatus.text = "无法读取日历列表，请检查权限与日历应用" }
        }
    }
    private fun pick(tree: Boolean) {
        val intent = if (tree) Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        @Suppress("DEPRECATION") startActivityForResult(intent, if (tree) 403 else 402)
    }
    @Deprecated("Platform permission callback")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 301 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) chooseCalendars()
        else if (requestCode == 301) toast("未授权，不读取日历；可在系统应用权限中重新允许")
    }
    @Deprecated("Platform document callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || requestCode !in setOf(402, 403)) return
        val uri = data?.data ?: return
        if (task.busy) { toast("正在处理上一项操作，请稍后重新选择文件"); return }
        selectedUris.add(uri.toString())
        task.start("正在读取所选文件…", { operationStatus.text = it }, {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                val name = runCatching { contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } }.getOrNull()
                localSources().sources().find { it.uri == uri.toString() }
                    ?: LocalSource(name = (name ?: if (requestCode == 403) "选择的文件目录" else "选择的文件").take(200), kind = "local-files", uri = uri.toString(), tree = requestCode == 403)
            } catch (error: Exception) { releaseUnused(uri.toString()); throw error }
        }) { result ->
            result.onSuccess { operationStatus.text = "文件已读取，请确认来源设置"; edit(it) }
                .onFailure { operationStatus.text = "无法读取文件或持久授权，请重新选择" }
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
        val name = field("来源名称", source.name)
        val enabled = CheckBox(this).apply { text = "允许本机扫描并发送这个来源"; isChecked = source.enabled }; form.addView(enabled)
        val reference = CheckBox(this).apply { text = "仅引用：不读取/发送正文（中央已有历史不随此设置删除）"; isChecked = source.retention == "reference" }; form.addView(reference)
        val interval = field("扫描间隔 / 分钟（15–1440，系统可能推迟）", source.intervalMinutes.toString(), true)
        val before = if (source.kind == "local-calendar") field("过去多少天（0–365）", source.daysBefore.toString(), true) else null
        val after = if (source.kind == "local-calendar") field("未来多少天（1–365）", source.daysAfter.toString(), true) else null
        val extensions = if (source.kind == "local-files") field("允许扩展名，逗号分隔", source.extensions) else null
        val excludes = if (source.kind == "local-files") field("排除相对路径：每行一项，* 表示任意字符；区分大小写", source.excluded) else null
        form.addView(TextView(this).apply { text = "更改选择、过滤或保留方式会清除这个来源的本机旧待发缓存，按新设置重新扫描；不会自动删除中央历史。停用仅暂停本机检查与同步，中央的启用状态与历史保持不变。移除只影响本机连接。" })
        MoteUi.styleTree(form)
        val dialog = AlertDialog.Builder(this).setTitle("来源设置").setView(ScrollView(this).apply { addView(form) }).setNegativeButton("取消", null).setPositiveButton("保存来源设置", null)
            .setNeutralButton("移除连接") { _, _ ->
                work("正在移除来源连接…") {
                    localSources().remove(source.id); source.uri?.let(::releaseUnused); SourceWork.schedule(applicationContext)
                }
            }.create()
        // A cancelled new connection must not consume a persisted URI grant indefinitely.
        dialog.setOnDismissListener {
            if (!worker.isShutdown) source.uri?.let { uri -> worker.execute { runCatching { releaseUnused(uri) } } }
        }
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                val next = source.copy(name = name.text.toString(), enabled = enabled.isChecked, retention = if (reference.isChecked) "reference" else "snapshot",
                    intervalMinutes = interval.text.toString().toInt(), daysBefore = before?.text?.toString()?.toInt() ?: source.daysBefore,
                    daysAfter = after?.text?.toString()?.toInt() ?: source.daysAfter, extensions = extensions?.text?.toString() ?: source.extensions, excluded = excludes?.text?.toString() ?: source.excluded)
                if (task.busy) return@setOnClickListener
                next.validate()
                dialog.setCancelable(false)
                listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = false }
                task.start("正在保存来源设置…", { operationStatus.text = it; dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = it }, {
                    localSources().save(next); SourceWork.schedule(applicationContext, true)
                }) { result ->
                    dialog.setCancelable(true)
                    listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).isEnabled = true }
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).text = "保存来源设置"
                    result.onSuccess { dialog.dismiss(); operationStatus.text = "来源已保存，正在等待后台扫描"; render() }
                        .onFailure { toast(it.message ?: "保存或调度失败，请重试；已保存内容不会丢失") }
                }
            } catch (error: Exception) { toast(if (error is IllegalArgumentException) error.message ?: "请检查来源设置" else "保存或调度失败，请重试；已保存内容不会丢失") }
        } }
        dialog.show()
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
