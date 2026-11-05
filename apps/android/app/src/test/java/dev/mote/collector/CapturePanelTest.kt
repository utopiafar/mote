package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class CapturePanelTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-11-06T07:00:00Z")
    private val pausedAt = Instant.parse("2026-11-06T06:20:00Z").toEpochMilli()
    private fun facts(enabled: Boolean = true, state: String = "capturing", screenSelected: Boolean = true, screenLive: Boolean = true,
        paused: Long? = null, notifications: Boolean = true, systemLive: Boolean = true, folders: Int = 2,
        connected: Boolean = true, sendPaused: Boolean = false, sendState: String = "idle", pending: Int? = 12) =
        CaptureOverview.Facts(enabled, state, "生成的状态说明", true, screenSelected, screenLive, false, paused,
            notifications, false, false, systemLive, false, folders, connected, sendPaused, sendState, pending, false)

    @Test fun capturingShowsBothSwitchesAndTheQueue() {
        val model = CapturePanel.model(facts(), now, zone)
        assertEquals("采集中", model.screen.detail)
        assertEquals(CapturePanel.ScreenMode.SWITCH, model.screen.mode)
        assertTrue(model.screen.checked)
        assertEquals("采集中", model.system.detail)
        assertTrue(model.system.checked)
        assertEquals("2 个文件夹", model.folders)
        assertEquals("待同步 12 条", model.send)
        assertFalse(model.sendAttention)
        assertTrue(model.sendAction)
        assertEquals("暂停全部采集", model.all)
    }

    @Test fun aTemporaryScreenPauseNamesTheMinuteAndLeavesOtherSourcesOn() {
        val model = CapturePanel.model(facts(screenSelected = false, screenLive = false, paused = pausedAt), now, zone)
        assertEquals("14:20 起暂停", model.screen.detail)
        assertEquals(CapturePanel.ScreenMode.SWITCH, model.screen.mode)
        assertFalse(model.screen.checked)
        assertEquals("采集中", model.system.detail)
        assertTrue(model.system.checked)
        assertEquals("暂停全部采集", model.all)
    }

    @Test fun stoppingEverythingTurnsBothRowsOffAndOffersResume() {
        val model = CapturePanel.model(facts(enabled = false, state = "paused", screenLive = false, systemLive = false, paused = pausedAt), now, zone)
        assertEquals("已暂停", model.screen.detail)
        assertFalse(model.screen.checked)
        assertEquals("已暂停", model.system.detail)
        assertFalse(model.system.checked)
        assertEquals("恢复采集", model.all)
    }

    @Test fun aMissingScreenPermissionReplacesTheSwitchWithFix() {
        val model = CapturePanel.model(facts(screenLive = false), now, zone)
        assertEquals("等待采集权限", model.screen.detail)
        assertEquals(CapturePanel.ScreenMode.FIX, model.screen.mode)
        assertEquals("采集中", model.system.detail)
        assertTrue(model.system.checked)
        assertEquals("暂停全部采集", model.all)
    }

    @Test fun aScreenTurnedOffInSettingsIsNotAPermission() {
        val model = CapturePanel.model(facts(screenSelected = false, screenLive = false), now, zone)
        assertEquals("关闭", model.screen.detail)
        assertEquals(CapturePanel.ScreenMode.SWITCH, model.screen.mode)
        assertFalse(model.screen.checked)
    }

    @Test fun foldersAndSendingReportWhatIsActuallyQueued() {
        val model = CapturePanel.model(facts(folders = 0, pending = 12), now, zone)
        assertEquals("关闭", model.folders)
        assertEquals("待同步 12 条", model.send)
        assertTrue(model.sendAction)
        val local = CapturePanel.model(facts(connected = false), now, zone)
        assertEquals("仅保存在本机", local.send)
        assertTrue("The action still shows so the owner can retry after connecting", local.sendAction)
        val paused = CapturePanel.model(facts(sendPaused = true), now, zone)
        assertEquals("发送已暂停", paused.send)
        assertFalse("Sending pauses until the owner resumes it", paused.sendAction)
        val blocked = CapturePanel.model(facts(sendState = "blocked"), now, zone)
        assertEquals("发送需要处理", blocked.send)
        assertTrue(blocked.sendAttention)
        assertTrue(blocked.sendAction)
    }

    @Test fun anUnreadQueueMakesNoClaim() {
        val model = CapturePanel.model(facts(pending = null), now, zone)
        assertEquals("按设置发送", model.send)
    }
}
