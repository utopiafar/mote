package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** H04/H05/H06 and G01 rules that the home dock and status notice must keep. */
class HomeFrameTest {
    @Test fun draftChangesOnlyTheRecordLabel() {
        assertEquals("记录", HomeFrame.recordLabel(hasDraft = false))
        assertEquals("继续草稿", HomeFrame.recordLabel(hasDraft = true))
        assertEquals(MotePrimaryTab.ASK, MoteNavigation.localTab(HomeFrame.ASK_PAGE))
    }

    @Test fun photoAndAudioStartTheirOwnMediaInTheEditor() {
        assertEquals(listOf(MoteQuickEntry.PHOTO, MoteQuickEntry.AUDIO), HomeFrame.captureEntries)
        assertEquals("camera", HomeFrame.startMedia(MoteQuickEntry.PHOTO))
        assertEquals("audio", HomeFrame.startMedia(MoteQuickEntry.AUDIO))
        assertNull(HomeFrame.startMedia(MoteQuickEntry.RECORD))
        assertNull(HomeFrame.startMedia(MoteQuickEntry.ASK))
        assertFalse("Ask has its own destination", HomeFrame.captureEntries.contains(MoteQuickEntry.ASK))
    }

    @Test fun topBarDoesNotReserveMoreThanTheDesignTopArea() {
        assertEquals((HomeFrame.TOP_BAR_TOP_DP * 2.625f).toInt(), HomeFrame.topBarTop(132, 2.625f))
        assertEquals(63, HomeFrame.topBarTop(63, 2.625f))
        assertEquals(0, HomeFrame.topBarTop(0, 2.625f))
    }

    @Test fun normalCaptureStaysOffTheHome() {
        fun facts(
            connection: CaptureConnection = CaptureConnection.CONNECTED,
            enabled: Boolean = true,
            live: Boolean = true,
            permission: CapturePermission? = null,
            sync: CaptureSyncState = CaptureSyncState.IDLE,
        ) = CaptureStatusFacts(connection, enabled, live, permission = permission, syncState = sync)

        assertNull(HomeNotice.from(facts()))
        assertEquals(CaptureStatusLevel.REMINDER, HomeNotice.from(facts(enabled = false))?.level)
        assertEquals(CaptureStatusLevel.NEEDS_ACTION, HomeNotice.from(facts(permission = CapturePermission.MISSING))?.level)
        assertEquals("连接你的 Mote", HomeNotice.from(facts(connection = CaptureConnection.UNCONFIGURED, enabled = false, live = false, sync = CaptureSyncState.UNCONFIGURED))?.titleKey)
    }

    @Test fun homeHasNoGreetingWelcomeOrFirstUseParagraph() {
        val activity = File(checkNotNull(System.getProperty("user.dir")), "src/main/java/dev/mote/collector/MainActivity.kt").readText()
        for (retired in listOf("想问什么？", "欢迎使用 Mote", "欢迎回来", "最近留下的内容", "先留下，再慢慢想。", "先记下一件事。", "留下想法、照片或录音。")) {
            assertFalse("Retired home copy returned: $retired", activity.contains(retired))
        }
        assertTrue("The brand mark and search remain the only home app-bar actions", activity.contains("home-m-action") && activity.contains("home-search-action"))
    }
}
