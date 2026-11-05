package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ManageMenuTest {
    @Test fun runningCaptureShowsBothSwitchesOnWithoutAPermissionStep() {
        val state = ManageMenu.state(captureEnabled = true, screenSelected = true, screenLive = true, sendPaused = false)
        assertTrue(state.screenOn)
        assertTrue(state.sendOn)
        assertFalse(state.screenPermission)
    }

    @Test fun aPausedScreenSwitchLeavesSendingOn() {
        val state = ManageMenu.state(captureEnabled = true, screenSelected = false, screenLive = false, sendPaused = false)
        assertFalse(state.screenOn)
        assertTrue(state.sendOn)
        assertFalse("A screen turned off by the owner is not a missing permission", state.screenPermission)
    }

    @Test fun aPausedSendSwitchLeavesScreenOn() {
        val state = ManageMenu.state(captureEnabled = true, screenSelected = true, screenLive = true, sendPaused = true)
        assertTrue(state.screenOn)
        assertFalse(state.sendOn)
        assertFalse(state.screenPermission)
    }

    @Test fun aSelectedScreenThatCannotRunOffersOnlyThePermissionStep() {
        val state = ManageMenu.state(captureEnabled = true, screenSelected = true, screenLive = false, sendPaused = false)
        assertTrue(state.screenPermission)
        assertTrue("The hidden switch still reflects the owner's selected source", state.screenOn)
        assertTrue(state.sendOn)
    }

    @Test fun aGlobalCaptureStopIsNotAPermissionProblem() {
        val state = ManageMenu.state(captureEnabled = false, screenSelected = true, screenLive = false, sendPaused = false)
        assertFalse(state.screenOn)
        assertTrue(state.sendOn)
        assertFalse(state.screenPermission)
    }

    @Test fun thePermissionStepMatchesTheCaptureMode() {
        assertEquals(CaptureOverview.Action.PERMISSIONS, ManageMenu.screenPermissionAction(projection = false))
        assertEquals(CaptureOverview.Action.RESTART, ManageMenu.screenPermissionAction(projection = true))
    }
}
