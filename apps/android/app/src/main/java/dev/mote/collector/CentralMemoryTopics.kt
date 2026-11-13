package dev.mote.collector

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ArrayAdapter
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.LinearLayout
import android.widget.TextView
import android.text.Editable
import android.text.TextWatcher
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject
import java.net.URLEncoder

/** Literal search terms are display highlights, never a memory classification. */
internal object MemorySearchHighlight {
    data class Match(val start: Int, val endExclusive: Int)

    fun matches(text: String, query: String): List<Match> {
        val terms = query.trim().split(Regex("\\s+")).filter(String::isNotBlank).take(12)
        val found = mutableListOf<Match>()
        for (term in terms) {
            var from = 0
            while (from <= text.length - term.length) {
                val start = text.indexOf(term, from, ignoreCase = true)
                if (start < 0) break
                found.add(Match(start, start + term.length))
                from = start + term.length
            }
        }
        val merged = mutableListOf<Match>()
        for (match in found.sortedWith(compareBy<Match> { it.start }.thenBy { it.endExclusive })) {
            val previous = merged.lastOrNull()
            if (previous != null && match.start <= previous.endExclusive) {
                merged[merged.lastIndex] = Match(previous.start, maxOf(previous.endExclusive, match.endExclusive))
            } else merged.add(match)
        }
        return merged
    }
}

internal object MemoryBrowseCriteria {
    fun select(navigation: MemoryTopicNavigation, value: String) {
        when (value) {
            "personal" -> navigation.choose("topics", "personal")
            "event" -> navigation.choose("knowledge", "episodic")
            else -> navigation.choose("topics")
        }
    }
    fun path(navigation: MemoryTopicNavigation, query: String, history: Boolean): String = buildString {
        append(navigation.path())
        if (navigation.nodeId == null) append("&level=detail")
        if (query.isNotBlank()) append("&query=").append(URLEncoder.encode(query.trim().take(500), "UTF-8"))
        if (history) append("&includeHistory=true")
    }
}

/** Native consumer of host-generated references. It never classifies or grants model access. */
internal class CentralMemoryTopics(
    private val screens: CentralScreens,
    private val controls: (LinearLayout, Boolean) -> Unit,
    private val statusLabel: (JSONObject) -> String,
    private val openMemory: (String, () -> Unit, (JSONObject) -> Boolean) -> Unit,
) {
    private val ui get() = screens.ui
    private val body get() = screens.body
    private var navigation = MemoryTopicNavigation()
    private var catalog: MemoryTopicCatalog? = null
    private var generation = 0L
    private val detail = MemoryTopicDetailGuard()
    private var invalidated = false
    private var query = ""
    private var kind = "all"
    private var history = false
    private var loadVersion = 0L
    private var searchTask: Runnable? = null
    private var peopleMode = false
    private var peopleCursor: String? = null
    private var peopleSignature: String? = null
    private fun scrollView() = body.parent as? ScrollView
    fun clear() { invalidated = false; detail.clear(); generation++; loadVersion++; searchTask?.let(body::removeCallbacks); navigation = MemoryTopicNavigation(); catalog = null; query = ""; kind = "all"; history = false; peopleMode = false; peopleCursor = null; peopleSignature = null }
    fun save(out: Bundle) { if (navigation.selectedMemory == null) navigation.scroll = scrollView()?.scrollY ?: 0; out.putString("navigation", navigation.save().toString()); out.putString("query", query); out.putString("kind", kind); out.putBoolean("history", history); out.putBoolean("people", peopleMode) }
    fun restore(value: Bundle) { runCatching { navigation.restore(JSONObject(value.getString("navigation") ?: "{}")); query = value.getString("query").orEmpty().take(500); kind = value.getString("kind").orEmpty().takeIf { it in setOf("all", "personal", "event") } ?: "all"; history = value.getBoolean("history"); peopleMode = value.getBoolean("people") }.onFailure { clear() } }
    fun show() {
        invalidated = false; peopleCursor = null; peopleSignature = null
        if (peopleMode) { showPeople(); return }
        val stamp = ++generation; val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { runCatching { MemoryTopicCatalog.read(api.get("/api/context-trees")) } }) { result ->
            if (stamp != generation) return@work
            result.onSuccess { directory ->
                catalog = directory
                if (!navigation.valid(directory)) unavailable()
                else navigation.selectedMemory?.let { id ->
                    openMemory(id, { detail.clear(); navigation.returnToList(); screens.refresh() }) { row ->
                        if (stamp != generation || navigation.selectedMemory != id) false
                        else if (detail.accept(id, row)) true else { detailUnavailable(); false }
                    }
                } ?: list(directory)
            }.onFailure(::failure)
            ui.scheduleMemoryTopicsPoll()
        }
    }
    fun poll() {
        if (invalidated) return
        if (peopleMode) { pollPeople(); return }
        val stamp = generation; val api = screens.client; val selected = navigation.selectedMemory
        ui.work("", { runCatching {
            val directory = MemoryTopicCatalog.read(api.get("/api/context-trees"))
            directory to selected?.let { api.get("/api/memories/" + it) }
        } }) { result ->
            if (stamp != generation) return@work
            result.onSuccess { (directory, memory) ->
                if (selected != navigation.selectedMemory) return@onSuccess
                if (selected != null && memory != null && !detail.current(selected, memory)) { detailUnavailable(); return@onSuccess }
                val changed = catalog != directory; catalog = directory
                if (!navigation.valid(directory)) unavailable()
                else if (changed && navigation.selectedMemory == null) { navigation.scroll = scrollView()?.scrollY ?: 0; list(directory) }
            }.onFailure(::failure)
            ui.scheduleMemoryTopicsPoll()
        }
    }
    private fun showPeople(cursor: String? = null) {
        val stamp = ++generation; val api = screens.client
        ui.work(MoteI18n.text("正在读取…"), { runCatching {
            val page = api.get(MemoryPeoplePresentation.path(cursor))
            val groups = MemoryPeoplePresentation.groups(page)
            groups.map { person -> person to MemoryPeoplePresentation.person(api, person.memoryId) }
                .filter { (_, memory) -> memory != null } to page
        } }) { result ->
            if (stamp != generation) return@work
            result.onSuccess { (found, page) ->
                body.removeAllViews(); screens.setBack { peopleMode = false; peopleCursor = null; show() }
                peopleMode = true; peopleCursor = cursor; peopleSignature = found.joinToString("|") { (person, _) -> person.signature }
                body.setPadding(ui.moteDp(16), 0, ui.moteDp(16), ui.moteDp(24))
                ui.text(MoteI18n.text("人物"), NativeFontRole.TITLE_MOBILE)
                ui.text(MoteI18n.text("按已关联的记忆身份浏览；同名人物分别保留。"), NativeFontRole.SUPPORT)
                val target = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
                body.addView(target)
                if (found.isEmpty()) ui.text(MoteI18n.text("本页暂无已关联的人物。可继续浏览记忆或主题。"), parent = target)
                else {
                    val group = MoteComponents.group(ui); target.addView(group)
                    found.forEachIndexed { index, (person, nullableMemory) ->
                        val memory = nullableMemory ?: return@forEachIndexed
                        if (index > 0) group.addView(MoteComponents.divider(ui))
                        val row = LinearLayout(ui).apply {
                            orientation = LinearLayout.VERTICAL; minimumHeight = ui.moteDp(60)
                            setPadding(ui.moteDp(14), ui.moteDp(10), ui.moteDp(14), ui.moteDp(10))
                            background = MoteUi.clickable(ui, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
                            tag = "person-memory:" + person.memoryId; isFocusable = true
                        }
                        row.addView(TextView(ui).apply { text = memory.optString("title"); MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
                        memory.optString("statement").takeIf(String::isNotBlank)?.let { statement ->
                            row.addView(TextView(ui).apply { text = statement; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); maxLines = 2 })
                        }
                        row.addView(TextView(ui).apply {
                            text = MemoryPeoplePresentation.stateLabel(memory) + " · " + MoteI18n.text("本页 {0} 条承诺", person.commitmentCount) +
                                " · " + MoteI18n.text("本页关联 {0} 个事项", person.matterCount)
                            MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED)
                        })
                        row.contentDescription = memory.optString("title") + "，" + MemoryPeoplePresentation.stateLabel(memory)
                        row.setOnClickListener {
                            openMemory(person.memoryId, { peopleMode = true; showPeople(cursor) }) { current -> current.optString("id") == person.memoryId }
                        }
                        MemoryPeoplePresentation.replacement(memory)?.let { current ->
                            ui.button(MoteI18n.text("查看替代版本"), parent = row) {
                                openMemory(current, { peopleMode = true; showPeople(cursor) }) { value -> value.optString("id") == current }
                            }
                        }
                        group.addView(row)
                    }
                }
                val next = page.optString("nextCursor").takeIf { it.isNotBlank() && it != "null" }
                if (cursor != null) ui.button(MoteI18n.text("返回第一页"), parent = target) { peopleCursor = null; showPeople() }
                if (next != null) ui.button(MoteI18n.text("下一页"), parent = target) { peopleCursor = next; showPeople(next) }
                ui.button(MoteI18n.text("刷新"), parent = target) { showPeople(cursor) }
                ui.scheduleMemoryTopicsPoll()
            }.onFailure(::failure)
        }
    }
    private fun pollPeople() {
        if (invalidated) return
        val stamp = generation
        ui.work("", { runCatching { MemoryPeoplePresentation.groups(screens.client.get(MemoryPeoplePresentation.path(null))) } }) { result ->
            if (stamp != generation) return@work
            val signature = result.getOrNull()?.joinToString("|") { it.signature }
            if (peopleCursor == null && signature != null && signature != peopleSignature) showPeople()
            else ui.scheduleMemoryTopicsPoll()
        }
    }
    private fun list(directory: MemoryTopicCatalog) {
        searchTask?.let(body::removeCallbacks); searchTask = null
        body.removeAllViews(); screens.clearBack()
        body.setPadding(ui.moteDp(16), 0, ui.moteDp(16), ui.moteDp(24))
        var more: View? = null
        fun filters() = LibraryBrowseUi.filters(ui, listOf("all" to "全部记忆", "personal" to "个人记忆", "event" to "事件记忆"), kind,
            { value -> kind = value; MemoryBrowseCriteria.select(navigation, value); list(directory) },
            history = history to { enabled -> history = enabled; navigation.first(); list(directory) },
            manage = {
                val section = more as? LinearLayout
                val trigger = section?.getChildAt(0)
                val content = section?.getChildAt(1)
                if (content?.visibility == View.VISIBLE) { trigger?.performClick(); section.visibility = View.GONE }
                else { section?.visibility = View.VISIBLE; trigger?.performClick() }
            })
        ui.memoryLibraryHeader(::filters)
        ui.text(MoteI18n.text("资料与记忆"), NativeFontRole.TITLE_MOBILE).setPadding(ui.moteDp(4), 0, 0, ui.moteDp(12))
        body.addView(LibraryBrowseUi.tabs(ui, "memories") { selected -> if (selected == "materials") ui.openLibraryMaterials() }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = ui.moteDp(10) })
        ui.button(MoteI18n.text("人物"), parent = body) { peopleMode = true; showPeople() }.tag = "memory-people"
        val search = LibraryBrowseUi.search(ui, "搜索记忆", query)
        body.addView(search, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = ui.moteDp(16) })
        val target = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
        body.addView(target)
        fun highlighted(text: String): CharSequence = SpannableString(text).apply {
            MemorySearchHighlight.matches(text, query).forEach { match ->
                setSpan(BackgroundColorSpan(NativeColorRole.TINT.color()), match.start, match.endExclusive, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                setSpan(ForegroundColorSpan(NativeColorRole.ACCENT.color()), match.start, match.endExclusive, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        var moreTrigger: View? = null
        fun readPage() {
            val api = screens.client; val stamp = generation; val version = ++loadVersion
            val path = MemoryBrowseCriteria.path(navigation, query, history)
            val needsDetail = navigation.nodeId != null
            ui.work(MoteI18n.text("正在读取记忆…"), { runCatching {
                val page = api.get(path)
                if (needsDetail) {
                    val items = page.getJSONArray("items")
                    for (index in 0 until items.length()) {
                        val overview = items.getJSONObject(index)
                        val full = api.get("/api/memories/" + CentralScreens.encode(overview.getString("id")))
                        check(full.getString("id") == overview.getString("id") && full.getInt("version") == overview.getInt("version") && full.getString("fingerprint") == overview.getString("revision")) { MoteI18n.text("记忆版本暂不可用。") }
                        items.put(index, full)
                    }
                }
                page
            } }) { result ->
                if (stamp != generation || version != loadVersion) return@work
                result.onSuccess { page ->
                    target.removeAllViews(); val rows = page.getJSONArray("items")
                    if (rows.length() == 0) ui.text(MoteI18n.text("当前筛选下没有匹配的记忆。可切换内容分类或调整筛选条件。"), parent = target)
                    else {
                        val group = MoteComponents.group(ui); target.addView(group)
                        for (index in 0 until rows.length()) {
                            if (index > 0) group.addView(MoteComponents.divider(ui))
                            val row = rows.getJSONObject(index); val id = row.getString("id")
                            val title = row.getString("title"); val statement = row.getString("statement")
                            val item = LinearLayout(ui).apply {
                                orientation = LinearLayout.VERTICAL; minimumHeight = ui.moteDp(60)
                                setPadding(ui.moteDp(14), ui.moteDp(10), ui.moteDp(14), ui.moteDp(10))
                                background = MoteUi.clickable(ui, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
                                tag = "topic-memory:$id"; isFocusable = true; contentDescription = "$title，$statement"
                                setOnClickListener { navigation.scroll = scrollView()?.scrollY ?: 0; detail.clear(); navigation.selectMemory(id); screens.refresh() }
                            }
                            item.addView(TextView(ui).apply { text = highlighted(title); MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
                            item.addView(TextView(ui).apply { text = highlighted(statement); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); maxLines = 2 })
                            if (history && (row.optString("supersededBy").isNotBlank() || row.optString("validUntil").isNotBlank())) item.addView(TextView(ui).apply { text = statusLabel(row); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) })
                            group.addView(item)
                        }
                    }
                    if (navigation.canGoBack) ui.button(MoteI18n.text("上一页"), parent = target) { navigation.previous(); readPage() }
                    CentralScreens.next(page)?.let { cursor -> ui.button(MoteI18n.text("下一页"), parent = target) { navigation.next(cursor); readPage() } }
                    scrollView()?.post { scrollView()?.scrollTo(0, navigation.scroll) }
                }.onFailure { error ->
                    if (error is CentralFailure && error.status == 409) navigation.first()
                    failure(error)
                }
                ui.scheduleMemoryTopicsPoll()
            }
        }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                val next = s?.toString().orEmpty().take(500)
                if (next == query) return
                query = next; navigation.first(); loadVersion++
                searchTask?.let(body::removeCallbacks)
                searchTask = Runnable { readPage() }.also { body.postDelayed(it, 300) }
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        search.setOnEditorActionListener { _, _, _ -> searchTask?.let(body::removeCallbacks); readPage(); true }
        readPage()
        more = ui.disclosure(MoteI18n.text("更多")) { management ->
            controls(management, true)
            ui.text(MoteI18n.text("记忆主题"), NativeFontRole.SECTION, management)
            ui.text(MoteI18n.text(when (directory.state) {
                "unavailable" -> "自动主题服务尚未就绪；已有记忆仍可浏览。"
                "running" -> "正在整理自动主题…"
                "failed" -> "自动主题整理未完成；已有记忆仍可浏览。"
                else -> if (directory.trees.any { it.id.startsWith("auto.") }) "主题是模型整理的浏览视图，不代表新的用户事实。" else "尚无自动主题；仍可浏览全部记忆和已有维度。"
            }), parent = management)
            if (directory.trees.isNotEmpty()) {
                val tree = directory.trees.find { it.id == navigation.treeId } ?: directory.trees.first()
                val choices = Spinner(ui).apply {
                    contentDescription = MoteI18n.text("浏览维度")
                    adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, directory.trees.map { it.label })
                    setSelection(directory.trees.indexOf(tree))
                }; management.addView(choices)
                ui.button(MoteI18n.text("浏览维度"), parent = management) { navigation.choose(directory.trees[choices.selectedItemPosition].id); screens.refresh() }
                ui.button(MoteI18n.text("全部记忆"), parent = management) { navigation.choose(tree.id); screens.refresh() }
                tree.nodes.forEach { node -> ui.button((if (node.parentId != null) "  " else "") + node.label, parent = management) { navigation.choose(tree.id, node.id); screens.refresh() }.tag = "memory-topic:${tree.id}:${node.id}" }
            }
            ui.button(MoteI18n.text("刷新"), parent = management) { screens.refresh() }
        }
        moreTrigger = (more as? LinearLayout)?.getChildAt(0)
        moreTrigger?.visibility = View.GONE
        more?.visibility = View.GONE
    }
    private fun edits(): List<Pair<MemoryTopicEdit, String>> {
        fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
        return children(body).filterIsInstance<EditText>().mapNotNull { field -> (field.tag as? MemoryTopicEdit)?.takeIf { it.initial != field.text.toString() }?.let { it to field.text.toString() } }
    }
    private fun preserveEdits(values: List<Pair<MemoryTopicEdit, String>>) {
        if (values.isEmpty()) return
        ui.text(MoteI18n.text("有未保存的更改"), NativeFontRole.SECTION)
        values.forEach { (edit, value) -> ui.field(edit.label, value, multiline = true).tag = edit }
    }
    private fun unavailable() {
        val drafts = edits(); invalidated = true; generation++; detail.clear(); ui.enterDetail();
        body.removeAllViews(); navigation.returnToList(); screens.clearBack()
        ui.text(MoteI18n.text("此主题已不可用，请返回全部记忆。")); preserveEdits(drafts)
        ui.button(MoteI18n.text("全部记忆")) { navigation.choose("topics"); screens.refresh() }
    }
    private fun detailUnavailable() {
        val drafts = edits(); invalidated = true; generation++; detail.clear(); navigation.returnToList(); ui.enterDetail(); body.removeAllViews(); screens.clearBack()
        ui.text(MoteI18n.text("所选记忆已变化，请刷新后重新选择。")); preserveEdits(drafts)
        ui.button(MoteI18n.text("全部记忆")) { navigation.choose("topics"); screens.refresh() }
    }
    private fun failure(error: Throwable) {
        // A transport outage must not destroy an in-progress owner correction.
        if (navigation.selectedMemory != null && !(error is CentralFailure && error.status in setOf(401, 403, 404, 410))) { ui.notice(error.message ?: MoteI18n.text("操作失败")); return }
        val drafts = edits(); invalidated = true; generation++; detail.clear(); ui.enterDetail(); screens.clearBack()
        body.removeAllViews(); ui.notice(error.message ?: MoteI18n.text("操作失败"))
        if (error is CentralFailure && error.status in setOf(401, 403, 404, 410)) { catalog = null; navigation.returnToList() }
        preserveEdits(drafts)
        ui.button(MoteI18n.text("重试")) { screens.refresh() }
        ui.button(MoteI18n.text("全部记忆")) { navigation.choose("topics"); screens.refresh() }
    }
}
