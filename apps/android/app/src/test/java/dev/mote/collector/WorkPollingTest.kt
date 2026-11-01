package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Cadence rules only; actual view lifecycle coverage lives in WorkMemoryJourneyInstrumentedTest. */
class WorkPollingTest {

    @Test fun onlyRunningAndWaitingWorkCountsAsLive() {
        assertTrue(WorkPolling.live("running"))
        assertTrue(WorkPolling.live("waiting"))
        for (state in listOf("completed", "failed", "cancelled", "needs_input", "stale", "excluded", "", "paused", "unknown"))
            assertFalse("'$state' is not live for polling", WorkPolling.live(state))
    }

    @Test fun aListKeepsDiscoveringMembershipOnTheSlowCadence() {
        fun items(vararg states: String) = JSONArray(states.map { JSONObject().put("state", it) })
        val delays = mutableListOf<Long>()
        WorkPolling.rearm(JSONArray()) { delays.add(it) }
        WorkPolling.rearm(items("completed", "failed", "needs_input")) { delays.add(it) }
        WorkPolling.rearm(JSONArray("""["x", 1, null]""")) { delays.add(it) }
        WorkPolling.rearm(items("completed", "running")) { delays.add(it) }
        WorkPolling.rearm(items("waiting")) { delays.add(it) }
        assertEquals(
            "an empty or fully terminal page still re-arms at the discovery cadence",
            listOf(WorkPolling.TERMINAL_MS, WorkPolling.TERMINAL_MS, WorkPolling.TERMINAL_MS, WorkPolling.MS, WorkPolling.MS),
            delays
        )
    }

    @Test fun completedDetailsUseTheBoundedRevalidationCadence() {
        val delays = mutableListOf<Long>()
        WorkPolling.rearm(JSONObject("""{"state":"completed"}""")) { delays.add(it) }
        WorkPolling.rearm(JSONObject("""{"state":"running"}""")) { delays.add(it) }
        assertEquals(listOf(WorkPolling.TERMINAL_MS, WorkPolling.MS), delays)
    }

    @Test fun needsInputStaysObservableSoItCanResume() {
        // needs_input covers waiting_for_input/waiting_for_model, which can retry on their own
        // or be resumed from another client — it must keep re-arming, just slower.
        val delays = mutableListOf<Long>()
        WorkPolling.rearm(JSONObject("""{"state":"needs_input"}""")) { delays.add(it) }
        WorkPolling.rearm(JSONObject("""{"state":"paused"}""")) { delays.add(it) }
        assertEquals(listOf(WorkPolling.TERMINAL_MS, WorkPolling.TERMINAL_MS), delays)
    }

    @Test fun terminalMemoryResultsKeepASlowerWithdrawalCadence() {
        // The saved-results rows carry owner-read titles, so their list keeps re-reading after
        // the work turns terminal — slower than live, never off — to withdraw removed Memories.
        val delays = mutableListOf<Long>()
        WorkPolling.rearmResults(true) { delays.add(it) }
        WorkPolling.rearmResults(false) { delays.add(it) }
        assertEquals(listOf(WorkPolling.MS, WorkPolling.RESULTS_TERMINAL_MS), delays)
    }

    @Test fun detailAndListUseTheSameCadenceGate() {
        val terminal = JSONObject("""{"state":"completed"}""")
        val active = JSONObject("""{"state":"waiting"}""")
        val detailDelays = mutableListOf<Long>()
        val listDelays = mutableListOf<Long>()
        WorkPolling.rearm(terminal) { detailDelays.add(it) }
        WorkPolling.rearm(active) { detailDelays.add(it) }
        WorkPolling.rearm(JSONArray(listOf(terminal, terminal))) { listDelays.add(it) }
        WorkPolling.rearm(JSONArray(listOf(terminal, active))) { listDelays.add(it) }
        assertEquals(listOf(WorkPolling.TERMINAL_MS, WorkPolling.MS), detailDelays)
        assertEquals(listOf(WorkPolling.TERMINAL_MS, WorkPolling.MS), listDelays)
    }
}
