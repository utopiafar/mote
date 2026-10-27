package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class PrimaryNavigationTest {
    @Test fun recordAdditionStaysInContentJourneysInsteadOfMaintenance() {
        for (page in listOf("overview", "actions", "archive", "files", "notes", "ask")) {
            assertTrue("Record action remains available on $page", MoteNavigation.centralAllowsAdd(page))
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
        val registered = setOf("overview", "archive", "ask", "notes", "materials", "coding", "timeline", "files", "memories", "insights",
            "actions", "agentView", "sources", "devices", "connections", "lark", "statistics", "processing", "plugins", "settings",
            "usage", "vault", "developer", "about", "imports", "help")
        val grouped = MoteNavigation.groups.flatMap { it.pages }
        assertEquals("Ask has its own destination; legacy Coding status is reached contextually", registered - setOf("ask", "coding"), grouped.toSet())
        assertEquals("A capability has one canonical utility menu location", grouped.size, grouped.toSet().size)
        assertFalse(MoteNavigation.libraryBrowsePages.contains("coding"))
        assertEquals(MotePrimaryTab.LIBRARY, MoteNavigation.centralTab("coding"))
        assertEquals("archive", MoteNavigation.centralParent("coding"))
        assertEquals(listOf("首页", "资料库", "问一问", "来源"), MoteNavigation.primaryTabs().map { it.titleKey })
        assertEquals("OVERVIEW", MoteNavigation.initialLocalPage())
        assertEquals(MotePrimaryTab.SOURCES, MoteNavigation.localTab("SOURCES"))
        assertEquals(MotePrimaryTab.ACTIVITY, MoteNavigation.centralTab("activity"))
    }

    @Test fun deepLinksHaveBackPathsInsideTheirExistingPrimaryDestination() {
        listOf("files", "memories", "notes", "imports", "insights", "agentView").forEach { page ->
            assertEquals("archive", MoteNavigation.centralParent(page))
            assertEquals(MoteNavigation.centralTab(page), MoteNavigation.centralTab(MoteNavigation.centralParent(page)!!))
        }
        assertEquals("overview", MoteNavigation.centralParent("actions"))
        assertEquals("about", MoteNavigation.centralParent("settings"))
        assertEquals("about", MoteNavigation.centralParent("plugins"))
        assertEquals("about", MoteNavigation.centralParent("extensions"))
        listOf("overview", "archive", "ask", "about").forEach { assertNull(MoteNavigation.centralParent(it)) }
    }

    @Test fun offlineNotesAndExistingRecordsNeverBecomeAnEmptyFirstUseScreen() {
        assertTrue(MoteNavigation.isFirstUse(false, false, null, false))
        assertFalse(MoteNavigation.isFirstUse(false, false, null, true))
        assertFalse(MoteNavigation.isFirstUse(false, false, "2026-10-01T10:00:00Z", false))
        assertFalse(MoteNavigation.isFirstUse(false, true, null, false))
        assertFalse(MoteNavigation.isFirstUse(true, false, null, false))
    }
}
