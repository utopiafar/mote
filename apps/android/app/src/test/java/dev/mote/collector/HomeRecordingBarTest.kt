package dev.mote.collector

import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeRecordingBarTest {
    private fun snapshot(phase: RecordingPhase, elapsedMs: Long = 0) = RecordingSnapshot(phase, elapsedMs, false, null)

    @Test fun `bar is visible only while a recording is active on the home`() {
        assertFalse(HomeRecordingBarPolicy.visible(true, snapshot(RecordingPhase.IDLE)))
        assertFalse(HomeRecordingBarPolicy.visible(false, snapshot(RecordingPhase.RECORDING)))
        for (phase in listOf(RecordingPhase.STARTING, RecordingPhase.RECORDING, RecordingPhase.PAUSED, RecordingPhase.STOPPING)) {
            assertTrue("$phase should keep the way back", HomeRecordingBarPolicy.visible(true, snapshot(phase)))
        }
    }

    @Test fun `bar shows the recorded elapsed time`() {
        assertEquals("00:00", HomeRecordingBarPolicy.label(0))
        assertEquals("00:09", HomeRecordingBarPolicy.label(9_999))
        assertEquals("02:14", HomeRecordingBarPolicy.label(134_000))
        assertEquals("60:00", HomeRecordingBarPolicy.label(3_600_000))
    }

    @Test fun `stopping the recording hides the bar again`() {
        assertTrue(HomeRecordingBarPolicy.visible(true, snapshot(RecordingPhase.RECORDING, 12_000)))
        assertFalse(HomeRecordingBarPolicy.visible(true, snapshot(RecordingPhase.IDLE, 12_000)))
    }
}
