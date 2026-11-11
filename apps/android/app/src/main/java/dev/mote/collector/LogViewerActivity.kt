package dev.mote.collector

import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Typeface
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.ui.MoteComponents
import java.util.concurrent.Executors

/** Read-only original local log text. Rendering never interprets captured text. */
class LogViewerActivity : MoteActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var output: EditText
    private lateinit var status: TextView
    private lateinit var refresh: Button
    private lateinit var entries: LinearLayout
    private lateinit var more: Button
    private var revision = 0
    private var rawLog = ""
    private var selectedLevel: String? = null
    private var failedOnly = false
    private var visibleLimit = 40
    private var wrap = true
    private fun showLog() {
        if (!::output.isInitialized) return
        val filtered = rawLog.lineSequence().filter { it.isNotBlank() }
            .filter { selectedLevel == null || it.trim().split(Regex("\\s+"), limit = 3).getOrNull(1) == selectedLevel }
            .filter { !failedOnly || it.trim().split(Regex("\\s+"), limit = 3).getOrNull(1) == "ERROR" }.toList()
        output.setText(filtered.joinToString("\n"))
        entries.removeAllViews()
        if (filtered.isEmpty()) {
            val card = SecondaryUi.column(entries, card = true)
            SecondaryUi.text(card, MoteI18n.text(if (failedOnly) "暂无失败日志。" else "暂无日志。"), heading = true)
        }
        filtered.asReversed().take(visibleLimit).forEach { line ->
            val fields = line.trim().split(Regex("\\s+"), limit = 5)
            val title = if (fields.size >= 4) "${fields[0]} · ${fields[3]}" else line
            val detail = if (fields.size >= 5) "${fields[1]} · ${fields[4].removePrefix("- ")}" else ""
            SecondaryUi.row(entries, title, detail) {
                val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(moteDp(20), moteDp(12), moteDp(20), moteDp(12)) }
                SecondaryUi.text(content, line).apply { typeface = Typeface.MONOSPACE; setTextIsSelectable(true) }
                if (fields.getOrNull(3) == "UPLOAD") SecondaryUi.text(content, MoteI18n.text("上传请求完成不证明每份原件已接收。"), muted = true)
                MoteDialogBuilder(this).setTitle(MoteI18n.text("日志详情"))
                    .setView(ScrollView(this).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"), null).show()
                    .window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
        more.visibility = if (filtered.size > visibleLimit) android.view.View.VISIBLE else android.view.View.GONE
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        failedOnly = savedInstanceState?.getBoolean("failedOnly") ?: false
        selectedLevel = savedInstanceState?.getString("level")
        wrap = savedInstanceState?.getBoolean("wrap") ?: true
        visibleLimit = savedInstanceState?.getInt("limit") ?: 40
        val body = moteDetailPage(title = MoteI18n.text("本地日志"))
        SecondaryUi.text(body, MoteI18n.text("范围"), muted = true)
        val scope = Spinner(this).apply {
            contentDescription = MoteI18n.text("日志范围")
            adapter = ArrayAdapter(this@LogViewerActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("全部"), MoteI18n.text("失败")))
            setSelection(if (failedOnly) 1 else 0)
        }; body.addView(scope)
        status = SecondaryUi.text(body, MoteI18n.text("正在读取日志…"), muted = true).also { MoteComponents.reading(it, it.text.toString()) }
        entries = SecondaryUi.column(body)
        more = SecondaryUi.action(SecondaryUi.actions(body), MoteI18n.text("显示更多日志")) { visibleLimit += 40; showLog() }
        refresh = SecondaryUi.action(SecondaryUi.actions(body), MoteI18n.text("刷新日志")) { load() }
        val details = SecondaryUi.disclosure(body, MoteI18n.text("原始日志与显示选项"), "raw-log-options")
        SecondaryUi.text(details, MoteI18n.text("mote.log · 时间 / 级别 / 线程 / 模块 / 事件"), muted = true)
        val actions = SecondaryUi.actions(details)
        SecondaryUi.action(actions, MoteI18n.text("复制全部")) {
            if (rawLog.isNotEmpty()) {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(MoteI18n.text("Mote 原始日志"), rawLog))
                status.text = MoteI18n.text("已复制全部原始日志。")
            }
        }
        SecondaryUi.action(actions, MoteI18n.text("全选")) { output.requestFocus(); output.selectAll() }
        val levelValues = listOf(null, "DEBUG", "INFO", "WARN", "ERROR")
        val levels = Spinner(this).apply {
            contentDescription = MoteI18n.text("日志级别")
            adapter = ArrayAdapter(this@LogViewerActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("全部级别"), "DEBUG", "INFO", "WARN", "ERROR"))
            setSelection(levelValues.indexOf(selectedLevel).coerceAtLeast(0))
        }; details.addView(levels)
        details.addView(CheckBox(this).apply { text = MoteI18n.text("自动换行"); isChecked = wrap; setOnCheckedChangeListener { _, checked -> wrap = checked; output.setHorizontallyScrolling(!checked) } })
        output = EditText(this).apply {
            keyListener = null; setTextIsSelectable(true); setHorizontallyScrolling(!wrap)
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            typeface = Typeface.MONOSPACE; textSize = 12f; minLines = 12
            contentDescription = MoteI18n.text("原始日志"); hint = MoteI18n.text("暂无日志。")
        }; details.addView(output)
        levels.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { if (selectedLevel != levelValues[position]) { selectedLevel = levelValues[position]; visibleLimit = 40 }; showLog() }
        }
        scope.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { if (failedOnly != (position == 1)) { failedOnly = position == 1; visibleLimit = 40 }; showLog() }
        }
        MoteUi.styleTree(body); output.typeface = Typeface.MONOSPACE
        load()
    }
    private fun load() {
        val stamp = ++revision
        refresh.isEnabled = false; MoteComponents.reading(status, MoteI18n.text("正在读取日志…"))
        executor.execute {
            val result = runCatching { SupportEvents.runtime(this).readRaw() }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision) return@runOnUiThread
                refresh.isEnabled = true
                result.onSuccess { raw -> rawLog = raw; showLog(); status.text = if (raw.isEmpty()) MoteI18n.text("暂无日志。") else MoteI18n.text("原始日志 · 长按选中复制") }
                    .onFailure { status.text = MoteI18n.text("日志读取失败，请重试；原文件保留。") }
            }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("failedOnly", failedOnly); outState.putString("level", selectedLevel); outState.putBoolean("wrap", wrap); outState.putInt("limit", visibleLimit)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() { revision++; executor.shutdown(); super.onDestroy() }
}
