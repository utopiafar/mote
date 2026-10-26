package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

class SyncQueueActivity : MoteActivity() {
    private val task by lazy { UiTask(this) }
    private lateinit var summary: TextView
    private lateinit var rows: LinearLayout
    private lateinit var next: Button
    private lateinit var previous: Button
    private lateinit var paging: LinearLayout
    private lateinit var categories: Spinner
    private lateinit var currentTab: Button
    private lateinit var historyTab: Button
    private lateinit var historyBody: LinearLayout
    private lateinit var historyPanel: UploadHistoryPanel
    private var history = false
    private var refreshPending = false
    private var sources = emptyList<LocalSource>()
    private val pageSize = 10
    private var offset = 0
    private lateinit var speed: TextView
    private val speedHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val speedTick = object : Runnable { override fun run() { if (::speed.isInitialized) speed.text = MoteI18n.text("上传速率") + " · " + UploadMeter.label(); speedHandler.postDelayed(this, 1000) } }
    override fun onResume() { super.onResume(); speedHandler.post(speedTick) }
    override fun onPause() { speedHandler.removeCallbacks(speedTick); super.onPause() }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        history = state?.getBoolean("history") ?: false
        offset = state?.getInt("offset") ?: 0
        val body = moteDetailPage(primary = MotePrimaryTab.SOURCES, title = MoteI18n.text("同步与上传"))
        val tabs = LinearLayout(this).also(body::addView)
        currentTab = Button(this).apply { text = MoteI18n.text("当前任务"); tag = "sync-current-tab"; setOnClickListener { selectTab(false) } }
        historyTab = Button(this).apply { text = MoteI18n.text("上传历史"); tag = "sync-history-tab"; setOnClickListener { selectTab(true) } }
        tabs.addView(currentTab, LinearLayout.LayoutParams(0, -2, 1f))
        tabs.addView(historyTab, LinearLayout.LayoutParams(0, -2, 1f))
        summary = TextView(this).also(body::addView)
        speed = TextView(this).apply { MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, moteDp(MoteTheme.spaceInline), 0, moteDp(MoteTheme.spaceItem)) }.also(body::addView)
        categories = Spinner(this).also { body.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) }) }
        body.addView(Button(this).apply { text = MoteI18n.text("刷新"); setOnClickListener { load() } })
        rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        paging = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also(body::addView)
        previous = Button(this).apply { text = MoteI18n.text("上一页"); setOnClickListener { offset = (offset - pageSize).coerceAtLeast(0); load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(6) }) }
        next = Button(this).apply { text = MoteI18n.text("下一页"); setOnClickListener { offset += pageSize; load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = moteDp(6) }) }
        body.addView(Button(this).apply { text = MoteI18n.text("同步与恢复"); setOnClickListener { startActivity(Intent(this@SyncQueueActivity, SyncRecoveryActivity::class.java)) } })
        historyBody = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        historyPanel = UploadHistoryPanel(this, historyBody, state)
        MoteUi.styleTree(body)
        updateTabs()
        task.start(MoteI18n.text("正在读取来源…"), { summary.text = it }, { localSources().sources() }) { result ->
            result.onSuccess {
                sources = it
                categories.adapter = MoteUi.choiceAdapter(this, listOf(MoteI18n.text("采集与随手记")) + it.map { source -> source.name + if (source.enabled) "" else MoteI18n.text("（已暂停）") })
                categories.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                    override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { if (!history) offset = 0; load() }
                }
                updateTabs()
                // A restored history tab hides the source spinner, which need not dispatch selection.
                load()
            }.onFailure { summary.text = MoteI18n.text("队列暂不可读，请重试") }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        historyPanel.save(outState)
        outState.putBoolean("history", history); outState.putInt("offset", offset)
        super.onSaveInstanceState(outState)
    }
    private fun selectTab(nextHistory: Boolean) {
        if (history == nextHistory) return
        history = nextHistory; offset = 0; updateTabs(); load()
    }
    private fun updateTabs() {
        currentTab.isSelected = !history; historyTab.isSelected = history
        MoteUi.button(currentTab, primary = !history); MoteUi.button(historyTab, primary = history)
        historyBody.visibility = if (history) android.view.View.VISIBLE else android.view.View.GONE
        rows.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        summary.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        if (history) paging.visibility = android.view.View.GONE
        categories.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        speed.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
    }
    private fun sourceLabel(source: String) = when (source) {
        "screen" -> MoteI18n.text("屏幕采集"); "note" -> MoteI18n.text("随手记"); "activity" -> MoteI18n.text("应用活动"); "media" -> MoteI18n.text("媒体播放"); "notification" -> MoteI18n.text("通知"); "device_event" -> MoteI18n.text("设备事件"); else -> source
    }
    private fun load() {
        if (task.busy) { refreshPending = true; return }
        if (history) { loadHistory(); return }
        val source = sources.getOrNull(categories.selectedItemPosition - 1)
        previous.isEnabled = false; next.isEnabled = false; categories.isEnabled = false
        task.start(MoteI18n.text("正在读取队列…"), { summary.text = it }, {
            val page = if (source == null) queue().pendingPage(offset, pageSize)
            else if (source.binaryFiles()) fileArchives().pendingPage(source.id, offset, pageSize, source)
            else {
                val pending = localSources().state(source.id).optJSONArray("pending") ?: JSONArray()
                JSONObject().put("total", pending.length()).put("items", JSONArray((offset until minOf(offset + pageSize, pending.length())).map {
                    val item = pending.getJSONObject(it)
                    JSONObject().put("name", item.optString("title", item.optString("externalId"))).put("status", MoteI18n.text("等待上传"))
                }))
            }
            page to (SyncSchedule.waitingReason(this, Settings(this).read()) ?: Settings(this).uploadStatus())
        }) { result ->
            categories.isEnabled = true
            if (history) { refreshPending = false; load(); return@start }
            result.onSuccess { (page, reason) ->
                val total = page.getInt("total")
                summary.text = MoteI18n.text("共 {0} 条 · 第 {1} 页\n{2}", total, offset / pageSize + 1, reason)
                previous.isEnabled = offset > 0; next.isEnabled = offset + pageSize < total
                paging.visibility = if (total > pageSize || offset > 0) android.view.View.VISIBLE else android.view.View.GONE
                rows.removeAllViews()
                val items = page.getJSONArray("items")
                if (items.length() == 0) rows.addView(TextView(this).apply { text = MoteI18n.text("暂无待上传记录"); setPadding(0, moteDp(24), 0, moteDp(24)) })
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    rows.addView(TextView(this).apply {
                        MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK); gravity = android.view.Gravity.START
                        setPadding(moteDp(16), moteDp(16), moteDp(16), moteDp(16)); background = MoteUi.clickable(this@SyncQueueActivity); isFocusable = true
                        text = if (source == null) "${item.optString("appName").ifBlank { sourceLabel(item.optString("source")) }} · ${item.getString("status")}\n${java.time.Instant.parse(item.getString("capturedAt")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm:ss"))}" else "${item.optString("name")}\n${item.getString("status")}"
                        setOnClickListener { startActivity(if (source == null) Intent(this@SyncQueueActivity, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id")) else Intent(this@SyncQueueActivity, SourcesActivity::class.java)) }
                    }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(8) })
                }
            }.onFailure { summary.text = MoteI18n.text("队列读取失败，记录保留。请刷新重试。") }
            if (refreshPending) { refreshPending = false; load() }
        }
    }
    private fun loadHistory() { historyPanel.load() }
}
