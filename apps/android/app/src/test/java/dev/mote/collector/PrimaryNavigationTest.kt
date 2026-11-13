package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class PrimaryNavigationTest {
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
        assertTrue("Management routes live in the secondary menu, not persistent tabs", MoteNavigation.primaryTabs().isEmpty())
        assertEquals("OVERVIEW", MoteNavigation.initialLocalPage())
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
