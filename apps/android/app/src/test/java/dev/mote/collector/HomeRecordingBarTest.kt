package dev.mote.collector

import dev.mote.collector.recording.RecordingPhase
import dev.mote.collector.recording.RecordingSnapshot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** R11: the recording row follows the live session on every authored tab. */
class HomeRecordingBarTest {
    private fun snapshot(phase: RecordingPhase, elapsedMs: Long = 0) = RecordingSnapshot(phase, elapsedMs, false, null)

    @Test fun recordingIsVisibleOnTheFiveAuthoredTabsAndNowhereElse() {
        for (page in listOf("ASK", "FEED", "IDEAS", "GOALS", "LIBRARY")) {
            val tab = MoteNavigation.tabId(page)
            assertNotNull("$page is one of the five tabs", tab)
            for (phase in listOf(RecordingPhase.STARTING, RecordingPhase.RECORDING, RecordingPhase.PAUSED, RecordingPhase.STOPPING)) {
                assertEquals("$page keeps the way back while $phase", StatusStripMode.RECORDING, StatusStripPolicy.mode(tab, snapshot(phase), hasDraft = false))
            }
        }
        assertEquals(StatusStripMode.HIDDEN, StatusStripPolicy.mode(null, snapshot(RecordingPhase.RECORDING), hasDraft = false))
        assertEquals(StatusStripMode.HIDDEN, StatusStripPolicy.mode("chat", snapshot(RecordingPhase.IDLE), hasDraft = false))
    }

    @Test fun barShowsTheRecordedElapsedTime() {
        assertEquals("00:00", StatusStripPolicy.label(0))
        assertEquals("00:09", StatusStripPolicy.label(9_999))
        assertEquals("02:14", StatusStripPolicy.label(134_000))
        assertEquals("60:00", StatusStripPolicy.label(3_600_000))
    }

    @Test fun stoppingTheRecordingHidesTheBarAgain() {
        assertEquals(StatusStripMode.RECORDING, StatusStripPolicy.mode("chat", snapshot(RecordingPhase.RECORDING, 12_000), hasDraft = false))
        assertEquals(StatusStripMode.HIDDEN, StatusStripPolicy.mode("chat", snapshot(RecordingPhase.IDLE, 12_000), hasDraft = false))
    }

    @Test fun aDraftTakesTheStripOnlyWhenNoRecordingIsLive() {
        assertEquals(StatusStripMode.DRAFT, StatusStripPolicy.mode("library", snapshot(RecordingPhase.IDLE), hasDraft = true))
        assertEquals(StatusStripMode.RECORDING, StatusStripPolicy.mode("library", snapshot(RecordingPhase.RECORDING), hasDraft = true))
        assertEquals(StatusStripMode.HIDDEN, StatusStripPolicy.mode(null, snapshot(RecordingPhase.IDLE), hasDraft = true))
    }

    @Test fun draftPresenceMatchesWhatTheEditorWouldKeep() {
        fun draft(configure: JSONObject.() -> Unit) = JSONObject().apply {
            put("text", "").put("description", "").put("attachments", JSONArray()).put("origin", JSONObject().put("kind", "manual").put("text", ""))
            configure()
        }
        assertFalse(StatusStripPolicy.hasDraft(draft {}))
        assertTrue(StatusStripPolicy.hasDraft(draft { put("text", "一行") }))
        assertTrue(StatusStripPolicy.hasDraft(draft { put("description", "说明") }))
        assertTrue(StatusStripPolicy.hasDraft(draft { put("attachments", JSONArray().put(JSONObject().put("id", "a"))) }))
        assertTrue(StatusStripPolicy.hasDraft(draft { put("origin", JSONObject().put("kind", "share").put("text", "来自聊天")) }))
    }
}
