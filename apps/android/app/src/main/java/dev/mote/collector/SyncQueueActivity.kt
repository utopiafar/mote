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
    private val actionTask by lazy { UiTask(this) }
    private val statusTextTask by lazy { UiTask(this) }
    private var statusTranslations: Map<String, Set<String>>? = null
    private var statusTranslationFailed = false
    private lateinit var sendStatus: TextView
    private lateinit var sendCount: TextView
    private lateinit var pauseSend: Button
    private lateinit var sendNow: Button
    private var localStateJob: kotlinx.coroutines.Job? = null
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
    private var sendingPaused = false
    private var refreshPending = false
    private var sources = emptyList<LocalSource>()
    private val pageSize = 10
    private var offset = 0
    private lateinit var filters: LinearLayout
    private lateinit var speed: TextView
    private val speedHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val speedTick = object : Runnable { override fun run() { if (::speed.isInitialized) speed.text = MoteI18n.text("上传速率") + " · " + UploadMeter.label(); speedHandler.postDelayed(this, 1000) } }
    override fun onResume() { super.onResume(); speedHandler.post(speedTick); localStateJob = observeLocalState { refreshSendState(it) } }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; speedHandler.removeCallbacks(speedTick); super.onPause() }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        history = state?.getBoolean("history") ?: false
        offset = state?.getInt("offset") ?: 0
        val body = moteDetailPage(primary = MotePrimaryTab.SOURCES, title = MoteI18n.text("同步与上传"))
        val sendCard = SecondaryUi.column(body)
        sendStatus = SecondaryUi.text(sendCard, MoteI18n.text("正在读取本机同步状态…"), heading = true).apply { tag = "sync-send-status"; accessibilityLiveRegion = android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE }
        sendCount = SecondaryUi.text(sendCard, "", muted = true)
        val sendActions = SecondaryUi.actions(sendCard)
        pauseSend = SecondaryUi.action(sendActions, "") { changeSendState() }.apply { tag = "sync-send-pause" }
        sendNow = SecondaryUi.action(sendActions, MoteI18n.text("立即同步"), primary = true) { requestSync() }.apply { tag = "sync-send-now" }
        val tabs = LinearLayout(this).also(body::addView)
        currentTab = Button(this).apply { text = MoteI18n.text("当前任务"); tag = "sync-current-tab"; setOnClickListener { selectTab(false) } }
        historyTab = Button(this).apply { text = MoteI18n.text("上传历史"); tag = "sync-history-tab"; setOnClickListener { selectTab(true) } }
        tabs.addView(currentTab, LinearLayout.LayoutParams(-2, -2))
        tabs.addView(historyTab, LinearLayout.LayoutParams(-2, -2))
        filters = SecondaryUi.disclosure(body, MoteI18n.text("来源筛选与传输详情"), "sync-filters", intent.hasExtra("sourceId"))
        summary = TextView(this).also(body::addView)
        speed = TextView(this).apply { MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, moteDp(MoteTheme.spaceInline), 0, moteDp(MoteTheme.spaceItem)) }.also(filters::addView)
        categories = Spinner(this).also { filters.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) }) }
        SecondaryUi.action(filters, MoteI18n.text("刷新")) { load() }
        rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        paging = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also(body::addView)
        previous = Button(this).apply { text = MoteI18n.text("上一页"); setOnClickListener { offset = (offset - pageSize).coerceAtLeast(0); load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(6) }) }
        next = Button(this).apply { text = MoteI18n.text("下一页"); setOnClickListener { offset += pageSize; load() } }.also { paging.addView(it, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = moteDp(6) }) }

        historyBody = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        historyPanel = UploadHistoryPanel(this, historyBody, state)
        SecondaryUi.row(body, MoteI18n.text("同步与恢复")) { startActivity(Intent(this, SyncRecoveryActivity::class.java)) }
        refreshSendState(LocalStatusProducer.get(this).state.value)
        statusTextTask.start(MoteI18n.text("正在读取本机同步状态…"), {}, { MoteI18n.translations(SyncReadiness.obsoleteMessages) }) { outcome ->
            statusTranslations = outcome.getOrNull(); statusTranslationFailed = outcome.isFailure
            refreshSendState(LocalStatusProducer.get(this).state.value)
        }
        MoteUi.styleTree(body)
        updateTabs()
        task.start(MoteI18n.text("正在读取来源…"), { summary.text = it }, { localSources().sources() }) { result ->
            result.onSuccess {
                sources = it
                categories.adapter = MoteUi.choiceAdapter(this, listOf(MoteI18n.text("采集与记录")) + it.map { source -> source.name + if (source.enabled) "" else MoteI18n.text("（已暂停）") })
                intent.getStringExtra("sourceId")?.let { id -> sources.indexOfFirst { source -> source.id == id }.takeIf { it >= 0 }?.let { index -> categories.setSelection(index + 1) } }
                categories.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                    override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { if (!history) offset = 0; load() }
                }
                updateTabs()
                // A restored history tab hides the source spinner, which need not dispatch selection.
                load()
            }.onFailure { summary.text = MoteI18n.text("队列暂不可读，请重试"); summary.visibility = android.view.View.VISIBLE }
        }
    }
    private fun refreshSendState(state: LocalStateSnapshot) {
        if (!::sendStatus.isInitialized || !::pauseSend.isInitialized) return
        val settings = Settings(this); val config = settings.read()
        if (!actionTask.busy) {
            val status = settings.storedSyncStatus()
            val visible = SyncReadiness.visible(config, status, SyncSchedule.waitingReason(this, config), state.active, state.sourceIssues, state.pending,
                inventoryUnavailable = state.error != null, sourceUnavailable = state.sourceError, labelsReady = statusTranslations != null, labelsFailed = statusTranslationFailed) { source, value ->
                source == value || statusTranslations?.get(source)?.contains(value) == true
            }
            sendStatus.text = SyncReadiness.text(visible) + if (settings.syncRequestRejected()) "\n" + MoteI18n.text("配置已发生变化，请刷新后重试。") else ""
        }
        sendCount.text = state.active?.let { MoteI18n.text("本机保留 {0} 条 · 待发 {1} 条", it.records, state.pending ?: "—") } ?: state.imageLabel()
        sendingPaused = config.syncPaused
        pauseSend.text = MoteI18n.text(if (config.syncPaused) "恢复全部发送" else "暂停全部发送")
        pauseSend.isEnabled = !actionTask.busy
        sendNow.isEnabled = !actionTask.busy && !config.syncPaused && config.hasSyncConnection()
    }
    private fun changeSendState() {
        if (actionTask.busy) return
        val requestedPause = !sendingPaused
        pauseSend.isEnabled = false; sendNow.isEnabled = false
        actionTask.start(MoteI18n.text("正在保存发送状态…"), { sendStatus.text = it }, {
            SendPauseControl.set(applicationContext, requestedPause)
        }) { outcome ->
            refreshSendState(LocalStatusProducer.get(this).state.value)
            outcome.onFailure { sendStatus.text = it.message ?: MoteI18n.text("操作失败，请重试") }
        }
    }
    private fun requestSync() {
        if (actionTask.busy) return
        pauseSend.isEnabled = false; sendNow.isEnabled = false
        actionTask.start(MoteI18n.text("正在提交同步任务…"), { sendStatus.text = it }, {
            ConnectionGuard.sync {
                val config = Settings(applicationContext).read(); config.validateConnection()
                if (localSources().sources().any { it.enabled }) dev.mote.collector.plugins.SourceProviderPlugin.owner(applicationContext).schedule(manual = true, syncExplicit = true)
                else UploadWorker.schedule(applicationContext, config, true)
            } ?: error(MoteI18n.text("正在应用设置，请稍后重试"))
        }) { outcome ->
            refreshSendState(LocalStatusProducer.get(this).state.value)
            outcome.onFailure { sendStatus.text = it.message ?: MoteI18n.text("操作失败，请重试") }
            load()
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
        MoteUi.action(currentTab, MoteUi.ButtonRole.TEXT); MoteUi.action(historyTab, MoteUi.ButtonRole.TEXT)
        currentTab.paintFlags = if (!history) android.graphics.Paint.UNDERLINE_TEXT_FLAG else 0
        historyTab.paintFlags = if (history) android.graphics.Paint.UNDERLINE_TEXT_FLAG else 0
        historyBody.visibility = if (history) android.view.View.VISIBLE else android.view.View.GONE
        rows.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        summary.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        if (history) paging.visibility = android.view.View.GONE
        categories.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
        speed.visibility = if (history) android.view.View.GONE else android.view.View.VISIBLE
    }
    private fun sourceLabel(source: String) = when (source) {
        "screen" -> MoteI18n.text("屏幕采集"); "note" -> MoteI18n.text("记录"); "activity" -> MoteI18n.text("应用活动"); "media" -> MoteI18n.text("媒体播放"); "notification" -> MoteI18n.text("通知"); "device_event" -> MoteI18n.text("设备事件"); else -> source
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
            if (source == null) {
                val items = page.getJSONArray("items")
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i); val content = queue().capture(item.getString("id"))
                    val text = content?.optString("ocrText").orEmpty().trim()
                    item.put("displayTitle", text.lineSequence().firstOrNull()?.take(80).orEmpty()).put("preview", text.take(180))
                }
            }
            page to (SyncSchedule.waitingReason(this, Settings(this).read()) ?: Settings(this).uploadStatus())
        }) { result ->
            categories.isEnabled = true
            if (history) { refreshPending = false; load(); return@start }
            result.onSuccess { (page, reason) ->
                val total = page.getInt("total")
                summary.text = MoteI18n.text("共 {0} 条 · 第 {1} 页", total, offset / pageSize + 1)
                summary.visibility = if (total > pageSize || offset > 0) android.view.View.VISIBLE else android.view.View.GONE
                previous.isEnabled = offset > 0; next.isEnabled = offset + pageSize < total
                paging.visibility = if (total > pageSize || offset > 0) android.view.View.VISIBLE else android.view.View.GONE
                rows.removeAllViews()
                val items = page.getJSONArray("items")
                if (items.length() == 0) rows.addView(TextView(this).apply { text = MoteI18n.text("暂无待上传记录"); setPadding(0, moteDp(24), 0, moteDp(24)) })
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    val title = if (source == null) item.optString("displayTitle").ifBlank { item.optString("appName").ifBlank { sourceLabel(item.optString("source")) } } else item.optString("name")
                    val timestamp = if (source == null) java.time.Instant.parse(item.getString("capturedAt")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm")) else ""
                    val detail = listOf(item.optString("preview").takeIf { it.isNotBlank() && it != title }, listOf(if (source == null) sourceLabel(item.optString("source")) else source.name, timestamp).filter(String::isNotBlank).joinToString(" · "), item.getString("status")).filterNotNull().joinToString("\n")
                    SecondaryUi.row(rows, title, detail, icon = if (item.optString("source") == "note") "✎" else "▤") {
                        startActivity(if (source == null) Intent(this, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id")) else Intent(this, SourcesActivity::class.java).putExtra("detailSourceId", source.id))
                    }
                }
            }.onFailure { summary.text = MoteI18n.text("队列读取失败，记录保留。请刷新重试。"); summary.visibility = android.view.View.VISIBLE }
            if (refreshPending) { refreshPending = false; load() }
        }
    }
    private fun loadHistory() { historyPanel.load() }
}
