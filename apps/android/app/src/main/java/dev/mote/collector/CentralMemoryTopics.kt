package dev.mote.collector

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ArrayAdapter
import android.widget.ScrollView
import android.widget.Spinner
import org.json.JSONObject

/** Native consumer of host-generated references. It never classifies or grants model access. */
internal class CentralMemoryTopics(
    private val screens: CentralScreens,
    private val controls: () -> Unit,
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
    private fun scrollView() = body.parent as? ScrollView
    fun clear() { invalidated = false; detail.clear(); generation++; navigation = MemoryTopicNavigation(); catalog = null }
    fun save(out: Bundle) { if (navigation.selectedMemory == null) navigation.scroll = scrollView()?.scrollY ?: 0; out.putString("navigation", navigation.save().toString()) }
    fun restore(value: Bundle) { runCatching { navigation.restore(JSONObject(value.getString("navigation") ?: "{}")) }.onFailure { clear() } }
    fun show() {
        invalidated = false
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
    private fun list(directory: MemoryTopicCatalog) {
        body.removeAllViews(); screens.clearBack(); controls()
        ui.text(MoteI18n.text("记忆主题"), NativeFontRole.TITLE_MOBILE)
        ui.text(MoteI18n.text(when (directory.state) {
            "unavailable" -> "自动主题服务尚未就绪；已有记忆仍可浏览。"
            "running" -> "正在整理自动主题…"
            "failed" -> "自动主题整理未完成；已有记忆仍可浏览。"
            else -> if (directory.trees.any { it.id.startsWith("auto.") }) "主题是模型整理的浏览视图，不代表新的用户事实。" else "尚无自动主题；仍可浏览全部记忆和已有维度。"
        }))
        if (directory.trees.isNotEmpty()) {
            val tree = directory.trees.find { it.id == navigation.treeId } ?: directory.trees.first()
            val choices = Spinner(ui).apply {
                contentDescription = MoteI18n.text("浏览维度")
                adapter = ArrayAdapter(ui, android.R.layout.simple_spinner_dropdown_item, directory.trees.map { it.label })
                setSelection(directory.trees.indexOf(tree))
            }; body.addView(choices)
            ui.button(MoteI18n.text("浏览维度")) { navigation.choose(directory.trees[choices.selectedItemPosition].id); screens.refresh() }
            ui.button(MoteI18n.text("全部记忆")) { navigation.choose(tree.id); screens.refresh() }
            tree.nodes.forEach { node -> ui.button((if (node.parentId != null) "  " else "") + node.label) { navigation.choose(tree.id, node.id); screens.refresh() }.tag = "memory-topic:${tree.id}:${node.id}" }
        }
        ui.button(MoteI18n.text("刷新")) { screens.refresh() }
        val target = ui.card(); val api = screens.client; val stamp = generation
        ui.work(MoteI18n.text("正在读取记忆…"), { runCatching { api.get(navigation.path()) } }) { result ->
            if (stamp != generation) return@work
            result.onSuccess { page ->
                target.removeAllViews(); val rows = page.getJSONArray("items")
                if (rows.length() == 0) ui.text(MoteI18n.text("当前筛选下没有匹配的记忆。可切换内容分类或调整筛选条件。"), parent = target)
                for (index in 0 until rows.length()) {
                    val row = rows.getJSONObject(index); val id = row.getString("id"); val card = ui.card(target)
                    ui.text(row.getString("title"), NativeFontRole.SECTION, card)
                    ui.text(statusLabel(row) + " · " + row.optInt("evidenceCount", row.optJSONArray("evidenceIds")?.length() ?: 0) + " " + MoteI18n.text("条证据"), parent = card)
                    ui.button(MoteI18n.text("查看详情"), parent = card) { navigation.scroll = scrollView()?.scrollY ?: 0; detail.clear(); navigation.selectMemory(id); screens.refresh() }.tag = "topic-memory:$id"
                }
                if (navigation.canGoBack) ui.button(MoteI18n.text("上一页"), parent = target) { navigation.previous(); screens.refresh() }
                CentralScreens.next(page)?.let { cursor -> ui.button(MoteI18n.text("下一页"), parent = target) { navigation.next(cursor); screens.refresh() } }
                scrollView()?.post { scrollView()?.scrollTo(0, navigation.scroll) }
            }.onFailure { error ->
                if (error is CentralFailure && error.status == 409) { navigation.first(); failure(error) } else failure(error)
            }
            ui.scheduleMemoryTopicsPoll()
        }
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
