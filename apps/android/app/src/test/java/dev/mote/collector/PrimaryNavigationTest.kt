package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PrimaryNavigationTest {
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

    @Test fun theAuthoredTableOrdersTheDailyAndManageGroups() {
        assertEquals(listOf("chat", "feed", "ideas", "goals", "library"), catalog().daily().map { it.id })
        assertEquals(listOf("memory", "skills", "connections", "settings"), catalog().manage().map { it.id })
    }

    @Test fun theShippedOrderComesFromTheTableAndIsNeverHardcoded() {
        val reversed = """
            {"schemaVersion":1,"items":[
              {"id":"library","label":"资料库","group":"daily","order":10,"icon":"layout-grid","packageId":"mote.library"},
              {"id":"chat","label":"聊天","group":"daily","order":20,"icon":"message-circle","packageId":"mote.ask"}
            ]}
        """.trimIndent()
        assertEquals(listOf("library", "chat"), MoteNavCatalog.parse(reversed).daily().map { it.id })
    }

    /** AN1-01: a stopped assistant package removes feed, ideas, goals and memory without shifting the rest. */
    @Test fun aStoppedAssistantPackageLeavesChatAndLibraryAndRemovesMemory() {
        val catalog = catalog()
        val available = { item: MoteNavItem -> item.packageId != "mote.assistant" }
        assertEquals(listOf("chat", "library"), catalog.daily(available).map { it.id })
        assertEquals(listOf("skills", "connections", "settings"), catalog.manage(available).map { it.id })
        assertFalse(catalog.manage(available).any { it.id == "memory" })
    }

    @Test fun anItemWithoutItsPackageNeverLeavesAGap() {
        val catalog = catalog()
        val daily = catalog.daily { it.id != "goals" }
        assertEquals(listOf("chat", "feed", "ideas", "library"), daily.map { it.id })
    }

    /** AN1-02: the ideas count is the server badge, rendered verbatim. */
    @Test fun theIdeasBadgeDisplaysTheServerCount() {
        val state = JSONObject("""{"revisions":{},"badges":{"ideas":6,"connections":false}}""")
        val badges = NavBadgeRules.read(state, NavBadges())
        assertEquals(6, badges.ideas)
        assertEquals("6", badges.ideasLabel())
        assertNull("zero is not shown", NavBadges(ideas = 0).ideasLabel())
        assertEquals("99+", NavBadges(ideas = 120).ideasLabel())
    }

    /** AN1-03: only a live connections badge puts the dot in the manage rows. */
    @Test fun onlyALiveConnectionsFlagDotsTheConnectionsRow() {
        val rows = manageRows(catalog().manage(), NavBadges(connections = true))
        assertEquals(listOf("memory", "skills", "connections", "settings"), rows.map { it.item.id })
        assertEquals(listOf("connections"), rows.filter { it.dot }.map { it.item.id })
        assertTrue(manageRows(catalog().manage(), NavBadges(connections = false)).none { it.dot })
    }

    /** AN1-05: an offline or forbidden read keeps the last rendered counts. */
    @Test fun offlineKeepsTheLastRenderedBadges() {
        val online = NavBadgeRules.read(JSONObject("""{"badges":{"ideas":6,"connections":true}}"""), NavBadges())
        val offline = NavBadgeRules.keep(online)
        assertEquals(6, offline.ideas)
        assertTrue(offline.connections)
        assertEquals(online, offline)
    }

    @Test fun aSuccessfulResponseClearsABadgeItsOwnerNoLongerReports() {
        val previous = NavBadges(ideas = 6, connections = true)
        val next = NavBadgeRules.read(JSONObject("""{"badges":{}}"""), previous)
        assertNull(next.ideas)
        assertFalse(next.connections)
    }

    /** AN1-04: a phone that stopped on the old home opens the chat tab. */
    @Test fun theOldHomeDestinationOpensChat() {
        assertEquals("ASK", MoteNavigation.initialLocalPage())
        assertEquals("chat", MoteNavigation.initialTabId())
        assertEquals("chat", MoteNavigation.tabId("OVERVIEW"))
        assertEquals("chat", MoteNavigation.tabId("ASK"))
        assertEquals("library", MoteNavigation.tabId("LIBRARY"))
        assertEquals("feed", MoteNavigation.tabId("FEED"))
        assertEquals("ideas", MoteNavigation.tabId("IDEAS"))
        assertEquals("goals", MoteNavigation.tabId("GOALS"))
        assertNull("manage pages keep the current tab", MoteNavigation.tabId("SETTINGS"))
        assertNull(MoteNavigation.tabId("MEMORY"))
    }

    @Test fun aLocalLibraryBadgeIsClientOwnedAndSafeToRead() {
        val unregister = MoteLocalBadges.register("library") { true }
        try {
            assertTrue(MoteLocalBadges.active("library"))
        } finally { unregister() }
        assertFalse(MoteLocalBadges.active("library"))
        assertFalse("an unregistered reader is not attention", MoteLocalBadges.active("missing"))
    }

    @Test fun aLocalBadgeChangeNotifiesTheShellUntilUnregistered() {
        var calls = 0
        val stop = MoteLocalBadges.observe { calls++ }
        try {
            MoteLocalBadges.changed()
            MoteLocalBadges.changed()
            assertEquals(2, calls)
        } finally { stop() }
        MoteLocalBadges.changed()
        assertEquals("a stopped observer is not called again", 2, calls)
    }

    @Test fun theGlobalRecordActionOnlyBelongsToTheLightHome() {
        for (page in listOf("overview", "actions", "archive", "files", "notes", "ask")) {
            assertFalse("Secondary content pages do not repeat the home record action: $page", MoteNavigation.centralAllowsAdd(page))
        }
        for (page in listOf("settings", "connections", "devices", "plugins", "vault", "processing", "developer", "about")) {
            assertFalse("Maintenance stays focused on $page", MoteNavigation.centralAllowsAdd(page))
        }
    }

    @Test fun localAndCentralObjectsStayInTheSamePrimaryDestination() {
        assertEquals(MoteNavigation.localTab("LIBRARY"), MoteNavigation.centralTab("archive"))
        assertEquals(MoteNavigation.localTab("NOTES"), MoteNavigation.centralTab("notes"))
        assertEquals(MoteNavigation.localTab("ASK"), MoteNavigation.centralTab("ask"))
        assertEquals(MoteNavigation.localTab("CONNECTION"), MoteNavigation.centralTab("connections"))
        assertEquals(MoteNavigation.localTab("OVERVIEW"), MoteNavigation.centralTab("actions"))
    }

    @Test fun groupedNavigationKeepsEveryExistingCentralCapabilityReachable() {
        val registered = setOf("overview", "activity", "archive", "ask", "notes", "materials", "coding", "timeline", "files", "memories", "insights",
            "actions", "agentView", "sources", "devices", "connections", "lark", "statistics", "processing", "plugins", "settings",
            "usage", "vault", "developer", "about", "imports", "help", "assistant.workbench", "assistant.feed", "assistant.matters")
        val grouped = MoteNavigation.groups.flatMap { it.pages }
        assertEquals("Ask has its own destination; legacy Coding status is reached contextually", registered - setOf("ask", "coding"), grouped.toSet())
        assertEquals("A capability has one canonical utility menu location", grouped.size, grouped.toSet().size)
        assertFalse(MoteNavigation.libraryBrowsePages.contains("coding"))
        assertEquals(MotePrimaryTab.LIBRARY, MoteNavigation.centralTab("coding"))
        assertEquals("archive", MoteNavigation.centralParent("coding"))
        assertEquals(MotePrimaryTab.SOURCES, MoteNavigation.localTab("SOURCES"))
        assertEquals(MotePrimaryTab.ACTIVITY, MoteNavigation.centralTab("activity"))
    }

    @Test fun searchReadsTheLibraryWithoutBecomingAContentType() {
        assertTrue(MoteNavigation.libraryRoute(MoteNavigation.SEARCH))
        assertFalse(MoteNavigation.libraryBrowsePages.contains(MoteNavigation.SEARCH))
        assertFalse(MoteNavigation.groups.flatMap { it.pages }.contains(MoteNavigation.SEARCH))
        assertEquals(MotePrimaryTab.LIBRARY, MoteNavigation.centralTab(MoteNavigation.SEARCH))
        assertNull("Search opens from the home and returns there", MoteNavigation.centralParent(MoteNavigation.SEARCH))
        assertTrue(CentralScreens.pages.any { it.first == MoteNavigation.SEARCH && it.second == "搜索资料" })
    }

    @Test fun deepLinksHaveBackPathsInsideTheirExistingPrimaryDestination() {
        listOf("files", "memories", "notes", "imports", "insights", "agentView").forEach { page ->
            assertEquals("archive", MoteNavigation.centralParent(page))
            assertEquals(MoteNavigation.centralTab(page), MoteNavigation.centralTab(MoteNavigation.centralParent(page)!!))
        }
        assertEquals("overview", MoteNavigation.centralParent("actions"))
        assertEquals("overview", MoteNavigation.centralParent("assistant.workbench"))
        assertEquals("about", MoteNavigation.centralParent("settings"))
        assertEquals("about", MoteNavigation.centralParent("plugins"))
        assertEquals("about", MoteNavigation.centralParent("extensions"))
        listOf("overview", "archive", "ask", "about").forEach { assertNull(MoteNavigation.centralParent(it)) }
        assertNull("The conversation list returns to its host home, not Central overview", MoteNavigation.centralParent("conversations"))
    }

    @Test fun offlineNotesAndExistingRecordsNeverBecomeAnEmptyFirstUseScreen() {
        assertTrue(MoteNavigation.isFirstUse(false, false, null, false))
        assertFalse(MoteNavigation.isFirstUse(false, false, null, true))
        assertFalse(MoteNavigation.isFirstUse(false, false, "2026-10-01T10:00:00Z", false))
        assertFalse(MoteNavigation.isFirstUse(false, true, null, false))
        assertFalse(MoteNavigation.isFirstUse(true, false, null, false))
        assertTrue(MoteNavigation.isFirstUse(true, false, null, false, centralConfirmedEmpty = true))
        assertFalse(MoteNavigation.isFirstUse(true, false, null, true, centralConfirmedEmpty = true))
        assertFalse(MoteNavigation.isFirstUse(true, true, null, false, centralConfirmedEmpty = true))
    }

    @Test fun interruptedCaptureRemainsActionableAfterSafeStopWhileIntentionalPauseIsQuiet() {
        assertTrue(CaptureOverview.attention(false, "permission_required", false, true, false))
        assertTrue(CaptureOverview.attention(false, "error", false, false, false))
        assertFalse(CaptureOverview.attention(false, "paused", false, true, false))
        assertFalse(CaptureOverview.attention(true, "paused", true, false, false))
        assertTrue(CaptureOverview.attention(true, "capturing", false, true, false))
    }
}
