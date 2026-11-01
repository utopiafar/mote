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

    @Test fun aRestoredReaderReArmsOnlyForLiveWork() {
        // Mirrors showSelected(): recreation clears `live`, a fresh work-state read refreshes
        // it, and the reader's rearm call schedules its next revalidation.
        var live: Boolean? = null
        var polls = 0
        fun restoreReader(stateRead: () -> String) {
            runCatching(stateRead).onSuccess { live = WorkPolling.live(it) }
            WorkPolling.rearmReader(live) { polls++ }
        }
        restoreReader { "running" }
        assertEquals("a still-running work resumes the reader poll", 1, polls)
        live = null
        restoreReader { "completed" }
        assertEquals("a completed work keeps the slower withdrawal revalidation", 2, polls)
        live = null
        restoreReader { error("offline") }
        assertEquals("an unknown state is not terminal: the reader retries it", 3, polls)
        assertTrue("an unknown state stays on the live cadence", WorkPolling.recheckState(live, 0, 1))
    }

    @Test fun theOpenReaderRevalidatesSlowerAfterTheWorkTerminates() {
        // running -> revalidation every three seconds; a fresh state read reports completed ->
        // the same production rearm drops to the fifteen-second withdrawal cadence.
        var live: Boolean? = WorkPolling.live("running")
        val delays = mutableListOf<Long>()
        WorkPolling.rearmReader(live) { delays.add(it) }
        live = WorkPolling.live("completed")
        WorkPolling.rearmReader(live) { delays.add(it) }
        WorkPolling.rearmReader(null) { delays.add(it) }
        assertEquals(listOf(3_000L, 15_000L, 3_000L), delays)
    }

    @Test fun theReaderRefreshesTheWorkStateOnItsOwnClock() {
        assertTrue("an unknown state is re-read on every poll", WorkPolling.recheckState(null, 0, 0))
        assertFalse("a fresh state answer is reused", WorkPolling.recheckState(true, 0, WorkPolling.READER_STATE_MS - 1))
        assertTrue("the state is re-checked once it ages out", WorkPolling.recheckState(true, 0, WorkPolling.READER_STATE_MS))
        assertTrue("a terminal state still re-checks for a restart", WorkPolling.recheckState(false, 0, WorkPolling.READER_STATE_MS))
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
