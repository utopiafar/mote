package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** H04/H05 and G01 rules that the tab shell keeps. */
class TabFrameTest {
    @Test fun draftChangesOnlyTheRecordLabel() {
        assertEquals("记录", TabFrame.recordLabel(hasDraft = false))
        assertEquals("继续草稿", TabFrame.recordLabel(hasDraft = true))
        assertEquals(MotePrimaryTab.ASK, MoteNavigation.localTab(TabFrame.ASK_PAGE))
    }

    @Test fun photoAndAudioStartTheirOwnMediaInTheEditor() {
        assertEquals(listOf(MoteQuickEntry.PHOTO, MoteQuickEntry.AUDIO), TabFrame.captureEntries)
        assertEquals("camera", TabFrame.startMedia(MoteQuickEntry.PHOTO))
        assertEquals("audio", TabFrame.startMedia(MoteQuickEntry.AUDIO))
        assertNull(TabFrame.startMedia(MoteQuickEntry.RECORD))
        assertNull(TabFrame.startMedia(MoteQuickEntry.ASK))
        assertFalse("Ask has its own destination", TabFrame.captureEntries.contains(MoteQuickEntry.ASK))
    }

    @Test fun topBarDoesNotReserveMoreThanTheDesignTopArea() {
        assertEquals((TabFrame.TOP_BAR_TOP_DP * 2.625f).toInt(), TabFrame.topBarTop(132, 2.625f))
        assertEquals(63, TabFrame.topBarTop(63, 2.625f))
        assertEquals(0, TabFrame.topBarTop(0, 2.625f))
    }

    @Test fun homeHasNoGreetingWelcomeOrFirstUseParagraph() {
        val activity = File(checkNotNull(System.getProperty("user.dir")), "src/main/java/dev/mote/collector/MainActivity.kt").readText()
        for (retired in listOf("想问什么？", "欢迎使用 Mote", "欢迎回来", "最近留下的内容", "先留下，再慢慢想。", "先记下一件事。", "留下想法、照片或录音。")) {
            assertFalse("Retired home copy returned: $retired", activity.contains(retired))
        }
        assertTrue("The brand mark and search remain the only home app-bar actions", activity.contains("home-m-action") && activity.contains("home-search-action"))
    }
}
