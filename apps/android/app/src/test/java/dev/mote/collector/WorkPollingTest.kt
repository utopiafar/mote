package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Drives the production re-arm entrypoints: `list` calls `WorkPolling.rearm(items, ::poll)`,
 * `detail` calls `WorkPolling.rearm(work, ::poll)` and the memory-results views carry the
 * rendered `live` into `WorkPolling.rearm(live, ::poll)`. A terminal render schedules nothing
 * while resume, refresh and pagination still read once, exactly as before.
 *
 * The open Memory reader deliberately bypasses this gate: `CentralWorkMemoryResults.open`,
 * `poll` and the transient-failure re-arm call `ui.scheduleActivityPoll()` unconditionally, so
 * withdrawal, deletion, authorization and identity checks keep the original cadence while the
 * statement is visible — only the saved-results list stops at terminal.
 */
class WorkPollingTest {

    @Test fun onlyRunningAndWaitingWorkKeepsPolling() {
        assertTrue(WorkPolling.live("running"))
        assertTrue(WorkPolling.live("waiting"))
        for (state in listOf("completed", "failed", "cancelled", "needs_input", "stale", "excluded", "", "paused", "unknown"))
            assertFalse("'$state' is terminal for polling", WorkPolling.live(state))
    }

    @Test fun aListReArmsOnlyWhileAnyItemIsLive() {
        fun items(vararg states: String) = JSONArray(states.map { JSONObject().put("state", it) })
        var polls = 0
        WorkPolling.rearm(JSONArray()) { polls++ }
        WorkPolling.rearm(items("completed", "failed", "needs_input")) { polls++ }
        WorkPolling.rearm(JSONArray("""["x", 1, null]""")) { polls++ }
        assertEquals("an empty or fully terminal page schedules nothing", 0, polls)
        WorkPolling.rearm(items("completed", "running")) { polls++ }
        WorkPolling.rearm(items("waiting")) { polls++ }
        assertEquals("one live row keeps the three-second cadence", 2, polls)
    }

    @Test fun aCompletedWorkReadsOnceThenSleeps() {
        // The production chain is: render -> rearm(state) -> refreshRun -> read -> render.
        // Feeding each read's state into the same rearm() call proves a terminal result
        // never re-arms while a running one keeps the full cadence.
        var reads = 0
        var armed = true // resume() arms the first poll
        repeat(20) { // sixty idle seconds at the three-second cadence
            if (!armed) return@repeat
            reads++
            armed = false
            WorkPolling.rearm(JSONObject("""{"state":"completed"}""")) { armed = true }
        }
        assertEquals("the resume-triggered read runs once", 1, reads)
        assertFalse("a completed result never re-arms", armed)
        armed = true
        repeat(20) {
            if (!armed) return@repeat
            reads++
            armed = false
            WorkPolling.rearm(JSONObject("""{"state":"running"}""")) { armed = true }
        }
        assertEquals("running work keeps the full cadence", 21, reads)
        assertTrue(armed)
    }

    @Test fun terminalMemoryResultsKeepASlowerWithdrawalCadence() {
        // The saved-results rows carry owner-read titles, so their list keeps re-reading after
        // the work turns terminal — slower than live, never off — to withdraw removed Memories.
        val delays = mutableListOf<Long>()
        WorkPolling.rearmResults(true) { delays.add(it) }
        WorkPolling.rearmResults(false) { delays.add(it) }
        assertEquals(listOf(WorkPolling.MS, WorkPolling.RESULTS_TERMINAL_MS), delays)
    }

    @Test fun terminalDetailStopsOutsideTheResultsPane() {
        // A completed memory work's Overview, Evidence or Technical section shows no
        // withdrawable rows, so the generic detail re-arm stops like every terminal work;
        // only the results pane carries its own slower rearmResults cadence.
        var polls = 0
        WorkPolling.rearm(JSONObject("""{"state":"completed","kind":"memory"}""")) { polls++ }
        WorkPolling.rearm(JSONObject("""{"state":"running","kind":"memory"}""")) { polls++ }
        assertEquals("only live work keeps the detail cadence, whatever its kind", 1, polls)
    }

    @Test fun detailAndListUseTheSameTerminalGate() {
        val terminal = JSONObject("""{"state":"completed"}""")
        val active = JSONObject("""{"state":"waiting"}""")
        var detailPolls = 0
        var listPolls = 0
        WorkPolling.rearm(terminal) { detailPolls++ }
        WorkPolling.rearm(active) { detailPolls++ }
        WorkPolling.rearm(JSONArray(listOf(terminal, terminal))) { listPolls++ }
        WorkPolling.rearm(JSONArray(listOf(terminal, active))) { listPolls++ }
        assertEquals(1, detailPolls)
        assertEquals(1, listPolls)
    }
}
