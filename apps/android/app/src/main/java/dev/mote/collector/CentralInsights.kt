package dev.mote.collector

import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.widget.LinearLayout
import android.widget.TextView
import android.view.View
import android.view.Gravity
import android.text.SpannableString
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.TextPaint
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import org.json.JSONArray
import org.json.JSONObject

/** Saved result IDs and job IDs have separate routes and separate navigation state. */
internal class CentralInsights(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private var activeDialog: android.app.AlertDialog? = null
    private fun showOwnedDialog(builder: android.app.AlertDialog.Builder): android.app.AlertDialog { activeDialog?.dismiss(); return builder.show().also { activeDialog = it } }
    private var mode = "history"
    private var selected: String? = null
    private var runId: String? = null
    private var cursors = mutableListOf<String?>(null)
    private var historyScroll = 0
    private var detailScroll = 0
    private var prompt = ""
    private var report: JSONObject? = null
    private var formatted = true
    private var lastRun = ""
    private var evidenceRef: String? = null
    private var resumeValidation = false
    fun select(id: String) { require(InsightPresentation.validId(id)); selected = id; mode = "detail"; detailScroll = 0; report = null; formatted = true }
    fun clear() { activeDialog?.dismiss(); activeDialog = null; selected = null; runId = null; report = null; prompt = ""; evidenceRef = null; mode = "history"; cursors = mutableListOf(null); lastRun = ""; historyScroll = 0; detailScroll = 0; resumeValidation = false }
    fun pause() { activeDialog?.dismiss(); activeDialog = null; resumeValidation = true }
    fun resume() { if (resumeValidation) {
        resumeValidation = false
        when (mode) {
            "detail" -> readReport()
            "run" -> readRun()
            "history" -> { historyScroll = ui.contentScroll(); screens.refresh() }
            "evidence" -> { body.removeAllViews(); show() }
        }
    } }
    fun returnFromEvidence() { if (mode == "evidence") { mode = "detail"; evidenceRef = null; report = null } }
    fun save(out: Bundle) {
        if (mode == "detail") detailScroll = ui.contentScroll() else if (mode == "history") historyScroll = ui.contentScroll()
        out.putString("mode", mode); out.putString("selected", selected); out.putString("runId", runId); out.putString("prompt", prompt)
        out.putString("evidence", evidenceRef); out.putBoolean("formatted",formatted)
        out.putStringArrayList("cursors", ArrayList(cursors.map { it.orEmpty() })); out.putInt("historyScroll", historyScroll); out.putInt("detailScroll", detailScroll)
    }
    fun restore(value: Bundle) {
        selected = value.getString("selected")?.takeIf(InsightPresentation::validId); runId = value.getString("runId")?.takeIf(InsightPresentation::validId)
        mode = value.getString("mode").takeIf { it in setOf("history", "detail", "create", "run", "evidence") } ?: "history"
        evidenceRef = value.getString("evidence")?.takeIf { CentralEvidenceReference.captureId(it) != null }
        formatted = value.getBoolean("formatted",true)
        prompt = value.getString("prompt").orEmpty().take(8000)
        cursors = value.getStringArrayList("cursors")?.map { it.takeIf(String::isNotBlank) }?.toMutableList()?.takeIf { it.isNotEmpty() } ?: mutableListOf(null)
        historyScroll = value.getInt("historyScroll"); detailScroll = value.getInt("detailScroll")
    }
    fun show() { when {
        mode == "evidence" && evidenceRef != null -> { screens.setBack { returnFromEvidence(); screens.refresh() }; screens.openWorkEvidence(evidenceRef!!) }
        mode == "detail" && selected != null -> detail()
        mode == "create" -> compose()
        mode == "run" && runId != null -> run()
        else -> history()
    } }
    private fun backToHistory() { selected = null; report = null; mode = "history"; screens.refresh() }
    private fun history() {
        ui.insightChrome("发现历史") { historyMore() }
        val target = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }.also(body::addView)
        loadHistory(target)
    }
    private fun historyMore() {
        val labels = listOf("新建洞察", "生成任务", "刷新", "资料与记忆")
        showOwnedDialog(MoteDialogBuilder(ui).setTitle(MoteI18n.text("更多")).setItems(labels.map { MoteI18n.text(it) }.toTypedArray()) { _, index -> when(index) {
            0 -> { historyScroll = ui.contentScroll(); mode = "create"; screens.refresh() }
            1 -> showJobs()
            2 -> screens.refresh()
            else -> ui.insightNavigation()
        } })
    }
    private fun showJobs() {
        val target = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.moteDp(20),0,ui.moteDp(20),0) }
        val dialog = showOwnedDialog(MoteDialogBuilder(ui).setTitle(MoteI18n.text("生成任务")).setView(android.widget.ScrollView(ui).apply { addView(target) }).setNegativeButton(MoteI18n.text("关闭"),null))
        val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { runCatching { api.get("/api/insight-runs") } }) { outcome ->
            outcome.onSuccess { page ->
                val items = page.optJSONArray("items") ?: JSONArray()
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    ui.button(InsightPresentation.runLabel(item.optString("status")) + " · " + date(item.optString("createdAt")), parent = target) {
                        dialog.dismiss(); runId = item.getString("id"); mode = "run"; lastRun = ""; screens.refresh()
                    }
                }
            }.onFailure { failure(it,target) }
        }
    }
    private fun date(value: String) = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM,FormatStyle.SHORT).withLocale(MoteI18n.locale())) }.getOrDefault(value)
    private fun citations(value: JSONObject): List<JSONObject> {
        val rows = value.optJSONArray("citations") ?: JSONArray()
        return (0 until rows.length()).map { rows.getJSONObject(it) }.distinctBy { it.getString("id") }
    }
    private fun preview(value: JSONObject): String = InsightPresentation.preview(JSONObject().put("answer",NativeAnswerPresentation.format(value.optString("answer"),emptyList()).text).put("citations",value.optJSONArray("citations")?:JSONArray()))
    private fun meta(value: JSONObject): String = listOf(MoteI18n.text("发现"),date(value.optString("createdAt").ifBlank { value.optJSONObject("artifact")?.optString("createdAt").orEmpty() }),MoteI18n.text("{0} 份依据",citations(value).size)).filter(String::isNotBlank).joinToString(" · ")
    private fun divider(parent: LinearLayout) { parent.addView(View(ui).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },LinearLayout.LayoutParams(-1,ui.moteDp(1))) }
    private fun loadHistory(target: LinearLayout) {
        val cursor = cursors.last(); val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { runCatching { api.get("/api/insights?limit=30" + (cursor?.let { "&cursor=" + CentralScreens.encode(it) } ?: "")) } }) { outcome ->
            outcome.onSuccess { page ->
                target.removeAllViews()
                val items = page.optJSONArray("items") ?: JSONArray()
                if (items.length() == 0) ui.text(MoteI18n.text("第一份洞察会保存在这里，之后可以随时回看。"), parent = target)
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i); val id = InsightPresentation.id(item) ?: continue
                    val row = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0,ui.moteDp(18),0,ui.moteDp(18)); minimumHeight = ui.moteDp(64); isFocusable = true; tag = "insight:$id"; background = MoteUi.clickable(ui,NativeColorRole.BACKGROUND,0,false)
                        setOnClickListener { if (!ui.isWorking) { historyScroll = ui.contentScroll(); select(id); screens.refresh() } } }
                    val labels = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }.also { row.addView(it,LinearLayout.LayoutParams(0,-2,1f)) }
                    ui.text(InsightPresentation.title(item), NativeFontRole.ROW, labels)
                    ui.text(preview(item),NativeFontRole.SUPPORT,labels).also { MoteUi.textColor(it,NativeColorRole.MUTED) }
                    ui.text(meta(item),NativeFontRole.META,labels).also { MoteUi.textColor(it,NativeColorRole.MUTED) }
                    row.addView(MoteComponents.icon(ui, MoteGlyph.CHEV, NativeColorRole.MUTED, 20),
                        LinearLayout.LayoutParams(ui.moteDp(20), ui.moteDp(20)))
                    target.addView(row,LinearLayout.LayoutParams(-1,-2)); divider(target)
                }
                if (cursors.size > 1) ui.button(MoteI18n.text("上一页"), parent = target) { cursors.removeAt(cursors.lastIndex); historyScroll = 0; screens.refresh() }
                CentralScreens.next(page)?.let { next -> ui.button(MoteI18n.text("下一页"), parent = target) { cursors.add(next); historyScroll = 0; screens.refresh() } }
                ui.restoreContentScroll(historyScroll)
            }.onFailure { error ->
                if (error is CentralFailure && error.status == 409) { target.removeAllViews(); cursors = mutableListOf(null); historyScroll = 0; ui.notice(error.message.orEmpty()); loadHistory(target) }
                else { failure(error, target); if (target.childCount == 0) ui.button(MoteI18n.text("重试"), parent = target) { loadHistory(target) } }
            }
        }
    }
    private fun detail() {
        screens.setBack { backToHistory() }
        report?.let(::drawReport)
        readReport()
    }
    private fun readReport() {
        val id = selected ?: return; val api = screens.client
        ui.work(if (report == null) MoteI18n.text("正在读取…") else "", { runCatching { api.get("/api/insights/" + CentralScreens.encode(id)) } }) { outcome ->
            outcome.onSuccess { value ->
                require(InsightPresentation.id(value) == id)
                if (report?.toString() != value.toString()) { if (report != null) detailScroll = ui.contentScroll(); report = value; body.removeAllViews(); drawReport(value) }
            }.onFailure { error ->
                if (error is CentralFailure && error.status in setOf(401, 403, 404, 410)) {
                    report = null; body.removeAllViews()
                    ui.text(MoteI18n.text("这份洞察当前不可用，请从历史选择其他洞察。"))
                    ui.button(MoteI18n.text("发现历史")) { backToHistory() }
                }
                failure(error)
            }
            ui.scheduleInsightPoll()
        }
    }
    private fun drawReport(value: JSONObject) {
        ui.insightChrome("发现") { reportMore(value) }
        ui.text(InsightPresentation.title(value), NativeFontRole.TITLE_MOBILE)
        ui.text(meta(value),NativeFontRole.SUPPORT).apply { tag = "insight-meta"; MoteUi.textColor(this,NativeColorRole.MUTED) }
        val rows = citations(value); val answer = value.optString("answer")
        val content = ui.text("").apply { tag = "insight-content"; setTextIsSelectable(true); setLineSpacing(0f,1.3f); movementMethod = LinkMovementMethod.getInstance() }
        val display = NativeAnswerPresentation.format(answer,rows.map { it.getString("id") })
        content.text = SpannableString(display.text).apply {
            if (formatted) display.emphasis.forEach { mark -> setSpan(android.text.style.StyleSpan(if (mark.bold) android.graphics.Typeface.BOLD else android.graphics.Typeface.ITALIC),mark.start,mark.end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            display.citations.forEach { mark -> setSpan(object : ClickableSpan() {
                override fun onClick(widget: View) { if (!ui.isWorking) openCitation(value.getString("runId"),mark.id) }
                override fun updateDrawState(paint: TextPaint) { paint.color = MoteUi.accent; paint.isUnderlineText = false }
            },mark.start,mark.end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        }
        ui.text(MoteI18n.text("原文依据"),NativeFontRole.SECTION)
        if (rows.isEmpty()) ui.text(MoteI18n.text("这份报告没有可引用的记录；内容需要进一步核实。"))
        rows.forEachIndexed { index, citation ->
            val row = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = ui.moteDp(52); setPadding(0,ui.moteDp(12),0,ui.moteDp(12)); isFocusable = true; tag = "insight-citation:"+citation.getString("id"); contentDescription = MoteI18n.text("查看引用 {0}",index+1)+" · "+citation.optString("appName"); background = MoteUi.clickable(ui,NativeColorRole.BACKGROUND,0,false)
                setOnClickListener { if (!ui.isWorking) openCitation(value.getString("runId"),citation.getString("id")) } }
            row.addView(TextView(ui).apply { text = (index+1).toString(); MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED) },LinearLayout.LayoutParams(ui.moteDp(28),-2))
            val labels = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }.also { row.addView(it,LinearLayout.LayoutParams(0,-2,1f)) }
            ui.text(citation.optString("title").ifBlank { citation.optString("appName").ifBlank { MoteI18n.text("原始记录") } },NativeFontRole.SUPPORT,labels)
            ui.text(date(citation.optString("contentAt",citation.optString("capturedAt"))),NativeFontRole.META,labels).also { MoteUi.textColor(it,NativeColorRole.MUTED) }
            row.addView(MoteComponents.icon(ui, MoteGlyph.CHEV, NativeColorRole.MUTED, 20),
                LinearLayout.LayoutParams(ui.moteDp(20), ui.moteDp(20)))
            body.addView(row,LinearLayout.LayoutParams(-1,-2)); divider(body)
        }
        ui.restoreContentScroll(detailScroll)
    }
    private fun openCitation(reportId: String, evidenceId: String) {
        val api = screens.client; detailScroll = ui.contentScroll()
        ui.work(MoteI18n.text("正在读取…"), { runCatching { api.get("/api/insights/"+CentralScreens.encode(reportId)) } }) { outcome ->
            outcome.onSuccess { fresh ->
                require(InsightPresentation.id(fresh) == reportId && citations(fresh).any { it.getString("id") == evidenceId })
                if (selected != reportId || mode != "detail") return@onSuccess
                report = fresh; evidenceRef = null
                screens.openWorkEvidence(CentralEvidenceReference.capture(evidenceId))
            }.onFailure { error ->
                if (error is CentralFailure && error.status in setOf(401,403,404,410)) { report = null; body.removeAllViews(); ui.text(MoteI18n.text("这份洞察当前不可用，请从历史选择其他洞察。")); ui.button(MoteI18n.text("发现历史")) { backToHistory() } }
                failure(error)
            }
        }
    }
    private fun reportMore(value: JSONObject) {
        val labels = listOf("排版结果", "标准阅读", "资料范围与覆盖", "生成信息与检索过程", "刷新", "资料与记忆")
        showOwnedDialog(MoteDialogBuilder(ui).setTitle(MoteI18n.text("显示方式")).setSingleChoiceItems(labels.map { MoteI18n.text(it) }.toTypedArray(),if(formatted)0 else 1) { dialog, index ->
            dialog.dismiss()
            when(index) {
                0,1 -> { detailScroll = ui.contentScroll(); formatted = index == 0; body.removeAllViews(); drawReport(value) }
                2,3 -> { val content = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.moteDp(20),0,ui.moteDp(20),0) }
                    if(index==2) value.optJSONObject("snapshot")?.let { CentralAdmin(screens).values(it,content) }
                    else CentralAdmin(screens).values(JSONObject().put("runId",value.optString("runId")).put("trace",value.optJSONArray("trace")?:JSONArray()),content)
                    showOwnedDialog(MoteDialogBuilder(ui).setTitle(MoteI18n.text(labels[index])).setView(android.widget.ScrollView(ui).apply { addView(content) }).setPositiveButton(MoteI18n.text("关闭"),null)) }
                4 -> readReport()
                else -> ui.insightNavigation()
            }
        })
    }
    private fun compose() {
        ui.insightChrome("生成回顾") { ui.insightNavigation() }
        screens.setBack { backToHistory() }
        val field = ui.field(MoteI18n.text("洞察要求（可选）"), prompt, multiline = true).apply { filters = arrayOf(InputFilter.LengthFilter(8000)) }
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { prompt = s?.toString().orEmpty() }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        val generate = ui.button(MoteI18n.text("生成洞察"), true) { submit(prompt.trim()) }
        ui.work(MoteI18n.text("正在读取…"), { screens.pendingInsightRequest() }) { pending ->
            if (pending.has("requestId")) {
                generate.isEnabled = false
                ui.text(MoteI18n.text("上次提交结果尚未确认；先重试原要求，当前草稿会保留。"))
                ui.text(pending.optString("prompt"))
                ui.button(MoteI18n.text("重试上次提交")) { submit(pending.optString("prompt")) }
            }
        }
    }
    private fun submit(instruction: String) {
            val api = screens.client
            ui.work(MoteI18n.text("正在生成洞察…"), { runCatching {
                try { api.post("/api/insight-runs", screens.insightRequest(instruction)).also { screens.insightAccepted() } }
                catch (error: CentralFailure) { if (error.status in setOf(400, 404, 409, 422)) screens.insightAccepted(); throw error }
            } }) { outcome -> outcome.onSuccess { job -> runId = job.getString("id"); mode = "run"; lastRun = ""; screens.refresh() }.onFailure { failure(it) } }
    }
    private fun run() {
        ui.insightChrome("生成任务") { ui.insightNavigation() }
        screens.setBack { backToHistory() }; lastRun = ""; readRun()
    }
    private fun readRun() {
        val id = runId ?: return; val api = screens.client
        ui.work("", { runCatching { api.get("/api/insight-runs/" + CentralScreens.encode(id)) } }) { outcome ->
            outcome.onSuccess { job ->
                if (lastRun != job.toString()) {
                    lastRun = job.toString(); body.removeAllViews(); ui.text(InsightPresentation.runLabel(job.optString("status")), NativeFontRole.TITLE_MOBILE)
                    job.optJSONObject("error")?.let { ui.text(it.optString("message")) }
                    val resultId = job.optJSONObject("result")?.let(InsightPresentation::id)
                    if (resultId != null) ui.button(MoteI18n.text("查看发现")) { select(resultId); screens.refresh() }
                    else if (job.optString("status") == "completed") ui.text(MoteI18n.text("这份报告已因原始资料变化而失效，请重新生成回顾。"))
                    if (job.optString("status") == "running") ui.button(MoteI18n.text("停止")) {
                        ui.work(MoteI18n.text("正在处理…"), { runCatching { api.post("/api/insight-runs/" + CentralScreens.encode(id) + "/cancel", JSONObject()) } }) { cancelled -> cancelled.onSuccess { lastRun = ""; readRun() }.onFailure { failure(it) } }
                    }
                    ui.button(MoteI18n.text("刷新")) { readRun() }
                    ui.disclosure(MoteI18n.text("查看详情")) { CentralAdmin(screens).values(job, it) }
                }
                if (job.optString("status") == "running") ui.scheduleInsightPoll(1500)
            }.onFailure { error -> failure(error); ui.scheduleInsightPoll() }
        }
    }
    fun poll() { if (mode == "detail") readReport() else if (mode == "run") readRun() }
    private fun failure(error: Throwable, target: LinearLayout? = null) {
        if (error is CentralFailure && error.status in setOf(401, 403, 404, 410)) {
            activeDialog?.dismiss(); activeDialog = null
            if (error.status in setOf(401, 403)) body.removeAllViews() else target?.removeAllViews()
            report = null
        }
        ui.requestFailure(error)
        if (body.childCount == 0 && mode in setOf("detail", "run")) ui.button(MoteI18n.text("重试")) { if (mode == "run") readRun() else readReport() }
    }
}
