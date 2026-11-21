package dev.mote.collector

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import dev.mote.collector.plugins.LibraryCaptureFaces
import dev.mote.collector.plugins.LibrarySourceBar
import dev.mote.collector.plugins.LibrarySourceFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/** AN6: the moved capture switches and the library's capture row/dot keep their one state source. */
@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, shadows = [AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class], sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class CaptureSourcesTest {
    private fun facts(
        enabled: Boolean = true, state: String = "capturing", screenSelected: Boolean = true, screenLive: Boolean = true,
    ) = CaptureOverview.Facts(
        enabled = enabled, state = state, message = "Generated capture state", used = true,
        screenSelected = screenSelected, screenLive = screenLive, projection = false, screenPausedAt = null,
        notifications = false, deviceEvents = false, media = false, systemLive = false,
        queueFull = false, folders = 0, connected = true, sendPaused = false, sendState = "idle",
        pending = null, acknowledged = false,
    )

    /** AN6-01: the screen row keeps 我的 Mote's pause/apply/resume commands. */
    @Test fun theMovedScreenSwitchKeepsTheSameCommands() {
        assertEquals(CaptureSwitches.ScreenCommand.PAUSE_SCREEN,
            CaptureSwitches.screenCommand(on = false, enabled = true, screenSelected = true, screenPaused = false))
        assertEquals(CaptureSwitches.ScreenCommand.DISABLE_SCREEN,
            CaptureSwitches.screenCommand(on = false, enabled = false, screenSelected = true, screenPaused = false))
        assertEquals(CaptureSwitches.ScreenCommand.NONE,
            CaptureSwitches.screenCommand(on = false, enabled = true, screenSelected = false, screenPaused = false))
        assertEquals(CaptureSwitches.ScreenCommand.OPEN_CAPTURE,
            CaptureSwitches.screenCommand(on = true, enabled = false, screenSelected = true, screenPaused = false))
        assertEquals(CaptureSwitches.ScreenCommand.RESUME_CAPTURE,
            CaptureSwitches.screenCommand(on = true, enabled = true, screenSelected = true, screenPaused = true))
        assertEquals(CaptureSwitches.ScreenCommand.ENABLE_SCREEN,
            CaptureSwitches.screenCommand(on = true, enabled = true, screenSelected = false, screenPaused = false))
        assertTrue("Sending off stores the same pause", CaptureSwitches.sendPaused(on = false))
        assertFalse("Sending on clears the pause", CaptureSwitches.sendPaused(on = true))
    }

    /** AN6-02: a missing collection permission replaces the switch with 处理 and the same repair step. */
    @Test fun aMissingPermissionReplacesTheSwitchWithHandle() {
        val state = ManageMenu.state(captureEnabled = true, screenSelected = true, screenLive = false, sendPaused = false)
        assertTrue(state.screenPermission)
        assertTrue("The hidden switch keeps 我的 Mote's enabled-and-selected position", state.screenOn)
        assertEquals(CaptureSwitches.ScreenTrailing.FIX, CaptureSwitches.screenTrailing(state.screenPermission))
        assertEquals(CaptureOverview.Action.PERMISSIONS, ManageMenu.screenPermissionAction(projection = false))
        assertEquals(CaptureOverview.Action.RESTART, ManageMenu.screenPermissionAction(projection = true))
        assertEquals(CaptureSwitches.ScreenTrailing.SWITCH,
            CaptureSwitches.screenTrailing(ManageMenu.state(true, true, true, false).screenPermission))
    }

    /** AN6-03: the capture row exists only for 这台手机; its click opens 采集与同步. */
    @Test fun theCaptureRowBelongsToThisPhone() {
        val activity = Robolectric.buildActivity(MoteActivity::class.java).setup().get()
        val settings = Settings(activity)
        settings.enabled = true
        settings.status("permission_required", "Generated permission")
        val bar = LibrarySourceBar(activity, LibrarySourceFilter.Phone, {})
        try {
            val row = requireNotNull(bar.findViewWithTag<View>("library-capture-sync"))
            assertTrue(texts(row).contains("等待采集权限"))
            assertEquals(View.VISIBLE, bar.findViewWithTag<View>("library-source-dot:phone")?.visibility)

            bar.findViewWithTag<TextView>("library-source:all")!!.performClick()
            assertNull("Another source hides the capture row", bar.findViewWithTag<View>("library-capture-sync"))

            bar.findViewWithTag<TextView>("library-source:phone")!!.performClick()
            val again = requireNotNull(bar.findViewWithTag<View>("library-capture-sync"))
            again.performClick()
            assertEquals(SourcesActivity::class.java.name, shadowOf(activity).nextStartedActivity.component?.className)
        } finally {
            bar.close()
        }
    }

    /** AN6-04: the library dot follows the same actionable answer and clears after the fix. */
    @Test fun theLibraryDotFollowsActionableCapture() {
        var current = facts(screenLive = false)
        val unregister = MoteLocalBadges.register("library") { LibraryCaptureFaces.of(current).attention }
        try {
            assertTrue(MoteLocalBadges.active("library"))
            current = facts(screenLive = true)
            assertFalse("A repaired capture clears the library dot", MoteLocalBadges.active("library"))
        } finally {
            unregister()
        }
        assertFalse(MoteLocalBadges.active("library"))
    }

    @Test fun thePhoneDotBecomesAQuietStateWhenTheOwnerPausesCapture() {
        val activity = Robolectric.buildActivity(MoteActivity::class.java).setup().get()
        val settings = Settings(activity)
        settings.enabled = true
        settings.status("permission_required", "Generated permission")
        val bar = LibrarySourceBar(activity, LibrarySourceFilter.Phone, {})
        try {
            assertNotNull(bar.findViewWithTag<View>("library-source-dot:phone"))
            settings.enabled = false
            settings.status("paused", "Generated pause")
            bar.updatePhone()
            assertNull("A deliberate pause is not an actionable problem", bar.findViewWithTag<View>("library-source-dot:phone"))
            val row = requireNotNull(bar.findViewWithTag<View>("library-capture-sync"))
            assertTrue(texts(row).contains("采集已暂停"))
        } finally {
            bar.close()
        }
    }

    /** AN6-05: the panel's 采集与同步 entry opens the same page (原 C08). */
    @Test fun thePanelCaptureSyncEntryOpensTheCaptureSyncPage() {
        assertEquals(listOf("采集与同步", "采集范围", "采集与存储详情", "来源"), CapturePanelMenu.more.map { it.titleKey })
        val entry = CapturePanelMenu.more.first()
        assertEquals(CapturePanelPage.CAPTURE_SYNC, entry.page)
        val intent = entry.page.intent(RuntimeEnvironment.getApplication())
        assertEquals(SourcesActivity::class.java.name, intent.component?.className)
    }

    private fun texts(view: View): List<String> {
        val result = mutableListOf<String>()
        fun walk(node: View) {
            if (node is TextView) result += node.text.toString()
            if (node is ViewGroup) for (index in 0 until node.childCount) walk(node.getChildAt(index))
        }
        walk(view)
        return result
    }
}
