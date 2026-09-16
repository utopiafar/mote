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
class LogViewerActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var output: EditText
    private lateinit var status: TextView
    private lateinit var refresh: Button
    private var revision = 0
    private var rawLog = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        text(body, "日志中心", 27f)
        text(body, "按文件原始顺序显示，长按可选中复制。刷新时更新，诊断关闭后历史仍可查看。", 14f)
        status = text(body, "正在读取日志…", 13f)
        refresh = Button(this).apply { text = "刷新日志"; setOnClickListener { load() } }; body.addView(refresh)
        body.addView(Button(this).apply { text = "复制全部"; setOnClickListener {
            if (rawLog.isNotEmpty()) {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Mote 原始日志", rawLog))
                status.text = "已复制全部原始日志。"
            }
        } })
        body.addView(Button(this).apply { text = "全选"; setOnClickListener { output.requestFocus(); output.selectAll() } })
        body.addView(CheckBox(this).apply { text = "自动换行"; isChecked = true; setOnCheckedChangeListener { _, checked -> output.setHorizontallyScrolling(!checked) } })
        output = EditText(this).apply {
            keyListener = null; setTextIsSelectable(true); setHorizontallyScrolling(false)
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            typeface = Typeface.MONOSPACE; textSize = 12f; minLines = 16
            contentDescription = "原始日志"; hint = "暂无日志。"
        }; body.addView(output)
        MoteUi.styleTree(body)
        output.typeface = Typeface.MONOSPACE
        load()
    }
    private fun load() {
        val stamp = ++revision
        refresh.isEnabled = false; status.text = "正在读取日志…"
        executor.execute {
            val result = runCatching { SupportEvents.journal(this).readRaw() }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision) return@runOnUiThread
                refresh.isEnabled = true
                result.onSuccess { raw -> rawLog = raw; output.setText(raw); status.text = if (raw.isEmpty()) "暂无日志。" else "原始日志 · 长按选中复制" }
                    .onFailure { status.text = "日志读取失败，请重试；原文件保留。" }
            }
        }
    }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    override fun onDestroy() { revision++; executor.shutdown(); super.onDestroy() }
}
