package dev.mote.collector

import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import org.json.JSONArray
import org.json.JSONObject

/** Product work comes from host receipts. Technical operations remain a separate secondary page. */
internal class CentralWorkActivity(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private var detailBody: LinearLayout? = null
    private val body get() = detailBody ?: screens.body
    private var state = "active"
    private var cursor = 0
    private val previous = mutableListOf<Int>()
    private var selected: String? = null
    private var section = "overview"
    private var branchCursor = 0
    private val branchPrevious = mutableListOf<Int>()
    private val memoryResults by lazy { CentralWorkMemoryResults(screens, { id->screens.isWorkActivityPage && selected==id && section=="results" }, { id->detail(id) }) }
    private fun enc(value: String) = CentralScreens.encode(value)
    private fun text(value: String, size: NativeFontRole = NativeFontRole.BODY, parent: LinearLayout = body) = ui.text(value, size, parent)
    private fun button(label: String, primary: Boolean = false, parent: LinearLayout = body, action: () -> Unit) = ui.button(label, primary, parent, action)
    fun show() { selected?.let { if(section=="results"&&memoryResults.hasSelection(it))memoryResults.showSelected(it) else detail(it) } ?: list() }
    fun clearPrivateState() { detailBody = null; rendered = ""; selected = null; section = "overview"; state = "active"; cursor = 0; previous.clear(); branchCursor = 0; branchPrevious.clear();memoryResults.clear() }
    fun saveState(out: Bundle) { out.putString("state", state); out.putString("selected", selected); out.putString("section", section); out.putInt("cursor", cursor); out.putInt("branchCursor", branchCursor); out.putIntegerArrayList("previous", ArrayList(previous)); out.putIntegerArrayList("branchPrevious", ArrayList(branchPrevious));out.putBundle("memoryResults",Bundle().also(memoryResults::save)) }
    fun restoreState(value: Bundle, allowMemoryResult: Boolean) {
        state = value.getString("state").takeIf { it in setOf("active", "attention", "completed") } ?: "active"
        section = value.getString("section").takeIf { it in setOf("overview", "work", "results", "evidence", "technical") } ?: "overview"
        selected = value.getString("selected"); cursor = value.getInt("cursor").coerceAtLeast(0); branchCursor = value.getInt("branchCursor").coerceAtLeast(0)
        previous.clear(); previous.addAll(value.getIntegerArrayList("previous").orEmpty().filter { it >= 0 }); branchPrevious.clear(); branchPrevious.addAll(value.getIntegerArrayList("branchPrevious").orEmpty().filter { it >= 0 })
        val memoryState=value.getBundle("memoryResults")
        if(allowMemoryResult)memoryState?.let(memoryResults::restore)
        else if(memoryState?.getString("memoryResultWork")!=null) { selected=null;section="overview" }
    }
    fun poll() { selected?.takeIf{section=="results"&&memoryResults.hasSelection(it)}?.let(memoryResults::poll) ?: show() }
    fun restoreMemoryAfterReader(work: String, scroll: Int) { if(selected==work && section=="results")memoryResults.restoreAfterReader(work,scroll) }
    fun retainMemoryForRecreation(work: String) { if(selected==work && section=="results")memoryResults.rememberDrafts() }
    private var rendered = ""
    private fun clear(key: String): Int {
        val scroll = screens.body.parent as? android.widget.ScrollView
        val position = if (rendered == key) scroll?.scrollY ?: 0 else 0
        rendered = key; detailBody = null; screens.body.removeAllViews()
        screens.body.post { scroll?.scrollTo(0, position) }
        return position
    }
    private fun list() {
        if (screens.body.childCount == 0) button(MoteI18n.text("重试")) { list() }
        val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/work-activity?state=$state&limit=10&cursor=$cursor") }) { page ->
            clear("list:$state:$cursor")
            text(MoteI18n.text("活动"), NativeFontRole.TITLE_MOBILE)
            text(MoteI18n.text("这里是 Mote 的后台工作：理解资料、导入、整理记忆与生成洞察。手机和电脑的应用使用情况在「资料库 → 应用活动」。"))
            val filters = LinearLayout(ui)
            listOf("active" to "进行中", "attention" to "需要处理", "completed" to "最近完成").forEach { (key, label) ->
                val action = button(MoteI18n.text(label), parent = filters) {
                    state = key; cursor = 0; previous.clear(); list()
                }
                action.isSelected = state == key
                MoteUi.textColor(action, if (state == key) NativeColorRole.ACCENT else NativeColorRole.MUTED)
                action.layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                action.setPadding(0, ui.moteDp(MoteTheme.spaceInline), 0, ui.moteDp(MoteTheme.spaceInline))
            }
            body.addView(filters)
            button(MoteI18n.text("刷新")) { list() }
            val items = page.optJSONArray("items") ?: JSONArray()
            if (items.length() == 0) text(MoteI18n.text(when (state) { "active" -> "目前没有正在进行的工作"; "attention" -> "目前没有需要处理的工作"; else -> "这里会显示已完成的工作" }))
            for (index in 0 until items.length()) {
                val work = items.getJSONObject(index)
                val row = ui.card()
                ui.selectRow(work.getString("goal"), MoteI18n.text(CentralWorkPresentation.state(work.getString("state"))), row) {
                    selected = work.getString("id"); section = "overview"; branchCursor = 0; branchPrevious.clear();memoryResults.clear(); detail(selected!!)
                }
                progress(work.getJSONObject("progress"), row, compact = true)
                text(work.optString("updatedAt"), NativeFontRole.META, row)
            }
            if (previous.isNotEmpty()) button(MoteI18n.text("上一页")) { cursor = previous.removeAt(previous.lastIndex); list() }
            if (!page.isNull("nextCursor")) button(MoteI18n.text("下一页")) { previous.add(cursor); cursor = page.getInt("nextCursor"); list() }
            ui.disclosure(MoteI18n.text("高级"), body) { target ->
                text(MoteI18n.text("查看底层执行记录，排查依赖与失败原因。"), parent = target)
                button(MoteI18n.text("技术执行记录"), parent = target) { ui.navigate("processing") }
            }
            WorkPolling.rearm(items, ui::scheduleActivityPoll)
        }
    }
    private fun detail(id: String) {
        if (screens.body.childCount == 0) button(MoteI18n.text("重试")) { detail(id) }
        val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { api.get("/api/work-activity/" + enc(id) + "?limit=20&cursor=$branchCursor") }) { work ->
            val previousScroll=clear("detail:$id:$section:$branchCursor"); screens.setBack { selected = null; section = "overview";memoryResults.clear(); list() }
            button(MoteI18n.text("返回活动")) { selected = null; section = "overview";memoryResults.clear(); screens.clearBack(); list() }
            button(MoteI18n.text("刷新")) { detail(id) }
            text(work.getString("goal"), NativeFontRole.TITLE_MOBILE)
            text(MoteI18n.text(CentralWorkPresentation.state(work.getString("state"))))
            progress(work.getJSONObject("progress"), body)
            val sections = listOf("overview" to "概览", "work" to "工作分支", "results" to "成果", "evidence" to "证据", "technical" to "技术详情")
            val split = NativeUiPacks.registry.layout().usesDetailPane(ui.resources.configuration.screenWidthDp)
            if (split) {
                val panes = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; tag = "work-detail:split" }
                val navigation = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
                val reading = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.moteDp(MoteTheme.spacePanel), 0, 0, 0) }
                sections.forEach { (key, label) -> button(MoteI18n.text(label), parent = navigation) { section = key; detail(id) }.isSelected = key == section }
                panes.addView(navigation, LinearLayout.LayoutParams(ui.moteDp(180), -2)); panes.addView(reading, LinearLayout.LayoutParams(0, -2, 1f))
                screens.body.addView(panes); detailBody = reading
            } else {
            val selection = android.widget.Spinner(ui).apply {
                contentDescription = MoteI18n.text("工作详情")
                adapter = MoteUi.choiceAdapter(ui, sections.map { MoteI18n.text(it.second) })
                setSelection(sections.indexOfFirst { it.first == section })
                onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                    override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, rowId: Long) {
                        if (section != sections[position].first) { section = sections[position].first; detail(id) }
                    }
                }
                MoteUi.select(this)
            }; body.addView(selection)
            }
            when (section) {
                "overview" -> overview(work)
                "work" -> branches(work)
                "results" -> results(work,previousScroll)
                "evidence" -> evidence(work)
                "technical" -> technical(work)
            }
            WorkPolling.rearm(work, ui::scheduleActivityPoll)
        }
    }
    private fun overview(work: JSONObject) {
        val counts = work.optJSONObject("branchCounts") ?: JSONObject()
        ui.selectRow(MoteI18n.text("工作分支"), MoteI18n.text("{0} 个分支正在进行", counts.optInt("running")), body) { section = "work"; detail(work.getString("id")) }
        val artifacts=work.getJSONArray("artifacts")
        val resultCount=if(work.optString("kind")=="memory" && artifacts.length()==1 && artifacts.optJSONObject(0)?.optString("ref")=="memories")
            artifacts.getJSONObject(0).optInt("count",0).coerceAtLeast(0) else artifacts.length()
        ui.selectRow(MoteI18n.text("成果"), MoteI18n.text("{0} 项已保存成果", resultCount), body) { section = "results"; detail(work.getString("id")) }
        ui.selectRow(MoteI18n.text("证据"), MoteI18n.text("{0} 条来源资料", work.getJSONObject("evidence").optInt("count")), body) { section = "evidence"; detail(work.getString("id")) }
        text(MoteI18n.text("最近进展"), NativeFontRole.SECTION)
        val events = work.optJSONArray("events") ?: JSONArray()
        for (index in 0 until events.length()) events.getJSONObject(index).let { event ->
            text(event.optString("at"), NativeFontRole.META)
            text(event.optString("summary").ifBlank { MoteI18n.text(CentralWorkPresentation.event(event.optString("type"))) })
        }
        related(work)
    }
    private fun branches(work: JSONObject) {
        text(MoteI18n.text("每个分支按自己的输入范围推进；完成状态由实际执行记录确认。"))
        val branches = work.optJSONArray("branches") ?: JSONArray()
        if (work.optJSONObject("branchCounts")?.optInt("total") == 0) text(MoteI18n.text("这项工作直接推进，目前没有独立分支。"))
        for (index in 0 until branches.length()) branches.getJSONObject(index).let { branch ->
            val card = ui.card(); text(branch.getString("title"), NativeFontRole.SECTION, card)
            text(MoteI18n.text(CentralWorkPresentation.state(branch.getString("state"))), parent = card)
            branch.optJSONObject("progress")?.let { progress(it, card) }
            if ((branch.optJSONArray("artifactIds")?.length() ?: 0) > 0) text(MoteI18n.text("{0} 项已保存成果", branch.getJSONArray("artifactIds").length()), parent = card)
        }
        if (branchPrevious.isNotEmpty()) button(MoteI18n.text("上一页")) { branchCursor = branchPrevious.removeAt(branchPrevious.lastIndex); detail(work.getString("id")) }
        if (!work.isNull("branchesNextCursor")) button(MoteI18n.text("下一页")) { branchPrevious.add(branchCursor); branchCursor = work.getInt("branchesNextCursor"); detail(work.getString("id")) }
    }
    private fun results(work: JSONObject, previousScroll: Int) {
        if(work.optString("kind")=="memory") {
            val results = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
            body.addView(results)
            memoryResults.render(work.getString("id"),results,previousScroll,WorkPolling.live(work.getString("state")))
            return
        }
        val artifacts = work.optJSONArray("artifacts") ?: JSONArray()
        if (artifacts.length() == 0) text(MoteI18n.text("成果确认保存后会出现在这里。"))
        for (index in 0 until artifacts.length()) artifacts.getJSONObject(index).let { artifact ->
            val card = ui.card(); text(artifact.getString("title"), NativeFontRole.SECTION, card)
            artifact.optString("summary").takeIf { it.isNotBlank() }?.let { text(it, parent = card) }
            button(MoteI18n.text("查看成果"), parent = card) {
                val href = artifact.optString("href")
                val conversation = if (href.startsWith("#/ask?")) Uri.parse("https://mote.invalid/" + href.removePrefix("#/" )).getQueryParameter("conversation") else null
                if (!conversation.isNullOrBlank()) conversation(conversation, work.getString("id"))
                else relatedDestination(work.getString("destination"))
            }
        }
    }
    private fun evidence(work: JSONObject) {
        val evidence = work.getJSONObject("evidence")
        text(MoteI18n.text("共 {0} 条来源资料。展开原文或查看 Agent 实际读取的内容。", evidence.optInt("count")))
        val refs = evidence.optJSONArray("refs") ?: JSONArray()
        for (index in 0 until refs.length()) button(MoteI18n.text("来源资料 {0}", index + 1)) { screens.openWorkEvidence(refs.getString(index)) }
        if (evidence.optInt("count") > refs.length()) text(MoteI18n.text("这里只列出前 {0} 条资料；完整范围可在相关资料中查看。", refs.length()))
        button(MoteI18n.text("查看 Agent 实际输入")) { ui.navigate("agentView") }
    }
    private fun technical(work: JSONObject) {
        text(MoteI18n.text("技术执行记录、尝试次数与依赖用于排查问题。"))
        button(MoteI18n.text("技术执行记录")) { ui.navigate("processing") }
        button(MoteI18n.text("Agent 读取轨迹")) { ui.navigate("agentView") }
        ui.disclosure(MoteI18n.text("原始 Operation"), body) { target ->
            val ids = work.getJSONObject("technical").optJSONArray("operationIds") ?: JSONArray()
            for (index in 0 until ids.length()) text(ids.getString(index), parent = target)
        }
    }
    private fun related(work: JSONObject) = button(MoteI18n.text("打开相关资料与操作")) { relatedDestination(work.getString("destination")) }
    private fun relatedDestination(destination: String) {
        // The product DTO is explicit routing metadata. Unknown routes do not become intents or URLs.
        ui.openWorkDestination(CentralWorkPresentation.destination(destination, CentralScreens.pages.map { it.first }.toSet()))
    }
    private fun conversation(id: String, workId: String, cursor: String? = null) {
        val api = screens.client
        ui.work(MoteI18n.text("正在读取对话…"), { api.get("/api/conversations/" + enc(id) + "?limit=20" + (cursor?.let { "&cursor=" + enc(it) } ?: "")) }) { value ->
            clear("conversation:$id:$cursor"); screens.setBack { detail(workId) }
            text(MoteI18n.text("成果"), NativeFontRole.TITLE_MOBILE)
            val turns = value.getJSONArray("turns")
            for (index in 0 until turns.length()) turns.getJSONObject(index).let { turn ->
                text(turn.optString("question"), NativeFontRole.SECTION)
                val presentation = CentralConversationPresentation.read(turn)
                presentation.notice?.let { text(it) }
                presentation.result?.let { answer ->
                    text(answer.optString("answer"))
                    val refs = answer.optJSONArray("citations") ?: JSONArray()
                    for (citation in 0 until refs.length()) refs.getJSONObject(citation).let { ref ->
                        text(ref.optString("excerpt")); button(MoteI18n.text("查看原文依据")) { screens.openConversationEvidence(id, ref.getString("id")) { screens.openWorkEvidence(ref.getString("id"),id) } }
                    }
                }
            }
            CentralScreens.next(value)?.let { older -> button(MoteI18n.text("加载更早的对话")) { conversation(id, workId, older) } }
        }
    }
    private fun progress(value: JSONObject, target: LinearLayout, compact: Boolean = false) {
        text(CentralWorkPresentation.progress(value), parent = target)
        if (value.optString("mode") == "determinate" && value.optInt("total") > 0) target.addView(ProgressBar(ui, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = value.getInt("total"); progress = value.getInt("completed"); progressTintList = ColorStateList.valueOf(MoteTheme.accent)
            contentDescription = MoteI18n.text("资料处理进度")
        }, LinearLayout.LayoutParams(-1, ui.moteDp(4)))
        if (!compact && value.optString("mode") == "semantic" && value.has("returnedItems")) text(MoteI18n.text("检索已返回 {0} 项资料", value.optInt("returnedItems")), NativeFontRole.META, target)
    }
}

internal object CentralWorkPresentation {
    fun destination(value: String, pages: Set<String>): String {
        val page = if (value == "library") "archive" else value
        require(page in pages) { MoteI18n.text("资料不存在或已删除。") }
        return page
    }
    fun state(value: String): String = mapOf("waiting" to "等待开始", "running" to "正在进行", "needs_input" to "需要处理", "completed" to "已完成", "failed" to "未能完成", "cancelled" to "已停止", "stale" to "资料变化，需要重新检查", "excluded" to "按设置跳过")[value] ?: value
    fun event(value: String): String = mapOf("work.started" to "工作已开始", "plan.updated" to "工作计划已更新", "branch.started" to "工作分支已开始", "branch.completed" to "工作分支已完成", "branch.replanned" to "已调整工作分支", "artifact.created" to "已保存工作成果", "work.needs_input" to "工作需要补充", "work.completed" to "工作已完成", "work.failed" to "工作未能完成", "work.cancelled" to "工作已停止")[value] ?: value
    fun progress(value: JSONObject): String = if (value.optString("mode") == "determinate") MoteI18n.text("已处理 {0} / {1} 条资料", value.optInt("completed"), value.optInt("total"))
        else value.optString("summary").ifBlank { MoteI18n.text(mapOf("preparing" to "准备资料", "planning" to "组织工作", "searching" to "查找资料", "checking" to "交叉核对", "organizing" to "整理结果", "saving" to "保存成果", "finished" to "工作完成")[value.optString("stage")] ?: value.optString("stage")) }
}
