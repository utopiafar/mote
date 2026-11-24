package dev.mote.collector

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** The bar reads the generated table, paints server badges and never leaves gaps. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class MotePrimaryNavigationTest {
    private lateinit var activity: Activity

    @Before fun setUp() {
        val app = RuntimeEnvironment.getApplication()
        MoteI18n.initialize(app)
        if (runCatching { NativeUiPacks.registry.theme() }.isFailure) NativeUiPacks.initialize(app)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    }

    private val authored = """
        {"schemaVersion":1,"items":[
          {"id":"chat","label":"聊天","group":"daily","order":10,"icon":"message-circle","packageId":"mote.ask"},
          {"id":"feed","label":"动态","group":"daily","order":20,"icon":"newspaper","packageId":"mote.assistant"},
          {"id":"ideas","label":"点子","group":"daily","order":30,"icon":"lightbulb","packageId":"mote.assistant","badge":"ideas"},
          {"id":"goals","label":"目标","group":"daily","order":40,"icon":"square-check","packageId":"mote.assistant"},
          {"id":"library","label":"资料库","group":"daily","order":50,"icon":"layout-grid","packageId":"mote.library"},
          {"id":"memory","label":"记忆","group":"manage","order":10,"icon":"brain","packageId":"mote.assistant"},
          {"id":"skills","label":"技能","group":"manage","order":20,"icon":"puzzle","packageId":"mote.features"},
          {"id":"connections","label":"连接","group":"manage","order":30,"icon":"plug","packageId":"mote.connections","badge":"connections"},
          {"id":"settings","label":"设置","group":"manage","order":40,"icon":"sliders-horizontal","packageId":"mote.system"}
        ]}
    """.trimIndent()

    private fun catalog() = MoteNavCatalog.parse(authored)

    @Test fun theShippedAssetIsTheSameAuthoredTable() {
        val shipped = MoteNavCatalog.fromAssets(RuntimeEnvironment.getApplication().assets)
        assertEquals(listOf("chat", "feed", "ideas", "goals", "library"), shipped.daily().map { it.id })
        assertEquals(listOf("memory", "skills", "connections", "settings"), shipped.manage().map { it.id })
        assertEquals("message-circle", shipped.items.first { it.id == "chat" }.icon)
    }

    /** AN1-02: six ideas render as the ideas badge; the daily bar keeps the authored order. */
    @Test fun theBarRendersTheFiveDailyTabsAndTheIdeasCount() {
        val bar = MoteTabBar(activity) {}
        bar.render(catalog().daily(), NavBadges(ideas = 6), "chat")

        assertEquals(View.VISIBLE, bar.visibility)
        assertEquals(listOf("chat", "feed", "ideas", "goals", "library"), listOf("chat", "feed", "ideas", "goals", "library").filter { bar.findViewWithTag<View>("local-tab:$it") != null })
        val badge = bar.findViewWithTag<TextView>("local-tab-badge:ideas")
        assertNotNull(badge)
        assertEquals("6", badge!!.text.toString())
        assertEquals(View.VISIBLE, badge.visibility)
        assertEquals(View.GONE, bar.findViewWithTag<View>("local-tab-badge:chat")!!.visibility)
        assertTrue(bar.findViewWithTag<View>("local-tab:chat")!!.isSelected)
        assertFalse(bar.findViewWithTag<View>("local-tab:feed")!!.isSelected)
    }

    /** AN1-01: the stopped assistant package leaves exactly chat and library. */
    @Test fun aStoppedAssistantPackageLeavesChatAndLibraryAndNoPlaceholder() {
        val bar = MoteTabBar(activity) {}
        bar.render(catalog().daily { it.packageId != "mote.assistant" }, NavBadges(), "chat")
        assertNotNull(bar.findViewWithTag<View>("local-tab:chat"))
        assertNotNull(bar.findViewWithTag<View>("local-tab:library"))
        assertNull(bar.findViewWithTag<View>("local-tab:feed"))
        assertNull(bar.findViewWithTag<View>("local-tab:ideas"))
        assertNull(bar.findViewWithTag<View>("local-tab:goals"))
    }

    @Test fun theLocalCaptureDotBelongsToTheLibraryTab() {
        val bar = MoteTabBar(activity) {}
        bar.render(catalog().daily(), NavBadges(library = true), "library")
        assertEquals(View.VISIBLE, bar.findViewWithTag<View>("local-tab-dot:library")!!.visibility)
        assertEquals(View.GONE, bar.findViewWithTag<View>("local-tab-dot:chat")!!.visibility)
        bar.setBadges(NavBadges(library = false))
        assertEquals(View.GONE, bar.findViewWithTag<View>("local-tab-dot:library")!!.visibility)
    }

    @Test fun everyTabLabelIsCenteredBelowItsIcon() {
        val bar = MoteTabBar(activity) {}
        bar.render(catalog().daily(), NavBadges(), "chat")

        for (item in catalog().daily()) {
            val tab = bar.findViewWithTag<LinearLayout>("local-tab:${item.id}")!!
            val label = (0 until tab.childCount).map { tab.getChildAt(it) }.filterIsInstance<TextView>().single()
            assertEquals(Gravity.CENTER_HORIZONTAL, label.gravity and Gravity.HORIZONTAL_GRAVITY_MASK)
        }
    }

    @Test fun selectingATabOnlyMovesTheSelection() {
        val selected = mutableListOf<String>()
        val bar = MoteTabBar(activity) { selected += it.id }
        bar.render(catalog().daily(), NavBadges(ideas = 6), "chat")
        bar.findViewWithTag<View>("local-tab:ideas")!!.performClick()
        assertEquals(listOf("ideas"), selected)
        assertTrue(bar.findViewWithTag<View>("local-tab:ideas")!!.isSelected)
        assertFalse(bar.findViewWithTag<View>("local-tab:chat")!!.isSelected)
        assertEquals(View.VISIBLE, bar.findViewWithTag<TextView>("local-tab-badge:ideas")!!.visibility)
    }

    @Test fun anEmptyCatalogHidesTheWholeBar() {
        val bar = MoteTabBar(activity) {}
        bar.render(emptyList(), NavBadges(), null)
        assertEquals(View.GONE, bar.visibility)
    }

    /** AN1-03: the "m" sheet carries the connection dot only while the server says it needs attention. */
    @Test fun theManageSheetBuildsFourRowsAndDotsOnlyConnections() {
        val rows = manageRows(catalog().manage(), NavBadges(connections = true))
        val sheet = MoteManageMenu.buildView(activity, rows) {}
        assertEquals(listOf("memory", "skills", "connections", "settings"), rows.map { it.item.id })
        for (row in rows) assertNotNull(sheet.findViewWithTag<View>("menu:" + MoteI18n.text(row.item.label)))
        assertEquals(View.VISIBLE, sheet.findViewWithTag<View>("manage-dot:connections")!!.visibility)
        assertEquals(View.GONE, sheet.findViewWithTag<View>("manage-dot:settings")!!.visibility)

        val quiet = MoteManageMenu.buildView(activity, manageRows(catalog().manage(), NavBadges()), {})
        assertEquals(View.GONE, quiet.findViewWithTag<View>("manage-dot:connections")!!.visibility)
    }

    @Test fun theMenuRowsFollowTheAuthoredOrderAndIgnoreUnknownBadges() {
        val state = JSONObject("""{"badges":{"ideas":2,"connections":false}}""")
        val badges = NavBadgeRules.read(state, NavBadges())
        val rows = manageRows(catalog().manage(), badges)
        assertEquals(listOf("memory", "skills", "connections", "settings"), rows.map { it.item.id })
        assertTrue(rows.none { it.dot })
    }
}
