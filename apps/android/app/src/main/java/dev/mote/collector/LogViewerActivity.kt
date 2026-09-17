package dev.mote.collector

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Typeface
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors

/** Read-only original local log text. Rendering never interprets captured text. */
class LogViewerActivity : MoteActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var output: EditText
    private lateinit var status: TextView
    private lateinit var refresh: Button
    private var revision = 0
    private var rawLog = ""
    private var selectedLevel: String? = null
    private fun showLog() { if (::output.isInitialized) output.setText(rawLog.lineSequence().filter { selectedLevel == null || it.split(' ').getOrNull(1) == selectedLevel }.joinToString("\n")) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        text(body, MoteI18n.text("日志中心"), 27f)
        text(body, MoteI18n.text("mote.log · 时间 / 级别 / 线程 / 模块 / 事件"), 14f)
        status = text(body, MoteI18n.text("正在读取日志…"), 13f)
        refresh = Button(this).apply { text = MoteI18n.text("刷新日志"); setOnClickListener { load() } }; body.addView(refresh)
        body.addView(Button(this).apply { text = MoteI18n.text("复制全部"); setOnClickListener {
            if (rawLog.isNotEmpty()) {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(MoteI18n.text("Mote 原始日志"), rawLog))
                status.text = MoteI18n.text("已复制全部原始日志。")
            }
        } })
        body.addView(Button(this).apply { text = MoteI18n.text("全选"); setOnClickListener { output.requestFocus(); output.selectAll() } })
        val levels = Spinner(this).apply { adapter = ArrayAdapter(this@LogViewerActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("全部级别"), "DEBUG", "INFO", "WARN", "ERROR")) }
        body.addView(levels)
        levels.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                selectedLevel = if (position == 0) null else levels.selectedItem.toString(); showLog()
            }
        }
        body.addView(CheckBox(this).apply { text = MoteI18n.text("自动换行"); isChecked = true; setOnCheckedChangeListener { _, checked -> output.setHorizontallyScrolling(!checked) } })
        output = EditText(this).apply {
            keyListener = null; setTextIsSelectable(true); setHorizontallyScrolling(false)
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            typeface = Typeface.MONOSPACE; textSize = 12f; minLines = 16
            contentDescription = MoteI18n.text("原始日志"); hint = MoteI18n.text("暂无日志。")
        }; body.addView(output)
        MoteUi.styleTree(body)
        output.typeface = Typeface.MONOSPACE
        load()
    }
    private fun load() {
        val stamp = ++revision
        refresh.isEnabled = false; status.text = MoteI18n.text("正在读取日志…")
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
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    override fun onDestroy() { revision++; executor.shutdown(); super.onDestroy() }
}
