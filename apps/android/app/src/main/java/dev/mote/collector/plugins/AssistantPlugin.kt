package dev.mote.collector.plugins

import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.text.InputFilter
import android.text.format.DateFormat
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.AssistantJson
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralFailure
import dev.mote.collector.CentralScreens
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteDialogBuilder
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeColorRole
import dev.mote.collector.NativeFontRole
import dev.mote.collector.UiTask
import dev.mote.collector.moteDp
import dev.mote.collector.mountWorkbench
import dev.mote.collector.mountAssistant
import dev.mote.collector.ui.MoteComponents
import org.json.JSONObject
import java.io.IOException
import java.lang.ref.WeakReference
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap

/** Build-native position for the assistant domain. The package owns the
 * feed, matters and workbench routes; opening one mounts its Central screen into the
 * host slot. Registering the provider never starts work or performs a command. */
internal object AssistantPlugin {
    const val CAPABILITY = "mote.assistant"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.assistant"
    const val WORKBENCH_ROUTE = "assistant.workbench"
    const val FEED_ROUTE = "assistant.feed"
    const val GOALS_ROUTE = "assistant.goals"
    const val MATTERS_ROUTE = "assistant.matters"
    val PAGE_ROUTES = setOf(FEED_ROUTE, MATTERS_ROUTE, WORKBENCH_ROUTE, GOALS_ROUTE)
    private const val PACKAGE_ID = "dev.mote.assistant"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, AssistantOwner>()
    private val screens = WeakHashMap<Activity, WeakReference<CentralScreens>>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** The central page binds its current screen so the route factory can
     * mount the exact owner view without a second navigation tree. */
    internal fun bind(activity: Activity, screen: CentralScreens) {
        synchronized(screens) { screens[activity] = WeakReference(screen) }
    }

    internal fun screen(activity: Activity): CentralScreens? = synchronized(screens) { screens[activity]?.get() }

    /** Open the assistant scope before resolving a cold-start view link. This
     * declares the page route; it does not read data or run a command. */
    internal fun ensure(context: Context) {
        runCatching { owner(context) }
    }

    internal fun owner(context: Context): AssistantOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): AssistantOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return AssistantOwner(null)
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return AssistantOwner(null, running = false)
        }
        return when (val started = host.startPlugin(scope) { session -> AssistantOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                AssistantOwner(null, running = false)
            }
        }
    }

    /** Test seam: the same owner on a real host scope. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): AssistantOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return AssistantOwner(scope)
    }
}

/** Durable owner: the plugin scope owns the assistant routes. A stopped scope
 * withdraws the page and every declared command route. */
internal class AssistantOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val running: Boolean = true,
) {
    @Volatile private var closed = false

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("assistant.workbench", "${AssistantPlugin.CAPABILITY}.workbench"))
            for (page in AssistantPlugin.PAGE_ROUTES) scope.registerRoute(page) { _, container ->
                val view = container as? View ?: error("assistant route needs a view container")
                val activity = view.context as? Activity ?: error("assistant route needs an Activity")
                val screen = AssistantPlugin.screen(activity) ?: error("assistant screen is not bound")
                val parent = container as ViewGroup
                when (page) {
                    AssistantPlugin.WORKBENCH_ROUTE -> screen.mountWorkbench(parent)
                    AssistantPlugin.GOALS_ROUTE -> AssistantGoalsPage(screen, parent) { active }
                    else -> screen.mountAssistant(page, parent)
                }
            }
            scope.defer { close() }
        }
    }

    internal val active get() = running && !closed && scope?.revoked != true

    internal fun close() {
        closed = true
    }
}

internal enum class GoalAction(val wire: String) {
    COMPLETE("complete"), DISMISS("dismiss"), REJECT("reject"), FOLLOW("follow"),
}

internal enum class GoalGrouping(val wire: String) { MATTER("matter"), PERSON("person") }

internal data class GoalRow(
    val id: String,
    val kind: String,
    val title: String,
    val revision: Long,
    val actions: Set<GoalAction>,
    val inferred: Boolean,
    val followed: Boolean,
    val due: String?,
    val dueState: String?,
    val progress: String?,
    val evidence: String?,
) {
    companion object {
        fun read(row: JSONObject): GoalRow {
            val json = AssistantJson
            val actions = row.getJSONArray("actions")
            val progress = row.optJSONObject("lastProgress")
            return GoalRow(json.id(row), json.state(row, "kind", setOf("commitment", "todo", "event")),
                json.string(row, "title"), json.revision(row),
                (0 until actions.length()).map { index -> GoalAction.entries.first { it.wire == actions.getString(index) } }.toSet(),
                json.bool(row, "inferred"), row.optJSONObject("followup")?.let { json.bool(it, "followed") } == true,
                row.optJSONObject("due")?.let { json.string(it, "text") }, json.optional(row, "dueState"),
                progress?.let { json.string(it, "summary") }, progress?.takeIf { it.has("evidenceId") }?.let { json.id(it, "evidenceId") })
        }
    }
}

internal data class GoalGroup(val title: String?, val matterId: String?, val template: WorkspaceTemplate?, val sections: List<List<GoalRow>>)

internal data class GoalsSnapshot(val revision: String, val groups: List<GoalGroup>) {
    fun apply(row: GoalRow, change: GoalChange): GoalsSnapshot = copy(groups = groups.map { group ->
        group.copy(sections = group.sections.map { section -> section.mapNotNull { item ->
            if (item != row) item else when (change) {
                GoalChange.REMOVED -> null
                GoalChange.FOLLOWED -> item.copy(followed = true, actions = item.actions - GoalAction.FOLLOW)
                GoalChange.UNCHANGED -> item
            }
        } })
    }.filter { group -> group.matterId != null || group.sections.any { it.isNotEmpty() } })
}

internal enum class GoalChange { REMOVED, FOLLOWED, UNCHANGED }

/** The page reads GO1 and sends only actions and revisions present in its current view. */
internal class AssistantGoals(private val get: (String) -> JSONObject, private val post: (String, JSONObject) -> JSONObject) {
    fun read(group: GoalGrouping, zone: ZoneId = ZoneId.systemDefault()): GoalsSnapshot {
        val view = get("/api/assistant/goals?group=${group.wire}&scope=%7B%22kind%22%3A%22all%22%7D&tz=${CentralScreens.encode(zone.id)}")
        val groups = AssistantJson.rows(view, "groups") { value ->
            val key = value.getJSONObject("key")
            val kind = AssistantJson.state(key, "kind", setOf("matter", "person", "none"))
            val sections = listOf("theirs", "mine", "unconfirmed").map { AssistantJson.rows(value, it, GoalRow::read) }
            when (kind) {
                "matter" -> GoalGroup(AssistantJson.string(key, "title"), AssistantJson.id(key),
                    WorkspaceTemplate.from(AssistantJson.optional(key, "template") ?: "project").also { require(it != WorkspaceTemplate.PERSON) }, sections)
                "person" -> GoalGroup(AssistantJson.string(key, "name"), null, null, sections)
                else -> GoalGroup(null, null, null, sections)
            }
        }
        return GoalsSnapshot(AssistantJson.string(view, "revision"), groups)
    }

    fun run(row: GoalRow, action: GoalAction): GoalChange {
        require(action in row.actions)
        val path = "/api/assistant/goals/${row.id}"
        val body = JSONObject().put("expectedRevision", row.revision)
        if (action == GoalAction.FOLLOW) {
            val result = post("$path/follow", body)
            check(AssistantJson.bool(result, "followed"))
            return GoalChange.FOLLOWED
        }
        val result = post("$path/action", body.put("kind", row.kind).put("action", action.wire))
        check(AssistantJson.id(result) == row.id && AssistantJson.string(result, "kind") == row.kind)
        return if (AssistantJson.string(result, "status") in setOf("completed", "cancelled", "dismissed")) GoalChange.REMOVED else GoalChange.UNCHANGED
    }

    fun create(title: String, due: LocalDateTime?) {
        val body = JSONObject().put("title", title)
        due?.let { body.put("due", JSONObject().put("text", dueLabel(it)).put("at", it.atZone(ZoneId.systemDefault()).toInstant().toString())) }
        post("/api/assistant/goals", body)
    }
}

private fun dueLabel(due: LocalDateTime) = due.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(MoteI18n.locale()))

private class AssistantGoalsPage(private val screen: CentralScreens, parent: ViewGroup, private val ownerActive: () -> Boolean) : PluginViewContribution {
    override val routeId = AssistantPlugin.GOALS_ROUTE
    private val ui = screen.ui
    private val activity = ui.hostActivity()
    private val visit = ui.readVisit()
    private val origin = ui.server
    private val generation = ui.currentAccessGeneration
    private val client = screen.client
    private val api = AssistantGoals(client::get) { path, body -> client.post(path, body) }
    private val task = UiTask(activity)
    private val root = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
    private val status = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
    private val rows = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
    private var grouping = GoalGrouping.MATTER
    private var snapshot: GoalsSnapshot? = null
    private var commandPending = false
    private var latestRevision: Pair<String, String>? = null
    private var readPending = false
    private var editor: android.app.Dialog? = null
    private var picker: android.app.Dialog? = null
    private val tabs = MoteComponents.MoteSegmented(ui, listOf("matter" to "按事项", "person" to "按人")) { selected ->
        select(GoalGrouping.entries.first { it.wire == selected })
    }

    init {
        parent.addView(root)
        screen.clearBack()
        ui.detailTitle(MoteI18n.text("目标"))
        ui.goalAdd { if (valid() && !task.busy) create() }
        ui.goalsRevisionChanged = { revision ->
            val previous = latestRevision
            latestRevision = revision
            if (previous != null && previous != revision) refresh()
        }
        root.addView(tabs)
        root.addView(status)
        root.addView(rows)
        tabs.select(grouping.wire)
        refresh()
    }

    private fun valid(): Boolean = visit() && ownerActive() && CentralAccess.resolve(ui).let {
        it.client != null && it.server == origin && it.generation == generation
    }

    private fun select(next: GoalGrouping) {
        if (grouping == next || commandPending) return
        grouping = next
        tabs.select(grouping.wire)
        snapshot = null
        rows.removeAllViews()
        refresh()
    }

    private fun refresh() {
        if (!valid()) return
        if (task.busy) { readPending = true; return }
        readPending = false
        val selected = grouping
        if (snapshot == null) {
            status.removeAllViews()
            status.addView(MoteComponents.skeleton(ui, MoteI18n.text("正在读取…")))
        }
        task.start("", {}, { check(valid()); api.read(selected) }) { result ->
            if (!valid()) { rows.removeAllViews(); return@start }
            if (selected != grouping) { refresh(); return@start }
            result.onSuccess { loaded ->
                status.removeAllViews()
                if (snapshot != loaded) { snapshot = loaded; render() }
            }.onFailure(::failure)
            if (readPending) refresh()
        }
    }

    private fun failure(error: Throwable) {
        val code = (error as? CentralFailure)?.status
        val invalid = code in setOf(401, 403, 404, 409, 410)
        if (invalid) { snapshot = null; rows.removeAllViews() }
        status.removeAllViews()
        val message = when {
            code == 409 -> MoteI18n.text("目标已变化")
            invalid -> MoteI18n.text("已失效")
            error is IOException -> MoteI18n.text("已离线")
            else -> MoteI18n.text("读取失败")
        }
        status.addView(MoteComponents.banner(ui, null, message, actionLabel = "重试") { refresh() })
    }

    private fun command(row: GoalRow, action: GoalAction) {
        if (!valid() || task.busy || snapshot?.groups?.none { group -> group.sections.any { row in it } } != false) return
        commandPending = true
        task.start("", {}, { check(valid()); api.run(row, action) }) { result ->
            commandPending = false
            if (!valid()) { rows.removeAllViews(); return@start }
            result.onSuccess { change ->
                snapshot = snapshot?.apply(row, change)
                render()
                refresh()
            }.onFailure { failure(it); if (readPending) refresh() }
        }
    }

    private fun render() {
        rows.removeAllViews()
        val groups = snapshot?.groups.orEmpty().filter { group -> group.sections.any { it.isNotEmpty() } }
        if (groups.isEmpty()) label(rows, MoteI18n.text("没有待办"), NativeFontRole.BODY)
        val keys = listOf(MoteI18n.text("等别人"), MoteI18n.text("我要做"), MoteI18n.text("待确认"))
        for (group in groups) {
            val card = ui.card(rows).apply { setPadding(ui.moteDp(14), ui.moteDp(10), ui.moteDp(14), ui.moteDp(10)) }
            val matterId = group.matterId
            val heading = label(card, group.title ?: MoteI18n.text("其他"), NativeFontRole.SECTION,
                if (matterId != null) NativeColorRole.ACCENT else NativeColorRole.INK)
            if (matterId != null) {
                heading.isFocusable = true
                heading.setOnClickListener {
                    if (valid()) {
                        screen.assistantWorkbench().selectMatter(matterId, requireNotNull(group.template))
                        ui.navigate(AssistantPlugin.WORKBENCH_ROUTE)
                    }
                }
            }
            group.sections.forEachIndexed { index, items ->
                if (items.isNotEmpty()) {
                    label(card, keys[index], NativeFontRole.META)
                    items.forEach { row -> card.addView(MoteComponents.divider(ui)); renderRow(card, row) }
                }
            }
        }
    }

    private fun renderRow(card: LinearLayout, row: GoalRow) {
        val body = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; tag = "goal:${row.id}" }
        card.addView(body)
        label(body, row.title, NativeFontRole.ROW, NativeColorRole.INK)
        row.due?.let { label(body, it, NativeFontRole.META, if (row.dueState == "overdue") NativeColorRole.WARNING else NativeColorRole.MUTED) }
        row.progress?.let { label(body, it, NativeFontRole.META) }
        row.evidence?.let { evidence -> action(body, "查看原文") { if (valid()) screen.openWorkEvidence("capture:$evidence") } }
        if (row.followed) label(body, MoteI18n.text("已交给 Mote"), NativeFontRole.META).tag = "goal-followed"
        if (GoalAction.FOLLOW in row.actions && !row.followed) {
            val line = LinearLayout(ui).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
            body.addView(line)
            label(line, MoteI18n.text("交给 Mote 盯着"), NativeFontRole.META)
            action(line, "照做") { command(row, GoalAction.FOLLOW) }.tag = "goal-follow"
        }
        val actions = LinearLayout(ui).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
        for (available in row.actions - GoalAction.FOLLOW) {
            val key = when (available) {
                GoalAction.REJECT -> "推断 ×"
                GoalAction.COMPLETE -> "完成"
                GoalAction.DISMISS -> "不需要"
                GoalAction.FOLLOW -> error("Unexpected follow action")
            }
            action(actions, key) { command(row, available) }.apply {
                tag = "goal-${available.wire}"
                if (available == GoalAction.REJECT) contentDescription = MoteI18n.text("否定推断")
            }
        }
        if (row.inferred && GoalAction.REJECT !in row.actions) label(actions, MoteI18n.text("推断"), NativeFontRole.META)
        if (actions.childCount > 0) body.addView(actions)
    }

    private fun label(parent: LinearLayout, text: String, role: NativeFontRole, tone: NativeColorRole = NativeColorRole.MUTED) =
        ui.text(text, role, parent).apply { MoteUi.textColor(this, tone); setTextIsSelectable(false) }

    private fun action(parent: LinearLayout, key: String, click: () -> Unit): View =
        MoteComponents.smallButton(ui, key) { click() }.also { parent.addView(it) }

    private fun create() {
        val form = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.moteDp(20), 0, ui.moteDp(20), 0) }
        val title = ui.field(MoteI18n.text("标题"), parent = form).apply { filters = arrayOf(InputFilter.LengthFilter(80)) }
        var due: LocalDateTime? = null
        val dueButton = MoteComponents.button(ui, MoteI18n.text("期限")) {
            val initial = due ?: LocalDateTime.now()
            picker = DatePickerDialog(activity, { _, year, month, day ->
                picker = TimePickerDialog(activity, { _, hour, minute ->
                    due = LocalDateTime.of(year, month + 1, day, hour, minute)
                    (it as TextView).text = dueLabel(requireNotNull(due))
                }, initial.hour, initial.minute, DateFormat.is24HourFormat(ui)).also { it.show() }
            }, initial.year, initial.monthValue - 1, initial.dayOfMonth).also { it.show() }
        }
        form.addView(dueButton)
        val dialog = MoteDialogBuilder(activity).setTitle(MoteI18n.text("新建目标")).setView(form)
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("保存"), null).show()
        editor = dialog
        val save = dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE)
        save.setOnClickListener {
            val name = title.text.toString().trim()
            if (name.isEmpty() || !valid() || task.busy) return@setOnClickListener
            commandPending = true
            save.isEnabled = false
            val deadline = due
            task.start("", {}, { check(valid()); api.create(name, deadline) }) { result ->
                commandPending = false
                if (!valid()) return@start
                save.isEnabled = true
                result.onSuccess { dialog.dismiss(); refresh() }.onFailure {
                    title.error = MoteI18n.text("操作失败")
                    if (readPending) refresh()
                }
            }
        }
    }

    override fun dispose() {
        ui.goalsRevisionChanged = null
        task.close()
        picker?.dismiss()
        editor?.dismiss()
        ui.goalAdd(null)
        (root.parent as? ViewGroup)?.removeView(root)
    }
}
