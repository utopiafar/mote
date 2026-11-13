package dev.mote.collector

import android.content.Intent
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Spinner
import dev.mote.collector.plugins.AssistantActionItem
import dev.mote.collector.plugins.AssistantActionResults
import dev.mote.collector.plugins.AssistantActionResultsReader
import dev.mote.collector.plugins.AssistantActionTarget
import dev.mote.collector.plugins.PluginViewContribution
import dev.mote.collector.plugins.WorkspaceDecode
import dev.mote.collector.plugins.WorkspaceLabels
import dev.mote.collector.plugins.WorkspaceTemplate
import dev.mote.collector.plugins.WorkspaceView
import org.json.JSONArray
import org.json.JSONObject

/** The Android consumer of U5's existing workbench envelope. It renders the
 * same strictly-parsed declarative spec into the native container, sends only
 * the exact producer-issued command references, and keeps A11 action results
 * attached to their matter. No Web code, remote script or second template
 * language participates. */
internal class AssistantWorkbench(private val screens: CentralScreens) {
    private val ui get() = screens.ui
    private var container: LinearLayout? = null
    private var template = WorkspaceTemplate.PROJECT
    private var target: String? = null
    private var current: WorkspaceView? = null
    private var generation = 0
    private var actionsGeneration = 0
    private var busy = false
    private var notice: String? = null

    fun mount(body: LinearLayout) {
        container = body
        current = null
        show()
    }

    fun dispose() {
        generation++
        actionsGeneration++
        container = null
        current = null
        busy = false
    }

    fun resume() {
        if (container != null) load()
    }

    fun clear() {
        generation++
        actionsGeneration++
        target = null
        template = WorkspaceTemplate.PROJECT
        current = null
        busy = false
        notice = null
    }

    private fun body(): LinearLayout? = container

    private fun requestJson(): JSONObject = JSONObject().put("template", template.wire).put("scope", JSONObject().put("kind", "all")).also { request ->
        if (template == WorkspaceTemplate.PERSON) target?.let { request.put("personMemoryId", it) }
        else target?.let { request.put("matterId", it) }
    }

    private fun label(key: String): String = MoteI18n.text(WorkspaceLabels.label(key))

    private fun show() {
        val body = body() ?: return
        body.removeAllViews()
        ui.text(MoteI18n.text("工作台"), NativeFontRole.TITLE_MOBILE, body)
        ui.text(label("limited"), NativeFontRole.META, body)
        load()
    }

    private fun load() {
        val body = body() ?: return
        val api = screens.client
        val stamp = ++generation
        busy = true
        ui.work(MoteI18n.text("正在读取工作台…"), { runCatching { api.get(workspacePath()) } }) { result ->
            if (stamp != generation || body !== container) return@work
            busy = false
            val raw = result.getOrNull()
            if (raw == null) {
                notice = result.exceptionOrNull()?.message ?: label("failed")
                render(body)
                return@work
            }
            try {
                val decoded = WorkspaceDecode.read(raw)
                current = decoded
                if (decoded.request.template == WorkspaceTemplate.PERSON) target = decoded.request.personMemoryId ?: target
                else target = decoded.request.matterId ?: target
                render(body)
            } catch (error: Exception) {
                notice = label("failed")
                render(body)
            }
        }
    }

    private fun workspacePath(): String = "/api/assistant/workbench?request=" + CentralScreens.encode(requestJson().toString())

    private fun render(body: LinearLayout) {
        body.removeAllViews()
        ui.text(MoteI18n.text("工作台"), NativeFontRole.TITLE_MOBILE, body)
        ui.text(label("limited"), NativeFontRole.META, body)
        renderTemplates(body)
        val view = current
        if (view == null) {
            ui.text(notice ?: MoteI18n.text("正在读取…"), parent = body)
            ui.button(MoteI18n.text("刷新"), parent = body) { load() }
            return
        }
        renderTarget(body, view)
        notice?.let { ui.text(it, parent = body) }
        body.addView(ui.declarativePluginView(
            view.spec,
            WorkspaceLabels.present(view.data, ::label),
            { key -> label(key) },
            { busy },
            { command, input -> execute(view, command, input) },
            { itemKey, row -> openItem(itemKey, row) },
        ))
        notice = null
        loadActions(body, view)
    }

    private fun renderTemplates(body: LinearLayout) {
        val tabs = LinearLayout(ui).apply { orientation = LinearLayout.HORIZONTAL; tag = "workbench-templates" }
        WorkspaceTemplate.entries.forEachIndexed { index, candidate ->
            val button = MoteUi.button(Button(ui).apply {
                text = label(candidate.wire)
                isSelected = candidate == template
                contentDescription = label(candidate.wire)
                setOnClickListener {
                    if (busy || candidate == template) return@setOnClickListener
                    template = candidate
                    target = null
                    current = null
                    load()
                }
            }, primary = candidate == template)
            tabs.addView(button, LinearLayout.LayoutParams(0, -2, 1f).apply {
                marginStart = ui.moteDp(if (index == 0) 0 else MoteTheme.spaceInline / 2)
                marginEnd = ui.moteDp(if (index == WorkspaceTemplate.entries.lastIndex) 0 else MoteTheme.spaceInline / 2)
            })
        }
        body.addView(tabs, LinearLayout.LayoutParams(-1, -2).apply { topMargin = ui.moteDp(MoteTheme.spaceInline) })
    }

    private fun renderTarget(body: LinearLayout, view: WorkspaceView) {
        val key = if (view.request.template == WorkspaceTemplate.PERSON) "memories" else "matters"
        val rows = view.data.optJSONArray(key) ?: JSONArray()
        val choices = mutableListOf<String>()
        val ids = mutableListOf<String?>()
        choices += MoteI18n.text("当前范围"); ids += null
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            val id = row.optString("id").takeIf(String::isNotBlank) ?: continue
            choices += row.optString("title").ifBlank { id }; ids += id
        }
        if (target != null && !ids.contains(target)) { choices += MoteI18n.text("当前选择"); ids += target }
        val selected = ids.indexOf(target).let { if (it < 0) 0 else it }
        val spinner = Spinner(ui).apply {
            contentDescription = label(view.request.template.wire)
            adapter = MoteUi.choiceAdapter(ui, choices)
            setSelection(selected)
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, selectedView: android.view.View?, position: Int, id: Long) {
                    if (busy) return
                    val next = ids.getOrNull(position)
                    if (next == target) return
                    target = next
                    current = null
                    load()
                }
            }
        }
        body.addView(spinner, LinearLayout.LayoutParams(-1, -2).apply { topMargin = ui.moteDp(MoteTheme.spaceInline) })
    }

    private fun execute(view: WorkspaceView, command: String, input: JSONObject) {
        if (busy) return
        val reference = try { view.command(command) } catch (error: IllegalArgumentException) {
            notice = error.message ?: label("changed")
            body()?.let(::render)
            return
        }
        val api = screens.client
        val stamp = generation
        busy = true
        val payload = JSONObject().put("request", view.request.json()).put("command", reference.json()).put("input", input)
        ui.work(MoteI18n.text("正在保存…"), { runCatching { api.post("/api/assistant/workbench/commands", payload) } }) { result ->
            if (stamp != generation) return@work
            busy = false
            val raw = result.getOrNull()
            if (raw == null) {
                val error = result.exceptionOrNull()
                notice = if ((error as? CentralFailure)?.status == 409) label("changed") else error?.message ?: label("failed")
                load()
                return@work
            }
            try {
                val next = WorkspaceDecode.read(raw)
                current = next
                if (next.request.template == template) target = when (template) {
                    WorkspaceTemplate.PERSON -> next.request.personMemoryId ?: target
                    else -> next.request.matterId ?: target
                }
                body()?.let(::render)
            } catch (error: Exception) {
                notice = label("failed")
                load()
            }
        }
    }

    private fun openItem(itemKey: String, row: JSONObject) {
        if (busy) return
        when (itemKey) {
            "matters" -> {
                if (template == WorkspaceTemplate.PERSON) return
                val id = row.optString("id").takeIf(String::isNotBlank) ?: return
                if (id == target) return
                target = id; current = null; load()
            }
            "memories" -> {
                if (template != WorkspaceTemplate.PERSON) return
                val id = row.optString("id").takeIf(String::isNotBlank) ?: return
                if (id == target) return
                target = id; current = null; load()
            }
            "files" -> {
                val id = row.optString("id").takeIf(String::isNotBlank) ?: return
                if (!MoteLink.uuidId(id).isNullOrBlank()) screens.openWorkEvidence("capture:$id")
            }
            "evidence" -> {
                val ref = row.optString("ref").takeIf(String::isNotBlank) ?: return
                screens.openWorkEvidence(ref)
            }
        }
    }

    private fun loadActions(body: LinearLayout, view: WorkspaceView) {
        val matterId = view.request.matterId ?: return
        if (view.request.template == WorkspaceTemplate.PERSON) return
        val section = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; tag = "workbench-actions" }
        body.addView(section, LinearLayout.LayoutParams(-1, -2).apply { topMargin = ui.moteDp(MoteTheme.spacePanel) })
        readActions(section, view, matterId)
    }

    private fun readActions(section: LinearLayout, view: WorkspaceView, matterId: String) {
        val api = screens.client
        val stamp = ++actionsGeneration
        ui.work("", { runCatching { api.get(actionsPath(matterId, view.request.scope.json)) } }) { result ->
            if (stamp != actionsGeneration || section.parent == null) return@work
            val raw = result.getOrNull()
            if (raw == null) {
                section.removeAllViews()
                ui.text(result.exceptionOrNull()?.message ?: MoteI18n.text("中央响应格式无效，请刷新后重试。"), parent = section)
                ui.button(MoteI18n.text("刷新"), parent = section) { readActions(section, view, matterId) }
                return@work
            }
            try {
                renderActions(section, view, matterId, AssistantActionResultsReader.readPage(raw))
            } catch (error: Exception) {
                section.removeAllViews()
                ui.text(MoteI18n.text("中央响应格式无效，请刷新后重试。"), parent = section)
                ui.button(MoteI18n.text("刷新"), parent = section) { readActions(section, view, matterId) }
            }
        }
    }

    private fun actionsPath(matterId: String, scope: JSONObject): String =
        "/api/assistant/matters/" + CentralScreens.encode(matterId) + "/actions?scope=" + CentralScreens.encode(scope.toString())

    private fun renderActions(section: LinearLayout, view: WorkspaceView, matterId: String, results: List<AssistantActionResults>) {
        section.removeAllViews()
        ui.text(MoteI18n.text("相关行动与结果"), NativeFontRole.SECTION, section)
        ui.text(MoteI18n.text("消息仍需逐条确认；日历按已有授权执行。"), NativeFontRole.META, section)
        if (results.all { it.drafts.isEmpty() }) return
        results.forEach { task ->
            task.drafts.forEach { item ->
                val card = ui.card(section)
                ui.text(item.draft.title, NativeFontRole.ROW, card)
                ui.text(item.draft.description, parent = card)
                val linked = item.linked
                if (linked != null) {
                    ui.text(MoteI18n.text(AssistantActionResultsReader.statusLabel(linked.status)), NativeFontRole.SUPPORT, card)
                    if (linked.status == "uncertain") ui.text(MoteI18n.text("保存结果待核实，请刷新检查结果，避免重复发送。"), parent = card)
                    if (linked.status == "stale") ui.text(MoteI18n.text("这份建议暂不能确认，请查看当前原文。"), parent = card)
                    linked.error?.let { ui.text(it, parent = card) }
                    ui.button(MoteI18n.text("查看行动建议"), parent = card) {
                        val intent = Intent(ui.hostActivity(), CalendarActionsActivity::class.java)
                        if (linked.kind == "todo.create") intent.putExtra("actionTab", "todos")
                        else intent.putExtra("actionId", linked.id)
                        ui.startActivity(intent)
                    }
                } else {
                    createAction(section, card, view, matterId, task, item)
                }
            }
        }
    }

    private fun createAction(section: LinearLayout, card: LinearLayout, view: WorkspaceView, matterId: String, results: AssistantActionResults, item: AssistantActionItem) {
        var target: AssistantActionTarget? = item.targets.firstOrNull()
        if (item.targets.size > 1) {
            card.addView(Spinner(ui).apply {
                contentDescription = MoteI18n.text("目标设备")
                adapter = MoteUi.choiceAdapter(ui, item.targets.map { it.name })
                onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
                    override fun onItemSelected(parent: android.widget.AdapterView<*>?, selectedView: android.view.View?, position: Int, id: Long) {
                        target = item.targets.getOrNull(position)
                    }
                }
            })
        }
        val external = item.draft.kind != "todo.create"
        val create = ui.button(MoteI18n.text(if (external) "创建行动建议" else "记为待办"), true, card) {
            if (external && target == null) {
                ui.notice(MoteI18n.text("当前连接或授权范围不支持这项行动。"))
                return@button
            }
            val api = screens.client
            val body = JSONObject().put("taskId", results.taskId).put("expectedRevision", results.revision)
                .put("index", item.index).put("scope", view.request.scope.json)
            target?.let { body.put("target", it.target) }
            ui.work(MoteI18n.text("正在创建行动建议…"), { runCatching { api.post("/api/assistant/action-commands", body) } }) { result ->
                val raw = result.getOrNull()
                if (raw == null) {
                    val error = result.exceptionOrNull()
                    ui.notice(if ((error as? CentralFailure)?.status == 409) label("changed") else error?.message ?: MoteI18n.text("操作失败"))
                    return@work
                }
                readActions(section, view, matterId)
            }
        }
        if (external && target == null) create.isEnabled = false
    }
}

/** The route contribution owns only the mounted view slot. The durable
 * plugin scope and the strict parser remain after the view is recreated. */
internal fun CentralScreens.mountWorkbench(container: ViewGroup): PluginViewContribution {
    val body = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
    container.addView(body)
    val workbench = assistantWorkbench()
    workbench.mount(body)
    return object : PluginViewContribution {
        override val routeId = "assistant.workbench"
        override fun dispose() {
            workbench.dispose()
            (body.parent as? ViewGroup)?.removeView(body)
        }
    }
}
