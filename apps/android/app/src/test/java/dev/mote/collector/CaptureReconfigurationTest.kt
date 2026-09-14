package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class CaptureReconfigurationTest {
    @Test fun settingChangesReuseLiveProjectionButNeverResumeAUserOrSystemStop() {
        assertEquals(CaptureResume.EXISTING_PROJECTION, captureResume(true, true, "projection", true))
        assertEquals(CaptureResume.NEW_PROJECTION, captureResume(true, true, "projection", false))
        assertEquals(CaptureResume.ACCESSIBILITY, captureResume(true, true, "accessibility", true))
        assertEquals(CaptureResume.STOPPED, captureResume(true, false, "projection", true))
        assertEquals(CaptureResume.STOPPED, captureResume(false, false, "accessibility", false))
    }
    @Test fun completionAfterRotationIsDeliveredToCurrentActivityOnlyAndStopCancelsPendingConsent() {
        val handoff = ProjectionConsentHandoff(); var oldActivity = 0; var currentActivity = 0
        handoff.attach { oldActivity++ }; handoff.detach()
        handoff.attach { currentActivity++; assertTrue(handoff.take()) }
        handoff.request(); assertEquals(0, oldActivity); assertEquals(1, currentActivity); assertFalse(handoff.take())
        handoff.detach(); handoff.request(); handoff.cancel(); handoff.attach { currentActivity++ }
        assertEquals(1, currentActivity); assertFalse(handoff.take())
        handoff.detach(); handoff.request(); handoff.attach { currentActivity++; handoff.take() }
        assertEquals(2, currentActivity)
    }
}
