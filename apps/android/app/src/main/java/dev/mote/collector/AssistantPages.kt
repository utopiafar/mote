package dev.mote.collector

import android.content.Intent
import android.view.ViewGroup
import android.widget.LinearLayout
import dev.mote.collector.plugins.AssistantPlugin
import dev.mote.collector.plugins.PluginViewContribution
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject

/** U6 pages in the existing Central shell. Only IDs, scope and a page cursor
 * survive a view; CentralStateFile owns encrypted pending acceptance commands. */
internal class AssistantPages(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private var container: LinearLayout? = null
    private var panel: AssistantPanel? = null
    private var matterId: String? = null
    private var matterScope = allScope()
    private var cursor: String? = null
    private var route = AssistantPlugin.FEED_ROUTE

    fun save() = JSONObject().put("matterId", matterId).put("scope", matterScope.json()).put("cursor", cursor)
    fun restore(value: JSONObject) {
        matterId = value.optString("matterId").takeIf { MoteLink.uuidId(it) == it }
        matterScope = value.optJSONObject("scope")?.let(::AssistantScope) ?: allScope()
        cursor = AssistantJson.optional(value, "cursor")
    }
    fun clear() { dispose(); matterId = null; matterScope = allScope(); cursor = null }
    fun selectMatter(id: String, scope: AssistantScope) { require(MoteLink.uuidId(id) == id); matterId = id; matterScope = scope }

    fun mount(page: String, parent: ViewGroup): PluginViewContribution {
        dispose()
        route = page
        val body = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
        parent.addView(body)
        container = body
        if (page == AssistantPlugin.FEED_ROUTE) feed() else matters()
        return object : PluginViewContribution {
            override val routeId = page
            override fun dispose() {
                if (container === body) this@AssistantPages.dispose()
                (body.parent as? ViewGroup)?.removeView(body)
            }
        }
    }
    private fun dispose() { panel?.close(); panel = null; container?.removeAllViews(); container = null }
    private fun reset(): LinearLayout? {
        panel?.close(); panel = null
        return container?.also { it.removeAllViews() }
    }
    private fun current(): () -> Boolean {
        val visit = ui.readVisit(); val origin = ui.server; val generation = ui.currentAccessGeneration
        val owner = AssistantPlugin.owner(ui)
        return {
            visit() && container != null && owner.active && runCatching { CentralAccess.resolve(ui) }.getOrNull()?.let { access ->
                access.server == origin && access.generation == generation && access.client != null
            } == true
        }
    }
    private fun api(scope: AssistantScope) = CentralAssistant(screens.client, scope, AssistantHttpBindings(screens.client))
    private fun mountPanel(view: AssistantPanel, body: LinearLayout) {
        panel = view
        body.addView(view, LinearLayout.LayoutParams(-1, -2))
        view.refresh()
    }
    private fun feed() {
        val body = reset() ?: return
        screens.clearBack()
        ui.detailTitle(MoteI18n.text("动态与建议"))
        ui.button(MoteI18n.text("事项与规则"), parent = body) {
            matterId = null; ui.navigate(AssistantPlugin.MATTERS_ROUTE)
        }
        val api = api(allScope()); val store = screens.stateFile("assistant-feed")
        val valid = current()
        // The constructor reads pending state on a worker, never the UI thread.
        ui.work(MoteI18n.text("正在读取…"), {
            AssistantFeedViewModel(api, { CentralDraftWrites.barrier(store::read) }, { value -> CentralDraftWrites.barrier { store.write(value) } })
        }) { model ->
            if (valid()) mountPanel(AssistantFeedView(ui.hostActivity(), model, valid, ::open), body)
        }
    }
    private fun matters() {
        val selected = matterId
        if (selected != null) { matter(selected, matterScope); return }
        val body = reset() ?: return
        screens.clearBack()
        ui.detailTitle(MoteI18n.text("事项与规则"))
        ui.button(MoteI18n.text("动态与建议"), parent = body) { ui.navigate(AssistantPlugin.FEED_ROUTE) }
        ui.button(MoteI18n.text("刷新"), parent = body) { matters() }
        val api = api(allScope()); val valid = current()
        ui.work(MoteI18n.text("正在读取…"), { api.matters(cursor) }) { page ->
            if (!valid()) return@work
            val items = AssistantJson.rows(page, "items") { row ->
                Triple(AssistantJson.id(row), AssistantJson.string(row, "goal"), AssistantScope(row.getJSONObject("scope")))
            }
            if (items.isEmpty()) ui.text(MoteI18n.text("暂无记录"), parent = body)
            for ((id, goal, scope) in items) body.addView(MoteComponents.row(ui, title = goal, subtitle = scope.description(), onClick = {
                if (valid()) { selectMatter(id, scope); matters() }
            }))
            AssistantJson.cursor(page)?.let { next -> ui.button(MoteI18n.text("下一页"), parent = body) { cursor = next; matters() } }
            if (cursor != null) ui.button(MoteI18n.text("返回"), parent = body) { cursor = null; matters() }
        }
    }
    private fun matter(id: String, scope: AssistantScope) {
        val body = reset() ?: return
        screens.setBack { matterId = null; matters() }
        ui.detailTitle(MoteI18n.text("事项与规则"))
        ui.button(MoteI18n.text("返回"), parent = body) { matterId = null; matters() }
        val model = AssistantMatterViewModel(api(scope), id)
        mountPanel(AssistantMatterView(ui.hostActivity(), model, current(), ::open), body)
    }
    private fun open(destination: AssistantOpen) {
        when (destination) {
            is AssistantOpen.Matter -> {
                selectMatter(destination.id, destination.scope)
                ui.navigate(AssistantPlugin.MATTERS_ROUTE)
            }
            is AssistantOpen.Evidence -> screens.openWorkEvidence(destination.ref)
            is AssistantOpen.Task -> {
                val body = reset() ?: return
                screens.setBack { if (route == AssistantPlugin.FEED_ROUTE) feed() else matters() }
                ui.detailTitle(MoteI18n.text("任务状态"))
                ui.button(MoteI18n.text("返回"), parent = body) { if (route == AssistantPlugin.FEED_ROUTE) feed() else matters() }
                mountPanel(AssistantTaskView(ui.hostActivity(), api(destination.scope), destination.id, current(), ::open), body)
            }
            is AssistantOpen.Question -> {
                val api = api(destination.scope); val valid = current()
                ui.work(MoteI18n.text("正在读取…"), {
                    AssistantJson.rows(api.questions(destination.workId), "items", AssistantQuestionLink::read)
                        .single { it.id == destination.id && it.workId == destination.workId }
                }) {
                    if (valid()) ui.startActivity(Intent(ui.hostActivity(), CentralActivity::class.java).putExtra("link",
                        MoteLink.serialize(MoteLink.Scope(ui.server), MoteLink.Route.Run(destination.workId))))
                }
            }
        }
    }
    companion object { private fun allScope() = AssistantScope(JSONObject().put("kind", "all")) }
}

internal fun CentralScreens.mountAssistant(page: String, container: ViewGroup): PluginViewContribution = assistantPages().mount(page, container)
