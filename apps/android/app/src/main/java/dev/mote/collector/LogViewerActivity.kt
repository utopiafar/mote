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
    private var level = "all"
    @Volatile private var generation = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        text(body, "本地日志", 27f)
        text(body, "仅显示固定阶段和错误级别，不包含截图、文字、令牌、地址或异常原文。", 14f)
        val filter = Spinner(this).apply {
            adapter = ArrayAdapter(this@LogViewerActivity, android.R.layout.simple_spinner_dropdown_item, listOf("全部级别", "正常", "等待", "错误"))
            setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { level = listOf("all", "ok", "wait", "error")[position]; load() }
            })
        }; body.addView(filter)
        status = text(body, "正在读取日志…", 13f)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        load(); MoteUi.styleTree(body)
    }

    private fun load() {
        val stamp = ++generation; val selectedLevel = level
        status.text = "正在读取日志…"; list.removeAllViews()
        executor.execute {
            val events = runCatching { SupportEvents.journal(this).read() }.getOrElse { org.json.JSONArray() }
            val rows = (0 until events.length()).mapNotNull { events.optJSONObject(it) }.asReversed().filter { event ->
                when (selectedLevel) {
                    "ok" -> event.optString("code") in setOf("started", "stopped", "ok")
                    "wait" -> event.optString("code") in setOf("wait_network", "scheduler", "permission", "model_unavailable")
                    "error" -> event.optString("code") !in setOf("started", "stopped", "ok", "wait_network", "scheduler")
                    else -> true
                }
            }.take(100)
            runOnUiThread {
                if (isDestroyed || stamp != generation) return@runOnUiThread
                list.removeAllViews()
                status.text = "最近 ${rows.size} 条 · 最多保留 500 条"
                rows.forEach { event ->
                    val elapsed = event.optLong("elapsedMs", -1).takeIf { it >= 0 }?.let { " · ${it}ms" } ?: ""
                    list.addView(TextView(this).apply {
                        text = "${Instant.ofEpochMilli(event.optLong("atMs"))}\n${event.optString("stage")} · ${event.optString("code")}$elapsed"
                        textSize = 14f; setPadding(moteDp(14), moteDp(12), moteDp(14), moteDp(12)); background = MoteUi.shape(this@LogViewerActivity)
                    }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) })
                }
                if (rows.isEmpty()) list.addView(TextView(this).apply { text = "暂无符合条件的日志。请在开发者选项中开启诊断后重试。" })
            }
        }
    }
    private fun text(parent: LinearLayout, value: String, size: Float) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)) }.also(parent::addView)
    override fun onDestroy() { generation++; executor.shutdown(); super.onDestroy() }
}
