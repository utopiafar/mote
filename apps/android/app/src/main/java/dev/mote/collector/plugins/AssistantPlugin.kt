package dev.mote.collector.plugins

import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.text.InputFilter
import android.text.TextUtils
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import dev.mote.collector.AdvancedWebTarget
import dev.mote.collector.AssistantFeedViewModel
import dev.mote.collector.AssistantHttpBindings
import dev.mote.collector.AssistantJson
import dev.mote.collector.AssistantOpen
import dev.mote.collector.AssistantPresentation
import dev.mote.collector.AssistantProof
import dev.mote.collector.AssistantScope
import dev.mote.collector.AssistantTaskView
import dev.mote.collector.CalendarActionsActivity
import dev.mote.collector.CalendarNeeds
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralAssistant
import dev.mote.collector.CentralContent
import dev.mote.collector.CentralDraftWrites
import dev.mote.collector.CentralFailure
import dev.mote.collector.CentralScreens
import dev.mote.collector.MemoryDetailPanel
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteDialogBuilder
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteTheme
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeColorRole
import dev.mote.collector.NativeFontRole
import dev.mote.collector.NativePresentationStyles
import dev.mote.collector.NativeRadiusRole
import dev.mote.collector.UiTask
import dev.mote.collector.moteDp
import dev.mote.collector.mountWorkbench
import dev.mote.collector.mountAssistant
import dev.mote.collector.openAssistantQuestion
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import org.json.JSONObject
import java.io.IOException
import java.lang.ref.WeakReference
import java.time.LocalDateTime
import java.time.ZonedDateTime
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
    const val IDEAS_ROUTE = "assistant.ideas"
    const val GOALS_ROUTE = "assistant.goals"
    const val MATTERS_ROUTE = "assistant.matters"
    val PAGE_ROUTES = setOf(FEED_ROUTE, IDEAS_ROUTE, MATTERS_ROUTE, WORKBENCH_ROUTE, GOALS_ROUTE)
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
    private val ideaAcceptanceLock = Any()

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("assistant.workbench", "${AssistantPlugin.CAPABILITY}.workbench"))
            for (page in AssistantPlugin.PAGE_ROUTES) scope.registerRoute(page) { _, container ->
                val parent = container as? ViewGroup ?: error("assistant route needs a view container")
                val screen = when (val context = parent.context) {
                    is CentralContent -> context.assistantRouteScreen()
                    is Activity -> AssistantPlugin.screen(context) ?: error("assistant screen is not bound")
                    else -> error("assistant route needs an Activity")
                }
                when (page) {
                    AssistantPlugin.WORKBENCH_ROUTE -> screen.mountWorkbench(parent)
                    AssistantPlugin.GOALS_ROUTE -> AssistantGoalsPage(screen, parent) { active }
                    AssistantPlugin.FEED_ROUTE -> AssistantFeedPage(screen, parent) { active }
                    AssistantPlugin.IDEAS_ROUTE -> AssistantIdeasPage(screen, parent, ideaAcceptanceLock) { active }
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

internal enum class FeedWindow(val wire: String, val label: String) {
    TODAY("today", "今天"), THREE_DAYS("3d", "3 天"), WEEK("week", "本周"), EARLIER("earlier", "更早"),
}

internal data class AssistantFeedQuery(
    val window: FeedWindow = FeedWindow.THREE_DAYS,
    val category: String? = null,
    val unread: Boolean = false,
    val search: String = "",
)

internal data class AssistantFeedRow(
    val id: String,
    val revision: Long,
    val kind: String,
    val title: String?,
    val summary: String?,
    val at: String?,
    val evidenceRef: String?,
    val readAt: String?,
) {
    val stale get() = title == null
    val discovery get() = kind == "discovery"
    val unread get() = !stale && !discovery && readAt == null

    companion object {
        fun read(row: JSONObject): AssistantFeedRow {
            val id = AssistantJson.id(row)
            val kind = AssistantJson.state(row, "kind", setOf("activity", "briefing", "artifact", "discovery"))
            if (row.getString("state") == "stale" || row.optBoolean("evidenceStale")) {
                return AssistantFeedRow(id, 0, kind, null, null, null, null, null)
            }
            val title = AssistantJson.string(row, "title")
            val heading = listOfNotNull(AssistantJson.optional(row, "subject"), AssistantJson.optional(row, "action"))
                .joinToString(" ").ifEmpty { title }
            val summary = AssistantJson.optional(row, "gist") ?: title.takeIf { heading != it }
                ?: AssistantJson.string(row, "body").take(120).replace('\n', ' ').replace('\r', ' ')
            return AssistantFeedRow(
                id, if (kind == "discovery") 0 else AssistantJson.revision(row), kind, heading, summary,
                AssistantJson.time(row, "createdAt"), AssistantProof.cardEvidence(row).firstOrNull()?.ref,
                AssistantJson.nullable(row, "readAt"),
            )
        }
    }
}

internal data class AssistantFeedData(
    val revision: String,
    val items: List<AssistantFeedRow>,
    val nextCursor: String?,
    val categories: List<Pair<String, Int>>,
) {
    fun append(next: AssistantFeedData): AssistantFeedData {
        if (next.revision != revision) throw CentralFailure(409)
        return next.copy(items = (items + next.items).associateBy { it.id }.values.toList())
    }

    fun opened(row: AssistantFeedRow, unreadOnly: Boolean): AssistantFeedData = copy(items = items.mapNotNull {
        when {
            it.id != row.id -> it
            unreadOnly && !row.unread -> null
            else -> row
        }
    })
}

internal class AssistantFeed(private val api: CentralAssistant) {
    fun read(query: AssistantFeedQuery, cursor: String? = null, zone: ZoneId = ZoneId.systemDefault()): AssistantFeedData {
        val path = buildString {
            append("/api/assistant-cards?scope=${api.scope.query()}&kinds=activity,briefing,artifact")
            if (!query.unread) append(",discovery")
            append("&window=${query.window.wire}&tz=${CentralScreens.encode(zone.id)}")
            if (query.unread) append("&unread=1")
            query.category?.let { append("&category=${CentralScreens.encode(it)}") }
            query.search.trim().takeIf(String::isNotEmpty)?.let { append("&q=${CentralScreens.encode(it)}") }
            cursor?.let { append("&cursor=${CentralScreens.encode(it)}") }
        }
        val page = api.client.get(path)
        return AssistantFeedData(
            AssistantJson.string(page, "revision"),
            AssistantJson.rows(page, "items", AssistantFeedRow::read),
            AssistantJson.cursor(page),
            AssistantJson.rows(page, "categories") { AssistantJson.string(it, "name") to it.getInt("count") },
        )
    }

    /** The feedback response rechecks the exact revision and evidence before the row opens. */
    fun open(row: AssistantFeedRow): AssistantFeedRow {
        if (!row.unread) return row
        val current = api.feedback(row.id, row.revision, "read")
        if (current.stale || current.state == "stale") throw CentralFailure(409)
        check(current.id == row.id && current.readAt != null)
        return row.copy(readAt = current.readAt, revision = current.revision, evidenceRef = current.evidence.firstOrNull()?.ref)
    }
}

internal enum class IdeaAction(val wire: String, val label: String) {
    START("start", "开始"), LATER("later", "稍后"), IGNORE("ignore", "忽略"), ANSWER("answer", "回答"),
}

internal sealed interface IdeasRow

internal data class AssistantIdeaRow(
    val id: String,
    val source: String,
    val title: String,
    val detail: String?,
    val revision: Long,
    val seq: Long,
    val actions: List<IdeaAction>,
) : IdeasRow {
    fun answer(): AdvancedWebTarget.ChatAbout {
        require(IdeaAction.ANSWER in actions)
        val kind = if (source == "owner-question") AdvancedWebTarget.ChatAbout.Kind.QUESTION else AdvancedWebTarget.ChatAbout.Kind.CARD
        return AdvancedWebTarget.ChatAbout(kind, id)
    }

    companion object {
        fun read(row: JSONObject): AssistantIdeaRow {
            val actions = row.getJSONArray("actions")
            return AssistantIdeaRow(
                AssistantJson.id(row), AssistantJson.state(row, "source", setOf("card", "owner-question")),
                AssistantJson.string(row, "title"), AssistantJson.optional(row, "detail"), AssistantJson.revision(row),
                row.getLong("seq"),
                (0 until actions.length()).map { index -> IdeaAction.entries.first { it.wire == actions.getString(index) } },
            )
        }
    }
}

internal data class StartedIdeaRow(val id: String, val title: String?, val state: String, val progress: String?) : IdeasRow {
    companion object {
        fun read(row: JSONObject): StartedIdeaRow {
            val id = AssistantJson.id(row, "taskId")
            val state = AssistantJson.string(row, "state")
            return if (state == "stale") StartedIdeaRow(id, null, state, null)
            else StartedIdeaRow(id, AssistantJson.string(row, "title"), state, AssistantJson.optional(row, "progress"))
        }
    }
}

internal data class CalendarNeedRow(val id: String, val title: String) : IdeasRow

internal enum class IdeasFilter(val label: String) { ALL("全部"), YOURS("需要你"), MINE("我来做"), STARTED("已开始") }

internal data class AssistantIdeasData(
    val revision: String,
    val watermark: Long,
    val yours: List<AssistantIdeaRow>,
    val mine: List<AssistantIdeaRow>,
    val started: List<StartedIdeaRow>,
) {
    val pendingCount get() = yours.size + mine.size
    fun handled(row: AssistantIdeaRow) = copy(yours = yours - row, mine = mine - row)
}

internal fun AssistantIdeasData?.rows(filter: IdeasFilter, calendar: List<CalendarNeedRow>): List<IdeasRow> = buildList {
    if (filter == IdeasFilter.ALL || filter == IdeasFilter.YOURS) {
        addAll(calendar)
        addAll(this@rows?.yours.orEmpty())
    }
    if (filter == IdeasFilter.ALL || filter == IdeasFilter.MINE) addAll(this@rows?.mine.orEmpty())
    if (filter == IdeasFilter.ALL || filter == IdeasFilter.STARTED) addAll(this@rows?.started.orEmpty())
}

internal class AssistantIdeas(
    private val api: CentralAssistant,
    private val start: (AssistantIdeaRow) -> Unit,
    private val now: () -> ZonedDateTime = ZonedDateTime::now,
) {
    fun read(): AssistantIdeasData {
        val view = api.client.get("/api/assistant/ideas?scope=${api.scope.query()}")
        return AssistantIdeasData(
            AssistantJson.string(view, "revision"),
            view.getLong("watermark"),
            AssistantJson.rows(view, "yours", AssistantIdeaRow::read),
            AssistantJson.rows(view, "mine", AssistantIdeaRow::read),
            AssistantJson.rows(view, "started", StartedIdeaRow::read),
        )
    }

    fun calendarNeeds(): List<CalendarNeedRow> = CalendarNeeds.scan { cursor -> api.client.get("/api/actions?cursor=$cursor") }
        .map { row -> CalendarNeedRow(AssistantJson.id(row), AssistantJson.string(row.getJSONObject("event"), "title")) }

    fun handle(view: AssistantIdeasData, row: AssistantIdeaRow, action: IdeaAction): AssistantIdeasData {
        require(action in row.actions && (row in view.mine || row in view.yours))
        when (action) {
            IdeaAction.START -> start(row)
            IdeaAction.LATER, IdeaAction.IGNORE -> {
                val body = JSONObject().put("action", action.wire).put("expectedRevision", row.revision)
                if (action == IdeaAction.LATER) {
                    val tomorrow = now().plusDays(1)
                    body.put("until", tomorrow.toLocalDate().atTime(9, 0).atZone(tomorrow.zone).toInstant().toString())
                }
                val reply = api.client.post("/api/assistant-cards/${row.id}/feedback?scope=${api.scope.query()}", body)
                check(AssistantJson.id(reply) == row.id)
            }
            IdeaAction.ANSWER -> error("Answer is a chat destination")
        }
        return view.handled(row)
    }

    fun ignoreAll(view: AssistantIdeasData): AssistantIdeasData {
        require(view.watermark > 0)
        val reply = api.client.post("/api/assistant/ideas/ignore-all", JSONObject().put("upToSeq", view.watermark))
        val ignored = reply.getInt("ignored")
        val seen = (view.mine + view.yours).filter { IdeaAction.IGNORE in it.actions && it.seq in 1..view.watermark }
        // Other clients may have acted since this snapshot. Re-read in that case.
        return if (ignored == seen.size) view.copy(mine = view.mine - seen.toSet(), yours = view.yours - seen.toSet(), watermark = 0)
        else view
    }
}

internal enum class AssistantTabStatus(val label: String) {
    LOADING("正在读取…"), STALE("已失效"), OFFLINE("已离线"), FAILED("读取失败"), PARTIAL("部分读取失败"),
    FEED_EMPTY("没有新动态"), IDEAS_EMPTY("没有新点子"), COMMAND_FAILED("操作失败"),
}

private fun withdrawn(error: Throwable?) = (error as? CentralFailure)?.status in setOf(401, 403, 404, 409, 410)

internal fun assistantTabStatus(empty: AssistantTabStatus, loaded: Boolean, rowCount: Int, error: Throwable? = null): AssistantTabStatus? =
    when {
        withdrawn(error) -> AssistantTabStatus.STALE
        error != null && rowCount > 0 -> AssistantTabStatus.PARTIAL
        error is IOException -> AssistantTabStatus.OFFLINE
        error != null -> AssistantTabStatus.FAILED
        !loaded -> AssistantTabStatus.LOADING
        rowCount == 0 -> empty
        else -> null
    }

private data class AssistantFilter(val id: String, val label: String, val selected: Boolean)

private abstract class AssistantTabPage(
    protected val screen: CentralScreens,
    parent: ViewGroup,
    override val routeId: String,
    private val ownerActive: () -> Boolean,
) : PluginViewContribution {
    protected val ui = screen.ui
    protected val activity = ui.hostActivity()
    protected val task = UiTask(activity)
    protected val api = CentralAssistant(screen.client, AssistantScope(JSONObject().put("kind", "all")), AssistantHttpBindings(screen.client))
    protected val root = LinearLayout(ui).apply {
        orientation = LinearLayout.VERTICAL
        tag = "assistant-page:$routeId"
    }
    private val filters = LinearLayout(ui)
    protected val rows = LinearLayout(ui).apply { orientation = LinearLayout.VERTICAL }
    private val status = LinearLayout(ui).apply {
        orientation = LinearLayout.VERTICAL
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val visit = ui.readVisit()
    private val origin = ui.server
    private val generation = ui.currentAccessGeneration
    @Volatile private var disposed = false
    private var afterWork: (() -> Unit)? = null
    private var menu: PopupMenu? = null
    protected var dialog: android.app.AlertDialog? = null

    init {
        screen.clearBack()
        root.addView(HorizontalScrollView(ui).apply { isHorizontalScrollBarEnabled = false; addView(filters) })
        root.addView(status)
        root.addView(rows)
        parent.addView(root)
    }

    protected fun currentAccess(): Boolean = !disposed && ownerActive() && runCatching { CentralAccess.resolve(ui) }
        .getOrNull()?.let { it.client != null && it.server == origin && it.generation == generation } == true

    protected fun valid(): Boolean = visit() && currentAccess()

    protected fun watchRevisions(refresh: () -> Unit) {
        var previous: Pair<String, Int?>? = null
        ui.assistantRevisionChanged = { revision ->
            val changed = previous != null && previous != revision
            previous = revision
            if (changed && valid()) {
                if (task.busy) afterWork = refresh else refresh()
            }
        }
    }

    protected fun <T> work(read: () -> T, result: (Result<T>) -> Unit) {
        if (!valid() || task.busy) return
        task.start("", {}, { check(valid()); read() }) { outcome ->
            if (!valid()) {
                root.removeAllViews()
                return@start
            }
            result(outcome)
            if (!task.busy) {
                val next = afterWork
                afterWork = null
                next?.invoke()
            }
        }
    }

    protected fun filters(choices: List<AssistantFilter>, select: (String, View) -> Unit) {
        filters.removeAllViews()
        for (choice in choices) filters.addView(TextView(ui).apply {
            text = choice.label
            tag = "$routeId:filter:${choice.id}"
            gravity = Gravity.CENTER
            setSingleLine()
            minimumHeight = ui.moteDp(MoteTheme.controlHeight)
            setPadding(ui.moteDp(12), 0, ui.moteDp(12), 0)
            MoteUi.type(this, NativeFontRole.ACTION)
            MoteUi.textColor(this, if (choice.selected) NativeColorRole.PRIMARY_INK else NativeColorRole.INK)
            NativePresentationStyles.bind(this, "assistant-filter") {
                val color = if (choice.selected) NativeColorRole.PRIMARY_BACKGROUND else NativeColorRole.FILL
                it.background = MoteUi.clickable(ui, color, NativeRadiusRole.PILL, false)
            }
            isSelected = choice.selected
            isFocusable = true
            setOnClickListener { if (valid() && !task.busy) select(choice.id, it) }
        }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = ui.moteDp(6); bottomMargin = ui.moteDp(8) })
    }

    protected fun status(state: AssistantTabStatus?, retry: () -> Unit) {
        status.removeAllViews()
        when (state) {
            null -> Unit
            AssistantTabStatus.LOADING -> status.addView(MoteComponents.skeleton(ui, MoteI18n.text(state.label), rows = 1))
            AssistantTabStatus.FEED_EMPTY, AssistantTabStatus.IDEAS_EMPTY -> ui.text(MoteI18n.text(state.label), NativeFontRole.SUPPORT, status)
            else -> status.addView(MoteComponents.banner(ui, null, MoteI18n.text(state.label), actionLabel = MoteI18n.text("重试")) { retry() })
        }
    }

    protected fun showMenu(anchor: View, options: List<Pair<String, () -> Unit>>) {
        if (!valid() || task.busy || options.isEmpty()) return
        menu?.dismiss()
        menu = PopupMenu(anchor.context, anchor).apply {
            options.forEachIndexed { index, (label, _) -> this.menu.add(0, index, index, MoteI18n.text(label)) }
            setOnMenuItemClickListener { item ->
                if (valid() && !task.busy) options[item.itemId].second()
                true
            }
            show()
        }
    }

    protected fun row(
        title: String, detail: String?, icon: MoteGlyph,
        trailing: View? = null, time: String? = null, unread: Boolean? = null, onClick: (() -> Unit)? = null,
    ): LinearLayout = LinearLayout(ui).apply {
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = ui.moteDp(62)
        val inset = ui.moteDp(8)
        setPadding(0, inset, 0, inset)
        unread?.let {
            val dot = View(ui)
            NativePresentationStyles.bind(dot, "feed-read-dot") {
                it.background = MoteUi.shape(ui, NativeColorRole.ACCENT, NativeRadiusRole.PILL, false)
            }
            dot.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            dot.visibility = if (unread) View.VISIBLE else View.INVISIBLE
            dot.tag = "feed-unread"
            addView(dot, LinearLayout.LayoutParams(ui.moteDp(6), ui.moteDp(6)).apply { marginEnd = inset })
        }
        addView(MoteComponents.icon(ui, icon), LinearLayout.LayoutParams(ui.moteDp(20), ui.moteDp(20)).apply { marginEnd = ui.moteDp(12) })
        addView(LinearLayout(ui).apply {
            orientation = LinearLayout.VERTICAL
            addView(line(title, NativeFontRole.ROW, NativeColorRole.INK))
            if (time == null) {
                detail?.let { addView(line(it, NativeFontRole.META, NativeColorRole.MUTED)) }
            } else {
                addView(LinearLayout(ui).apply {
                    detail?.let {
                        addView(line(it, NativeFontRole.META, NativeColorRole.MUTED), LinearLayout.LayoutParams(-2, -2, 1f))
                    }
                    addView(line(time, NativeFontRole.META, NativeColorRole.MUTED), LinearLayout.LayoutParams(-2, -2).apply {
                        if (detail != null) marginStart = inset
                    })
                })
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        trailing?.let { addView(it, LinearLayout.LayoutParams(-2, -2).apply { marginStart = inset }) }
        if (onClick != null) {
            NativePresentationStyles.bind(this, "assistant-row") {
                it.background = MoteUi.clickable(ui, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
            }
            val label = if (unread == true) listOf(MoteI18n.text("未读"), title, detail, time) else listOf(title, detail, time)
            contentDescription = label.filterNotNull().joinToString(" · ")
            isFocusable = true
            setOnClickListener { if (valid() && !task.busy) onClick() }
        }
    }

    private fun line(value: String, role: NativeFontRole, color: NativeColorRole) = TextView(ui).apply {
        text = value
        MoteUi.type(this, role, medium = role == NativeFontRole.ROW)
        MoteUi.textColor(this, color)
        setSingleLine()
        ellipsize = TextUtils.TruncateAt.END
    }

    protected fun addRow(row: View) {
        rows.addView(MoteComponents.divider(ui))
        rows.addView(row, LinearLayout.LayoutParams(-1, -2))
    }

    override fun dispose() {
        disposed = true
        ui.assistantRevisionChanged = null
        ui.clearAssistantTabAction()
        afterWork = null
        menu?.dismiss()
        dialog?.dismiss()
        task.close()
        (root.parent as? ViewGroup)?.removeView(root)
    }
}

private class AssistantFeedPage(screen: CentralScreens, parent: ViewGroup, ownerActive: () -> Boolean) :
    AssistantTabPage(screen, parent, AssistantPlugin.FEED_ROUTE, ownerActive) {
    private val feed = AssistantFeed(api)
    private var query = AssistantFeedQuery()
    private var snapshot: AssistantFeedData? = null
    private var error: Throwable? = null

    init {
        ui.assistantTabHeader(MoteI18n.text("动态"), MoteGlyph.SEARCH, "搜索动态") { search() }
        watchRevisions { refresh() }
        refresh()
    }

    private fun refresh(more: Boolean = false) {
        if (!valid() || task.busy) return
        val previous = snapshot
        val cursor = if (more) previous?.nextCursor ?: return else null
        val selected = query
        error = null
        render()
        work({
            val received = feed.read(selected, cursor)
            if (cursor != null) requireNotNull(previous).append(received) else received
        }) { result ->
            result.onSuccess { snapshot = it }.onFailure {
                error = it
                if (!more || withdrawn(it)) snapshot = null
            }
            render()
        }
    }

    private fun select(next: AssistantFeedQuery) {
        if (query == next) return
        query = next
        snapshot = null
        refresh()
    }

    private fun search() {
        if (!valid() || task.busy) return
        val field = MoteUi.field(EditText(activity).apply {
            setSingleLine()
            filters = arrayOf(InputFilter.LengthFilter(200))
            setText(query.search)
            hint = MoteI18n.text("搜索动态")
        })
        dialog = MoteDialogBuilder(activity).setTitle(MoteI18n.text("搜索动态")).setView(field)
            .setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("搜索")) { _, _ ->
                if (valid() && !task.busy) select(query.copy(search = field.text.toString().trim()))
            }.show()
    }

    private fun chooseWindow(anchor: View) {
        showMenu(anchor, FeedWindow.entries.map { window -> window.label to { select(query.copy(window = window)) } })
    }

    private fun render() {
        val view = snapshot
        val items = view?.items.orEmpty()
        filters(buildList {
            add(AssistantFilter("all", MoteI18n.text("全部"), query.category == null))
            for ((category, count) in view?.categories.orEmpty()) add(AssistantFilter("category:$category", "$category $count", query.category == category))
            add(AssistantFilter("unread", MoteI18n.text("未读"), query.unread))
            add(AssistantFilter("window", MoteI18n.text(query.window.label), false))
        }) { filter, anchor ->
            when (filter) {
                "all" -> select(query.copy(category = null))
                "unread" -> select(query.copy(unread = !query.unread))
                "window" -> chooseWindow(anchor)
                else -> select(query.copy(category = filter.removePrefix("category:")))
            }
        }
        status(assistantTabStatus(AssistantTabStatus.FEED_EMPTY, view != null, items.size, error)) { refresh() }
        rows.removeAllViews()
        for (item in items) {
            val glyph = when (item.kind) {
                "discovery" -> MoteGlyph.BOLT
                "artifact" -> MoteGlyph.FILE
                else -> MoteGlyph.PULSE
            }
            val readable = !item.stale && (item.unread || item.discovery || item.evidenceRef != null)
            val target: (() -> Unit)? = if (readable) ({ open(item) }) else null
            addRow(row(
                item.title ?: MoteI18n.text("已失效"), item.summary, glyph, time = item.at?.let(MemoryDetailPanel::displayTime),
                unread = item.unread, onClick = target,
            ).apply {
                tag = "feed-row:${item.id}"
            })
        }
        if (view?.nextCursor != null && error == null) {
            rows.addView(MoteComponents.button(ui, MoteI18n.text("加载更多")) { refresh(more = true) })
        }
    }

    private fun open(item: AssistantFeedRow) {
        if (!item.unread) { openSource(item); return }
        work({ feed.open(item) }) { result ->
            result.onSuccess { current ->
                snapshot = snapshot?.opened(current, query.unread)
                render()
                openSource(current)
            }.onFailure {
                error = it
                if (withdrawn(it)) snapshot = null
                render()
            }
        }
    }

    private fun openSource(item: AssistantFeedRow) {
        if (item.discovery) ui.openInsight(item.id) else item.evidenceRef?.let { screen.openWorkEvidence(it) }
    }
}

private class AssistantIdeasPage(
    screen: CentralScreens, parent: ViewGroup, private val acceptanceLock: Any, ownerActive: () -> Boolean,
) : AssistantTabPage(screen, parent, AssistantPlugin.IDEAS_ROUTE, ownerActive) {
    private val store = screen.stateFile("assistant-feed")
    private val ideas = AssistantIdeas(api, { row -> withAcceptance { startIdea(row.id, row.revision, row.title) } })
    private var filter = IdeasFilter.ALL
    private var snapshot: AssistantIdeasData? = null
    private var calendar = emptyList<CalendarNeedRow>()
    private var ideasError: Throwable? = null
    private var calendarError: Throwable? = null
    private var commandFailed = false
    private var reading = false
    private var taskDetail: AssistantTaskView? = null

    init {
        ui.assistantTabHeader(MoteI18n.text("点子"), MoteGlyph.MORE, "更多") { anchor ->
            snapshot?.takeIf { it.watermark > 0 }?.let { view ->
                showMenu(anchor, listOf("全部忽略" to { command(view) { ideas.ignoreAll(view) } }))
            }
        }
        watchRevisions { refresh() }
        refresh(readCalendar = true)
    }

    private fun <T> withAcceptance(run: AssistantFeedViewModel.() -> T): T = synchronized(acceptanceLock) {
        check(valid())
        val commands = AssistantFeedViewModel(api, { CentralDraftWrites.barrier(store::read) }, { value ->
            CentralDraftWrites.barrier { store.write(value) }
        })
        commands.run()
    }

    private fun refresh(readCalendar: Boolean = false) {
        if (!valid() || task.busy) return
        ideasError = null
        commandFailed = false
        if (readCalendar) calendarError = null
        reading = true
        render()
        work({
            val remote = runCatching {
                val current = ideas.read()
                withAcceptance { reconcileIdeaAcceptance() }
                current
            }
            val needs = if (readCalendar && valid()) runCatching { ideas.calendarNeeds() } else null
            remote to needs
        }) { result ->
            reading = false
            result.onSuccess { (remote, needs) ->
                snapshot = remote.getOrNull()
                ideasError = remote.exceptionOrNull()
                if (needs != null) {
                    calendar = needs.getOrDefault(emptyList())
                    calendarError = needs.exceptionOrNull()
                }
            }.onFailure { ideasError = it; snapshot = null }
            render()
        }
    }

    private fun command(view: AssistantIdeasData, send: () -> AssistantIdeasData) {
        if (snapshot != view) return
        work(send) { result ->
            result.onSuccess { updated ->
                snapshot = updated
                ui.ideasCountChanged?.invoke(updated.pendingCount)
                refresh()
            }.onFailure {
                if (withdrawn(it)) {
                    ideasError = it
                    snapshot = null
                } else {
                    commandFailed = true
                }
                render()
            }
        }
    }

    private fun perform(view: AssistantIdeasData, row: AssistantIdeaRow, action: IdeaAction) {
        if (!valid() || task.busy || snapshot != view) return
        if (action == IdeaAction.ANSWER) ui.openAdvancedWeb(row.answer()) else command(view) { ideas.handle(view, row, action) }
    }

    private fun render() {
        val view = snapshot
        val yours = view?.yours.orEmpty()
        val mine = view?.mine.orEmpty()
        val started = view?.started.orEmpty()
        val yourCount = yours.size + calendar.size
        val counts = listOf(yourCount + mine.size + started.size, yourCount, mine.size, started.size)
        filters(IdeasFilter.entries.zip(counts).map { (option, count) ->
            val label = if (view == null && calendar.isEmpty()) MoteI18n.text(option.label) else "${MoteI18n.text(option.label)} $count"
            AssistantFilter(option.name, label, option == filter)
        }) { selected, _ -> filter = IdeasFilter.valueOf(selected); render() }
        rows.removeAllViews()
        val shown = view.rows(filter, calendar)
        for (item in shown) when (item) {
            is CalendarNeedRow -> addRow(row(item.title, MoteI18n.text("时间待补充"), MoteGlyph.CALENDAR, onClick = {
                activity.startActivity(Intent(activity, CalendarActionsActivity::class.java).putExtra("actionId", item.id))
            }).apply { tag = "ideas-calendar:${item.id}" })
            is AssistantIdeaRow -> addIdea(requireNotNull(view), item)
            is StartedIdeaRow -> {
                val progress = item.title?.let { MoteI18n.text("已开始") + " · " + (item.progress ?: AssistantPresentation.operation(item.state)) }
                val check = item.title?.let { MoteComponents.icon(ui, MoteGlyph.CHECK, NativeColorRole.SUCCESS) }
                val openTask: (() -> Unit)? = if (item.title == null) null else ({ openTask(item.id) })
                addRow(row(item.title ?: MoteI18n.text("已失效"), progress, MoteGlyph.FILE, trailing = check, onClick = openTask).apply {
                    tag = "ideas-started:${item.id}"
                })
            }
        }
        val state = when {
            commandFailed -> AssistantTabStatus.COMMAND_FAILED
            view != null && calendarError != null -> AssistantTabStatus.PARTIAL
            else -> assistantTabStatus(AssistantTabStatus.IDEAS_EMPTY, view != null, shown.size, ideasError ?: calendarError)
        }
        status(state) {
            refresh(readCalendar = calendarError != null)
        }
    }

    private fun addIdea(view: AssistantIdeasData, item: AssistantIdeaRow) {
        val actions = LinearLayout(ui).apply {
            gravity = Gravity.CENTER_VERTICAL
            for (action in item.actions) {
                val tap: (View) -> Unit = { perform(view, item, action) }
                val control = if (action == IdeaAction.IGNORE) MoteComponents.iconButton(ui, MoteGlyph.CLOSE, action.label, onClick = tap)
                else MoteComponents.button(ui, MoteI18n.text(action.label), MoteUi.ButtonRole.TEXT, tap).apply {
                    minimumWidth = 0
                    minWidth = 0
                    setPadding(ui.moteDp(8), 0, ui.moteDp(8), 0)
                }
                control.tag = "ideas-action:${item.id}:${action.wire}"
                control.isEnabled = !reading
                addView(control, LinearLayout.LayoutParams(-2, -2))
            }
        }
        val icon = if (IdeaAction.ANSWER in item.actions) MoteGlyph.ASK else MoteGlyph.BOLT
        val row = row(item.title, item.detail, icon, trailing = actions).apply {
            tag = "ideas-row:${item.id}"
            if (item.actions.isNotEmpty()) setOnLongClickListener { anchor ->
                showMenu(anchor, item.actions.map { it.label to { perform(view, item, it) } })
                true
            }
        }
        addRow(row)
    }

    private fun openTask(id: String) {
        screen.setBack { ui.navigate(routeId, remember = false) }
        ui.assistantRevisionChanged = null
        ui.detailTitle(MoteI18n.text("任务状态"))
        val visit = ui.readVisit()
        val current = { visit() && currentAccess() }
        root.removeAllViews()
        taskDetail = AssistantTaskView(activity, api, id, current) { destination ->
            if (destination is AssistantOpen.Question) screen.openAssistantQuestion(destination, current)
        }.also {
            root.addView(it, LinearLayout.LayoutParams(-1, -2))
            it.refresh()
        }
    }

    override fun dispose() {
        taskDetail?.close()
        super.dispose()
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
