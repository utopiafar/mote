package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/**
 * Work-activity views keep a refresh on every state, but only work that can still progress
 * on the server is live. Live work keeps the three-second cadence; terminal, input-waiting
 * and otherwise settled states drop to a slower revalidation that still observes list
 * membership changes, redacted projections and resume transitions — needs_input and paused
 * work can start again on another client, and a completed projection can be rewritten by a
 * deletion elsewhere. A changed response rebuilds the view; an unchanged one never touches it.
 */
internal object WorkPolling {
    const val MS = 3_000L
    /** Slow cadence shared by terminal detail revalidation, list membership discovery and the
     * saved-results withdrawal check. */
    const val TERMINAL_MS = 15_000L

    fun live(state: String) = state == "running" || state == "waiting"

    fun anyLive(items: JSONArray): Boolean =
        (0 until items.length()).any { live(items.optJSONObject(it)?.optString("state").orEmpty()) }

    /** Every screen re-arms its poll through these, so the gate can never drift from the reads.
     * The list never stops entirely: a page without live rows still discovers work that arrives
     * or completes elsewhere. The open result reader does not use them: its withdrawal checks
     * keep the original cadence regardless of the work state, because membership, authorization
     * and identity must stay revalidated while the statement is visible. */
    fun rearm(items: JSONArray, schedule: (Long) -> Unit) = schedule(if (anyLive(items)) MS else TERMINAL_MS)
    fun rearm(work: JSONObject, schedule: (Long) -> Unit) = schedule(if (live(work.getString("state"))) MS else TERMINAL_MS)
    fun rearm(live: Boolean, schedule: (Long) -> Unit) = schedule(if (live) MS else TERMINAL_MS)

    /** The saved-results list never stops while visible; a terminal work only slows it down. */
    const val RESULTS_TERMINAL_MS = TERMINAL_MS
    fun rearmResults(live: Boolean, schedule: (Long) -> Unit) = schedule(if (live) MS else RESULTS_TERMINAL_MS)

    /** Plugin-owned poll loop for its pages. A page that is not visible keeps no
     * pending refresh: [stop] cancels one, and [rearm] refuses to arm a new one
     * until the page is visible again. */
    internal class Session(
        private val visible: () -> Boolean,
        private val schedule: (Long) -> Unit,
        private val cancel: () -> Unit,
    ) {
        fun rearm(delay: Long) { cancel(); if (visible()) schedule(delay) }
        fun stop() = cancel()
    }
}
