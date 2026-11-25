package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.content.res.AssetManager
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Application routes are explicit UI metadata, never inferred from captured content. */
enum class MotePrimaryTab(val titleKey: String, val icon: String, val localPage: String, val route: String) {
    HOME("首页", "overview", "OVERVIEW", "home"),
    LIBRARY("资料库", "library", "LIBRARY", "library"),
    ASK("问一问", "ask", "ASK", "ask"),
    SOURCES("来源", "sources", "SOURCES", "sources"),
    ACTIVITY("活动", "activity", "ACTIVITY", "activity")
}

data class MoteNavigationGroup(val titleKey: String, val pages: List<String>)

/**
 * One authored navigation entry from `assets/ui-navigation.json`. The shell never
 * hardcodes labels, order or membership: the shipped table is the only source.
 */
internal data class MoteNavItem(
    val id: String,
    val label: String,
    val group: String,
    val order: Int,
    val icon: String,
    val packageId: String,
    val badge: String? = null,
)

/** The generated nine-item navigation table (NV1). */
internal class MoteNavCatalog(val items: List<MoteNavItem>) {
    fun daily(available: (MoteNavItem) -> Boolean = { true }): List<MoteNavItem> = group("daily", available)
    fun manage(available: (MoteNavItem) -> Boolean = { true }): List<MoteNavItem> = group("manage", available)

    private fun group(name: String, available: (MoteNavItem) -> Boolean): List<MoteNavItem> =
        items.filter { it.group == name && available(it) }
            .sortedWith(compareBy<MoteNavItem> { it.order }.thenBy { it.id })

    companion object {
        fun fromAssets(assets: AssetManager): MoteNavCatalog =
            parse(assets.open(ASSET).bufferedReader().use { it.readText() })

        fun parse(json: String): MoteNavCatalog {
            val root = JSONObject(json)
            require(root.getInt("schemaVersion") == 1) { "Unsupported native navigation schema" }
            val items = root.getJSONArray("items")
            val parsed = (0 until items.length()).map { index ->
                val value = items.getJSONObject(index)
                val item = MoteNavItem(
                    id = value.getString("id"),
                    label = value.getString("label"),
                    group = value.getString("group"),
                    order = value.getInt("order"),
                    icon = value.getString("icon"),
                    packageId = value.getString("packageId"),
                    badge = value.optString("badge").takeIf { it.isNotBlank() },
                )
                require(item.id.isNotBlank()) { "Navigation item has no id" }
                require(item.label.isNotBlank()) { "Navigation item ${item.id} has no label" }
                require(item.group in setOf("daily", "manage")) { "Navigation item ${item.id} has an unknown group" }
                require(item.order >= 0) { "Navigation item ${item.id} has an invalid order" }
                require(item.icon.isNotBlank()) { "Navigation item ${item.id} has no icon" }
                require(item.packageId.isNotBlank()) { "Navigation item ${item.id} has no package" }
                require(item.badge == null || item.badge in setOf("ideas", "connections")) { "Navigation item ${item.id} has an unknown badge" }
                item
            }
            require(parsed.map { it.id }.toSet().size == parsed.size) { "Navigation item ids must be unique" }
            return MoteNavCatalog(parsed)
        }

        const val ASSET = "ui-navigation.json"
    }
}

/** Rendered badges: server counts plus the local capture-attention dot. */
internal data class NavBadges(
    val ideas: Int? = null,
    val connections: Boolean = false,
    val library: Boolean = false,
) {
    fun ideasLabel(): String? = ideas?.takeIf { it > 0 }?.let { if (it > 99) "99+" else it.toString() }
}

internal object NavBadgeRules {
    /**
     * A successful nav-state response replaces both server badges: an absent
     * key means its plugin is stopped, so the badge disappears. The local
     * library dot is owned by this client and survives every server answer.
     */
    fun read(state: JSONObject, previous: NavBadges): NavBadges {
        val badges = state.optJSONObject("badges") ?: return previous
        val ideas = (badges.opt("ideas") as? Number)?.toInt()?.coerceAtLeast(0)
        return previous.copy(ideas = ideas, connections = badges.optBoolean("connections", false))
    }

    /** Offline, timed out or forbidden: the last rendered badges stand. */
    fun keep(previous: NavBadges): NavBadges = previous
}

/**
 * Registration seam for client-owned tab dots, used by AN6 for the library
 * capture state. Readers run only while the shell renders; a throwing reader
 * never takes the tab bar down.
 */
internal object MoteLocalBadges {
    private val readers = ConcurrentHashMap<String, () -> Boolean>()
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    fun register(id: String, read: () -> Boolean): () -> Unit {
        readers[id] = read
        return { readers.remove(id, read) }
    }

    fun active(id: String): Boolean = readers[id]?.let { runCatching(it).getOrDefault(false) } ?: false

    /** A producer calls this after a local state change so the bar repaints at once. */
    fun changed() { listeners.toList().forEach { runCatching(it) } }

    fun observe(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners.remove(listener) }
    }
}

/** Lucide names from the authored table resolved onto the shipped line icons. */
internal val MoteNavItem.glyph: MoteGlyph
    get() = when (icon) {
        "message-circle" -> MoteGlyph.ASK
        "newspaper" -> MoteGlyph.PULSE
        "lightbulb" -> MoteGlyph.BOLT
        "square-check" -> MoteGlyph.CHECK
        "layout-grid" -> MoteGlyph.LIBRARY
        "brain" -> MoteGlyph.MEMORY
        "puzzle" -> MoteGlyph.PLUG
        "plug" -> MoteGlyph.LINK
        "sliders-horizontal" -> MoteGlyph.GEAR
        else -> MoteGlyph.FILE
    }

/**
 * The phone bottom bar. Five or fewer entries come from the daily group of the
 * authored table; a stopped package removes its entries without leaving gaps.
 */
internal class MoteTabBar(private val activity: Activity, private val onSelect: (MoteNavItem) -> Unit) : LinearLayout(activity) {
    private val row = LinearLayout(activity).apply { orientation = HORIZONTAL; isBaselineAligned = false; gravity = Gravity.CENTER }
    private val tabs = linkedMapOf<String, TabView>()
    private var selectedId: String? = null
    private var badges = NavBadges()

    init {
        orientation = VERTICAL
        setWillNotDraw(false)
        tag = "local-tab-bar"
        setPadding(0, 0, 0, activity.moteDp(4))
        MoteUi.backgroundColor(this, NativeColorRole.SURFACE)
        addView(row, LayoutParams(-1, activity.moteDp(56)))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val line = Paint().apply { color = NativeColorRole.HAIR.color(); strokeWidth = resources.displayMetrics.density }
        canvas.drawLine(0f, 0f, width.toFloat(), 0f, line)
    }

    fun render(items: List<MoteNavItem>, badges: NavBadges, selected: String?) {
        this.badges = badges
        this.selectedId = selected
        row.removeAllViews()
        tabs.clear()
        items.forEach { item ->
            val tab = TabView(item)
            tabs[item.id] = tab
            row.addView(tab, LayoutParams(0, -1, 1f))
        }
        visibility = if (items.isEmpty()) GONE else VISIBLE
        present()
    }

    fun setBadges(value: NavBadges) {
        badges = value
        present()
    }

    fun select(id: String?) {
        selectedId = id
        present()
    }

    private fun present() {
        tabs.forEach { (id, tab) -> tab.present(id == selectedId, badges) }
    }

    /** The bar owns the navigation-bar inset; the shell must not add a second one. */
    fun dockInsets(shell: NativeAppShell) {
        val baseBottom = paddingBottom
        setOnApplyWindowInsetsListener { view, insets ->
            val bottom = if (Build.VERSION.SDK_INT >= 30) insets.getInsets(WindowInsets.Type.systemBars()).bottom
            else @Suppress("DEPRECATION") insets.systemWindowInsetBottom
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, baseBottom + bottom)
            // Zero the shell's stored bottom inset too: a later presentation refresh
            // re-applies the shell bars and must not add a second strip below the bar.
            shell.systemBars(shell.paddingLeft, shell.paddingTop, shell.paddingRight, if (visibility == GONE) bottom else 0)
            insets
        }
    }

    private inner class TabView(val item: MoteNavItem) : LinearLayout(activity) {
        private val icon = ImageView(activity).apply { setImageResource(item.glyph.drawable); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        private val label = TextView(activity).apply { text = MoteI18n.text(item.label); gravity = Gravity.CENTER; MoteUi.type(this, NativeFontRole.META) }
        private val badge = TextView(activity).apply {
            visibility = GONE; gravity = Gravity.CENTER; minWidth = activity.moteDp(18); minHeight = activity.moteDp(18)
            tag = "local-tab-badge:${item.id}"
            setPadding(activity.moteDp(5), 0, activity.moteDp(5), 0)
            MoteUi.type(this, NativeFontRole.META, medium = true)
            MoteUi.textColor(this, NativeColorRole.ON_ACCENT)
            NativePresentationStyles.bind(this, "nav-badge") { it.background = MoteUi.shape(activity, NativeColorRole.ACCENT, NativeRadiusRole.PILL, false) }
        }
        private val dot = View(activity).apply {
            visibility = GONE
            tag = "local-tab-dot:${item.id}"
            NativePresentationStyles.bind(this, "nav-dot") { it.background = MoteUi.shape(activity, NativeColorRole.WARNING, NativeRadiusRole.PILL, false) }
        }
        private var active = false

        init {
            orientation = VERTICAL; gravity = Gravity.CENTER; isFocusable = true; isClickable = true; isBaselineAligned = false
            tag = "local-tab:${item.id}"
            background = MoteUi.clickable(activity, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
            setOnClickListener { select(item.id); onSelect(item) }
            val iconFrame = FrameLayout(activity)
            iconFrame.addView(icon, FrameLayout.LayoutParams(activity.moteDp(23), activity.moteDp(23), Gravity.CENTER))
            iconFrame.addView(badge, FrameLayout.LayoutParams(-2, activity.moteDp(18), Gravity.TOP or Gravity.END))
            addView(iconFrame, LayoutParams(-1, activity.moteDp(26)))
            addView(label, LayoutParams(-1, -2).apply { topMargin = activity.moteDp(2) })
            addView(dot, LayoutParams(activity.moteDp(8), activity.moteDp(8)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = activity.moteDp(2) })
            NativePresentationStyles.bind(icon, "nav-icon") { value ->
                (value as ImageView).imageTintList = ColorStateList.valueOf((if (active) NativeColorRole.ACCENT else NativeColorRole.MUTED).color())
            }
            NativePresentationStyles.bind(label, "nav-label") {
                (it as TextView).setTextColor((if (active) NativeColorRole.ACCENT else NativeColorRole.MUTED).color())
            }
        }

        fun present(selected: Boolean, value: NavBadges) {
            active = selected
            isSelected = selected
            icon.imageTintList = ColorStateList.valueOf((if (selected) NativeColorRole.ACCENT else NativeColorRole.MUTED).color())
            label.setTextColor((if (selected) NativeColorRole.ACCENT else NativeColorRole.MUTED).color())
            val ideas = if (item.badge == "ideas") value.ideasLabel() else null
            badge.text = ideas.orEmpty()
            badge.visibility = if (ideas == null) GONE else VISIBLE
            dot.visibility = if (item.badge == null && item.id == "library" && value.library) VISIBLE else GONE
            contentDescription = listOfNotNull(
                MoteI18n.text(item.label),
                ideas,
                if (dot.visibility == VISIBLE) MoteI18n.text("需要处理") else null,
            ).joinToString("，")
        }
    }
}

internal data class MoteManageRow(val item: MoteNavItem, val dot: Boolean)

/** The manage rows follow the authored table; only a live connections badge adds its dot. */
internal fun manageRows(items: List<MoteNavItem>, badges: NavBadges): List<MoteManageRow> =
    items.map { MoteManageRow(it, it.badge == "connections" && badges.connections) }

/** The "m" sheet: memory, skills, connections and settings, with their plugin-owned dots. */
internal class MoteManageMenu(private val activity: Activity, private val onSelect: (MoteNavItem) -> Unit) {
    fun show(items: List<MoteNavItem>, badges: NavBadges) {
        if (items.isEmpty()) return
        val dialog = android.app.Dialog(activity)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setContentView(buildView(activity, manageRows(items, badges)) { item -> dialog.dismiss(); onSelect(item) }.apply { tag = "mote-manage-menu" })
        dialog.setCanceledOnTouchOutside(true)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(0.35f)
        }
        dialog.show()
    }

    companion object {
        fun buildView(context: Context, rows: List<MoteManageRow>, onSelect: (MoteNavItem) -> Unit): LinearLayout =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(context.moteDp(8), context.moteDp(8), context.moteDp(8), context.moteDp(24))
                NativePresentationStyles.bind(this, "sheet-surface") { it.background = MoteUi.shape(context, NativeColorRole.SURFACE, NativeRadiusRole.CONTAINER, true, NativeColorRole.HAIR) }
                addView(View(context).apply {
                    NativePresentationStyles.bind(this, "sheet-handle") { it.background = MoteUi.shape(context, NativeColorRole.HAIR, NativeRadiusRole.PILL, false) }
                }, LinearLayout.LayoutParams(context.moteDp(36), context.moteDp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = context.moteDp(4); bottomMargin = context.moteDp(10) })
                rows.forEachIndexed { index, row ->
                    if (index > 0) addView(MoteComponents.divider(context))
                    addView(LinearLayout(context).apply {
                        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
                        minimumHeight = context.moteDp(56); setPadding(context.moteDp(12), 0, context.moteDp(12), 0)
                        isFocusable = true; isClickable = true
                        tag = "menu:" + MoteI18n.text(row.item.label)
                        contentDescription = listOfNotNull(MoteI18n.text(row.item.label), if (row.dot) MoteI18n.text("需要处理") else null).joinToString("，")
                        background = MoteUi.clickable(context, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
                        setOnClickListener { onSelect(row.item) }
                        addView(MoteComponents.icon(context, row.item.glyph, NativeColorRole.INK, 20), LinearLayout.LayoutParams(context.moteDp(20), context.moteDp(20)).apply { marginEnd = context.moteDp(14) })
                        addView(TextView(context).apply {
                            text = MoteI18n.text(row.item.label); MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
                        }, LinearLayout.LayoutParams(0, -2, 1f))
                        addView(View(context).apply {
                            visibility = if (row.dot) View.VISIBLE else View.GONE
                            tag = "manage-dot:${row.item.id}"
                            NativePresentationStyles.bind(this, "manage-dot") { it.background = MoteUi.shape(context, NativeColorRole.WARNING, NativeRadiusRole.PILL, false) }
                        }, LinearLayout.LayoutParams(context.moteDp(8), context.moteDp(8)).apply { marginEnd = context.moteDp(10) })
                        addView(MoteComponents.icon(context, MoteGlyph.CHEV, NativeColorRole.MUTED, 16), LinearLayout.LayoutParams(context.moteDp(16), context.moteDp(16)))
                    }, LinearLayout.LayoutParams(-1, context.moteDp(56)))
                }
            }
    }
}

object MoteNavigation {
    // Android renders the authored table through MoteTabBar; these route groups remain for deep links.
    fun primaryTabs(): List<MotePrimaryTab> = emptyList()
    fun initialLocalPage(): String = "ASK"
    fun initialTabId(): String = "chat"
    /** Which bottom tab owns a local page; null means a manage/detail page keeps the current tab. */
    fun tabId(page: String): String? = when (page) {
        "OVERVIEW", "ASK" -> "chat"
        "FEED" -> "feed"
        "IDEAS" -> "ideas"
        "GOALS" -> "goals"
        "LIBRARY", "NOTES" -> "library"
        else -> null
    }
    val libraryPages = listOf("archive", "materials", "coding", "timeline", "files", "memories", "notes", "imports", "insights", "agentView")
    // Legacy Coding transport links retain their library context, but are not content types.
    val libraryBrowsePages = libraryPages.filterNot { it == "coding" }
    /** Search reads the same archive as the library pages; it is an entry, not another content type. */
    const val SEARCH = "search"
    fun libraryRoute(page: String) = page in libraryPages || page == SEARCH
    val groups = listOf(
        MoteNavigationGroup("资料库", libraryBrowsePages),
        MoteNavigationGroup("首页", listOf("overview", "actions", "assistant.feed", "assistant.matters", "assistant.workbench", "activity")),
        MoteNavigationGroup("来源", listOf("sources", "devices", "connections", "lark")),
        MoteNavigationGroup("管理与维护", listOf("statistics", "processing", "plugins", "settings", "usage", "vault", "developer", "about", "help"))
    )
    fun centralAllowsAdd(@Suppress("UNUSED_PARAMETER") page: String): Boolean = false
    fun centralTab(page: String): MotePrimaryTab = when (page) {
        "overview", "actions", "assistant.feed", "assistant.matters", "assistant.workbench" -> MotePrimaryTab.HOME
        "ask", "conversations" -> MotePrimaryTab.ASK
        "sources", "devices", "connections", "lark" -> MotePrimaryTab.SOURCES
        "activity", "processing" -> MotePrimaryTab.ACTIVITY
        in libraryPages -> MotePrimaryTab.LIBRARY
        else -> MotePrimaryTab.LIBRARY
    }
    fun localTab(page: String): MotePrimaryTab = when (page) {
        "OVERVIEW" -> MotePrimaryTab.HOME
        "LIBRARY", "NOTES" -> MotePrimaryTab.LIBRARY
        "ASK" -> MotePrimaryTab.ASK
        "SOURCES", "CONNECTION", "CAPTURE", "PRIVACY", "PERMISSIONS" -> MotePrimaryTab.SOURCES
        "ACTIVITY" -> MotePrimaryTab.ACTIVITY
        else -> MotePrimaryTab.LIBRARY
    }
    fun centralParent(page: String): String? = when {
        page == "sources" || page == "activity" -> null
        page in setOf("devices", "connections", "lark") -> "sources"
        page == "processing" -> "activity"
        page in libraryPages -> "archive".takeUnless { page == it }
        page == "actions" -> "overview"
        page in setOf("assistant.feed", "assistant.matters", "assistant.workbench") -> "overview"
        page == "extensions" -> "about"
        page in groups.drop(2).flatMap { it.pages } -> "about".takeUnless { page == it }
        else -> null
    }
    fun isFirstUse(hasConnection: Boolean, captureEnabled: Boolean, lastCapture: String?, hasRecords: Boolean, centralConfirmedEmpty: Boolean = false) =
        (!hasConnection || centralConfirmedEmpty) && !captureEnabled && lastCapture == null && !hasRecords
}
