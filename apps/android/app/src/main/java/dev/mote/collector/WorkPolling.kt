package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/**
 * Whether work-activity views keep their three-second refresh. Only work that can still
 * progress on the server is live; every terminal or input-waiting state stops rescheduling,
 * while resume, manual refresh, pagination and opening a result still read fresh.
 */
internal object WorkPolling {
    const val MS = 3_000L

    fun live(state: String) = state == "running" || state == "waiting"

    fun anyLive(items: JSONArray): Boolean =
        (0 until items.length()).any { live(items.optJSONObject(it)?.optString("state").orEmpty()) }

    /** Every screen re-arms its poll through these, so the gate can never drift from the reads.
     * An open result reader does not use them: its withdrawal checks keep the original cadence
     * regardless of the work state, because membership, authorization and identity must stay
     * revalidated while the statement is visible. */
    fun rearm(items: JSONArray, schedule: () -> Unit) { if (anyLive(items)) schedule() }
    fun rearm(work: JSONObject, schedule: () -> Unit) { if (live(work.getString("state"))) schedule() }
    fun rearm(live: Boolean, schedule: () -> Unit) { if (live) schedule() }

    /** A terminal memory work's results re-read on a slower cadence: the rows carry owner-read
     * titles that must be withdrawn when the Memory is removed or access revoked elsewhere. */
    const val RESULTS_TERMINAL_MS = 15_000L

    /** The saved-results list never stops while visible; a terminal work only slows it down. */
    fun rearmResults(live: Boolean, schedule: (Long) -> Unit) = schedule(if (live) MS else RESULTS_TERMINAL_MS)
}
