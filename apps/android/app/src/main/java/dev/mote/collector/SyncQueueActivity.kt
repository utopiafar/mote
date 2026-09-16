package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

class SyncQueueActivity : Activity() {
    private val task by lazy { UiTask(this) }
    private lateinit var summary: TextView
    private lateinit var rows: LinearLayout
    private lateinit var next: Button
    private lateinit var previous: Button
    private lateinit var paging: LinearLayout
    private lateinit var categories: Spinner
    private var sources = emptyList<LocalSource>()
    private var offset = 0
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage()
        body.addView(TextView(this).apply { text = "待上传队列"; textSize = 28f })
        summary = TextView(this).also(body::addView)
        categories = Spinner(this).also(body::addView)
        body.addView(Button(this).apply { text = "刷新"; setOnClickListener { load() } })
        rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        paging = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also(body::addView)
        previous = Button(this).apply { text = "上一页"; setOnClickListener { offset = (offset - 30).coerceAtLeast(0); load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(6) }) }
        next = Button(this).apply { text = "下一页"; setOnClickListener { offset += 30; load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = moteDp(6) }) }
        body.addView(Button(this).apply { text = "同步与恢复"; setOnClickListener { startActivity(Intent(this@SyncQueueActivity, SyncRecoveryActivity::class.java)) } })
        MoteUi.styleTree(body)
        task.start("正在读取来源…", { summary.text = it }, { localSources().sources() }) { result ->
            result.onSuccess {
                sources = it
                categories.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("采集与随手记") + it.map { source -> source.name + if (source.enabled) "" else "（已暂停）" })
                categories.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                    override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { offset = 0; load() }
                }
            }.onFailure { summary.text = "队列暂不可读，请重试" }
        }
    }
    private fun sourceLabel(source: String) = when (source) {
        "screen" -> "屏幕采集"; "note" -> "随手记"; "activity" -> "应用活动"; "media" -> "媒体播放"; "notification" -> "通知"; "device_event" -> "设备事件"; else -> source
    }
    private fun load() {
        if (task.busy) return
        val source = sources.getOrNull(categories.selectedItemPosition - 1)
        previous.isEnabled = false; next.isEnabled = false; categories.isEnabled = false
        task.start("正在读取队列…", { summary.text = it }, {
            val page = if (source == null) queue().pendingPage(offset)
            else if (source.binaryFiles()) fileArchives().pendingPage(source.id, offset)
            else {
                val pending = localSources().state(source.id).optJSONArray("pending") ?: JSONArray()
                JSONObject().put("total", pending.length()).put("items", JSONArray((offset until minOf(offset + 30, pending.length())).map {
                    val item = pending.getJSONObject(it)
                    JSONObject().put("name", item.optString("title", item.optString("externalId"))).put("status", "等待上传")
                }))
            }
            page to (SyncSchedule.waitingReason(this, Settings(this).read()) ?: Settings(this).uploadStatus())
        }) { result ->
            categories.isEnabled = true
            result.onSuccess { (page, reason) ->
                val total = page.getInt("total")
                summary.text = "共 $total 条 · 第 ${offset / 30 + 1} 页\n$reason"
                previous.isEnabled = offset > 0; next.isEnabled = offset + 30 < total
                paging.visibility = if (total > 30 || offset > 0) android.view.View.VISIBLE else android.view.View.GONE
                rows.removeAllViews()
                val items = page.getJSONArray("items")
                if (items.length() == 0) rows.addView(TextView(this).apply { text = "暂无待上传记录"; setPadding(0, moteDp(24), 0, moteDp(24)) })
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    rows.addView(TextView(this).apply {
                        textSize = 15f; setTextColor(MoteUi.ink); gravity = android.view.Gravity.START
                        setPadding(moteDp(16), moteDp(16), moteDp(16), moteDp(16)); background = MoteUi.clickable(this@SyncQueueActivity); isFocusable = true
                        text = if (source == null) "${item.optString("appName").ifBlank { sourceLabel(item.optString("source")) }} · ${item.getString("status")}\n${java.time.Instant.parse(item.getString("capturedAt")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm:ss"))}" else "${item.optString("name")}\n${item.getString("status")}"
                        setOnClickListener { startActivity(if (source == null) Intent(this@SyncQueueActivity, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id")) else Intent(this@SyncQueueActivity, SourcesActivity::class.java)) }
                    }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) })
                }
            }.onFailure { summary.text = "队列读取失败，记录保留。请刷新重试。" }
        }
    }
}
