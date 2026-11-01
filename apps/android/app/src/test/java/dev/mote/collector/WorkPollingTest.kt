package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Drives the same `WorkPolling` checks the activity screens issue after each read:
 * `list` re-arms on `anyLive(items)`, `detail` and the memory-results views re-arm on
 * `live(work.state)`. A terminal render schedules nothing while resume, refresh and
 * pagination still read once, exactly as before.
 */
class WorkPollingTest {

    @Test fun onlyRunningAndWaitingWorkKeepsPolling() {
        assertTrue(WorkPolling.live("running"))
        assertTrue(WorkPolling.live("waiting"))
        for (state in listOf("completed", "failed", "cancelled", "needs_input", "stale", "excluded", "", "paused", "unknown"))
            assertFalse("'$state' is terminal for polling", WorkPolling.live(state))
    }

    @Test fun aListPollsOnlyWhileAnyItemIsLive() {
        fun items(vararg states: String) = JSONArray(states.map { JSONObject().put("state", it) })
        assertFalse("an empty page has nothing to poll", WorkPolling.anyLive(JSONArray()))
        assertFalse("a fully terminal page stops rescheduling", WorkPolling.anyLive(items("completed", "failed", "needs_input")))
        assertTrue("one live row keeps the three-second cadence", WorkPolling.anyLive(items("completed", "running")))
        assertTrue(WorkPolling.anyLive(items("waiting")))
        assertFalse("non-object entries carry no state", WorkPolling.anyLive(JSONArray("""["x", 1, null]""")))
    }

    @Test fun aCompletedWorkReadsOnceThenSleeps() {
        // The production sites call `if (WorkPolling.live(state)) scheduleActivityPoll()` after
        // every completed read; simulating the re-arm loop proves a terminal result stops it.
        var reads = 0
        var state = "completed"
        var pending = true // resume() arms the first poll
        repeat(20) { // sixty idle seconds at the three-second cadence
            if (!pending) return@repeat
            reads++
            pending = WorkPolling.live(state)
        }
        assertEquals("the resume-triggered read runs once", 1, reads)
        assertFalse("a completed result never re-arms", pending)
        state = "running"
        repeat(20) { if (WorkPolling.live(state)) reads++ else pending = false }
        assertEquals("running work keeps the full cadence", 21, reads)
    }

    @Test fun detailAndListUseTheSameTerminalGate() {
        val terminal = JSONObject("""{"state":"completed"}""")
        val active = JSONObject("""{"state":"waiting"}""")
        var detailPolls = 0
        var listPolls = 0
        // Mirrors `detail()`: if (WorkPolling.live(work.getString("state"))) scheduleActivityPoll()
        if (WorkPolling.live(terminal.getString("state"))) detailPolls++
        if (WorkPolling.live(active.getString("state"))) detailPolls++
        // Mirrors `list()`: if (WorkPolling.anyLive(items)) scheduleActivityPoll()
        val page = JSONArray(listOf(terminal, terminal))
        if (WorkPolling.anyLive(page)) listPolls++
        if (WorkPolling.anyLive(JSONArray(listOf(terminal, active)))) listPolls++
        assertEquals(1, detailPolls)
        assertEquals(1, listPolls)
    }
}
