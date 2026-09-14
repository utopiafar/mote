package dev.mote.collector

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.time.Instant
import java.util.concurrent.Executors

/** Read-only, privacy-safe local event log. */
class LogViewerActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private var level = "all"
    private var revision = 0
    private var page = 0
    private var events = emptyList<org.json.JSONObject>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        text(body, "本地日志", 27f)
        text(body, "仅显示固定阶段和错误级别，不包含截图、文字、令牌、地址或异常原文。", 14f)
        val filter = Spinner(this).apply {
            adapter = ArrayAdapter(this@LogViewerActivity, android.R.layout.simple_spinner_dropdown_item, listOf("全部级别", "信息", "警告", "错误"))
            setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { level = listOf("all", "ok", "wait", "error")[position]; page = 0; if (::list.isInitialized) renderRows() }
            })
        }; body.addView(filter)
        status = text(body, "正在读取日志…", 13f)
        progress = ProgressBar(this); body.addView(progress)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        body.addView(Button(this).apply { text = "刷新日志"; setOnClickListener { load() } })
        load(); MoteUi.styleTree(body)
    }

    private fun load() {
        if (!::list.isInitialized) return
        val stamp = ++revision
        status.text = "正在读取日志…"
        progress.visibility = android.view.View.VISIBLE
        executor.execute {
            val result = runCatching { SupportEvents.journal(this).read(strict = true) }
            runOnUiThread {
                if (isDestroyed || isFinishing || stamp != revision) return@runOnUiThread
                progress.visibility = android.view.View.GONE
                result.onSuccess { rows ->
                    events = (0 until rows.length()).map { rows.getJSONObject(it) }.asReversed()
                    page = 0; renderRows()
                }.onFailure { status.text = "日志读取失败，请重试；原文件保留。" }
            }
        }
    }
    private fun renderRows() {
        val rows = events.filter { level == "all" || eventLevel(it.optString("code")) == level }
        page = page.coerceIn(0, maxOf(0, (rows.size - 1) / 20))
        list.removeAllViews()
        status.text = "${rows.size} 条 · 第 ${page + 1}/${maxOf(1, (rows.size + 19) / 20)} 页 · 每页 20 条"
        rows.drop(page * 20).take(20).forEach { event ->
            val label = when (eventLevel(event.optString("code"))) { "ok" -> "信息"; "wait" -> "警告"; else -> "错误" }
            text(list, "${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(event.getLong("atMs")))}\n$label · ${event.optString("stage")} · ${event.optString("code")}\n耗时：${event.opt("elapsedMs") ?: "未测量"} ms · HTTP：${event.opt("httpStatus") ?: "无"}", 14f)
        }
        if (rows.isEmpty()) text(list, "暂无符合条件的日志。诊断关闭时停止新增，历史仍可查看。", 14f)
        list.addView(MoteUi.button(Button(this).apply { text = "上一页"; isEnabled = page > 0; setOnClickListener { page--; renderRows() } }))
        list.addView(MoteUi.button(Button(this).apply { text = "下一页"; isEnabled = (page + 1) * 20 < rows.size; setOnClickListener { page++; renderRows() } }))
    }
    private fun eventLevel(code: String) = when (code) {
        "started", "stopped", "ok", "filtered", "cancelled" -> "ok"
        "wait_network", "scheduler", "permission", "model_unavailable" -> "wait"
        else -> "error"
    }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    override fun onDestroy() { revision++; executor.shutdown(); super.onDestroy() }
}
