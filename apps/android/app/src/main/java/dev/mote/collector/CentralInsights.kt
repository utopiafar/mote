package dev.mote.collector

import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject

/** Saved result IDs and job IDs have separate routes and separate navigation state. */
internal class CentralInsights(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private var mode = "history"
    private var selected: String? = null
    private var runId: String? = null
    private var cursors = mutableListOf<String?>(null)
    private var historyScroll = 0
    private var detailScroll = 0
    private var prompt = ""
    private var report: JSONObject? = null
    private var lastRun = ""
    private var evidenceRef: String? = null
    private var resumeValidation = false
    fun select(id: String) { require(InsightPresentation.validId(id)); selected = id; mode = "detail"; detailScroll = 0; report = null }
    fun clear() { selected = null; runId = null; report = null; prompt = ""; evidenceRef = null; mode = "history"; cursors = mutableListOf(null); lastRun = ""; historyScroll = 0; detailScroll = 0; resumeValidation = false }
    fun pause() { resumeValidation = true }
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
        out.putString("evidence", evidenceRef)
        out.putStringArrayList("cursors", ArrayList(cursors.map { it.orEmpty() })); out.putInt("historyScroll", historyScroll); out.putInt("detailScroll", detailScroll)
    }
    fun restore(value: Bundle) {
        selected = value.getString("selected")?.takeIf(InsightPresentation::validId); runId = value.getString("runId")?.takeIf(InsightPresentation::validId)
        mode = value.getString("mode").takeIf { it in setOf("history", "detail", "create", "run", "evidence") } ?: "history"
        evidenceRef = value.getString("evidence")?.takeIf { CentralEvidenceReference.captureId(it) != null }
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
        ui.text(MoteI18n.text("发现历史"), NativeFontRole.TITLE_MOBILE)
        ui.button(MoteI18n.text("新建洞察")) { historyScroll = ui.contentScroll(); mode = "create"; screens.refresh() }
        val target = ui.card()
        ui.button(MoteI18n.text("刷新")) { loadHistory(target) }
        loadHistory(target)
        ui.disclosure(MoteI18n.text("生成任务")) { jobs ->
            val api = screens.client
            ui.work(MoteI18n.text("正在读取…"), { runCatching { api.get("/api/insight-runs") } }) { outcome ->
                outcome.onSuccess { page ->
                    val items = page.optJSONArray("items") ?: JSONArray()
                    for (i in 0 until items.length()) {
                        val item = items.getJSONObject(i)
                        ui.button(InsightPresentation.runLabel(item.optString("status")) + " · " + item.optString("createdAt"), parent = jobs) { runId = item.getString("id"); mode = "run"; lastRun = ""; screens.refresh() }
                    }
                }.onFailure { failure(it, jobs) }
            }
        }
    }
    private fun loadHistory(target: LinearLayout) {
        val cursor = cursors.last(); val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { runCatching { api.get("/api/insights?limit=30" + (cursor?.let { "&cursor=" + CentralScreens.encode(it) } ?: "")) } }) { outcome ->
            outcome.onSuccess { page ->
                target.removeAllViews()
                val items = page.optJSONArray("items") ?: JSONArray()
                if (items.length() == 0) ui.text(MoteI18n.text("第一份洞察会保存在这里，之后可以随时回看。"), parent = target)
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i); val id = InsightPresentation.id(item) ?: continue
                    val card = ui.card(target)
                    ui.text(InsightPresentation.title(item), NativeFontRole.SECTION, card); ui.text(InsightPresentation.preview(item), parent = card)
                    ui.text(item.optString("createdAt") + " · " + (item.optJSONArray("citations")?.length() ?: 0) + " " + MoteI18n.text("条证据"), NativeFontRole.SUPPORT, card)
                    ui.button(MoteI18n.text("查看发现"), parent = card) { historyScroll = ui.contentScroll(); select(id); screens.refresh() }.tag = "insight:$id"
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
        ui.text(InsightPresentation.title(value), NativeFontRole.TITLE_MOBILE)
        ui.text(value.optString("createdAt"), NativeFontRole.SUPPORT)
        ui.text(InsightPresentation.answer(value))
        value.optJSONObject("snapshot")?.let { snapshot ->
            ui.disclosure(MoteI18n.text("资料范围与覆盖")) { target ->
                ui.text(MoteI18n.text("资料截止时间") + " · " + snapshot.optString("asOf"), parent = target)
                ui.text(MoteI18n.text("采样不能证明实际工作时长。"), parent = target)
                CentralAdmin(screens).values(snapshot, target)
            }
        }
        ui.text(MoteI18n.text("查看依据"), NativeFontRole.SECTION)
        val citations = value.optJSONArray("citations") ?: JSONArray()
        if (citations.length() == 0) ui.text(MoteI18n.text("这份报告没有可引用的记录；内容需要进一步核实。"))
        for (i in 0 until citations.length()) {
            val citation = citations.getJSONObject(i); val id = citation.optString("id")
            val card = ui.card(); ui.text(citation.optString("appName") + " · " + citation.optString("contentAt", citation.optString("capturedAt")), parent = card)
            ui.text(citation.optString("excerpt"), parent = card)
            ui.button(MoteI18n.text("查看原文依据"), parent = card) { detailScroll = ui.contentScroll(); evidenceRef = CentralEvidenceReference.capture(id); mode = "evidence"; screens.openWorkEvidence(evidenceRef!!) }
        }
        ui.button(MoteI18n.text("刷新")) { readReport() }
        ui.disclosure(MoteI18n.text("生成信息与检索过程")) { target -> CentralAdmin(screens).values(JSONObject().put("runId", value.optString("runId")).put("trace", value.optJSONArray("trace") ?: JSONArray()), target) }
        ui.restoreContentScroll(detailScroll)
    }
    private fun compose() {
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
            if (error.status in setOf(401, 403)) body.removeAllViews() else target?.removeAllViews()
            report = null
        }
        ui.requestFailure(error)
        if (body.childCount == 0 && mode in setOf("detail", "run")) ui.button(MoteI18n.text("重试")) { if (mode == "run") readRun() else readReport() }
    }
}
