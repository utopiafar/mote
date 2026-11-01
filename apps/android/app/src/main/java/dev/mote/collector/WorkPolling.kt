package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/**
 * Whether work-activity views keep their three-second refresh. Only work that can still
 * progress on the server is live; every terminal or input-waiting state stops rescheduling,
 * while resume, manual refresh, pagination and opening a result still read fresh.
 */
internal object WorkPolling {
    fun live(state: String) = state == "running" || state == "waiting"

    fun anyLive(items: JSONArray): Boolean =
        (0 until items.length()).any { live(items.optJSONObject(it)?.optString("state").orEmpty()) }

    /** Every screen re-arms its poll through these, so the gate can never drift from the reads. */
    fun rearm(items: JSONArray, schedule: () -> Unit) { if (anyLive(items)) schedule() }
    fun rearm(work: JSONObject, schedule: () -> Unit) { if (live(work.getString("state"))) schedule() }
    fun rearm(live: Boolean, schedule: () -> Unit) { if (live) schedule() }

    /**
     * An open result keeps its withdrawal checks after the work reaches a terminal state:
     * membership, authorization and identity are revalidated at [readerMs] cadence — every
     * three seconds while the work is live or unknown, every fifteen seconds once terminal,
     * so a revoked or removed Memory is still withdrawn promptly without the full cadence.
     */
    fun readerMs(live: Boolean?) = if (live == false) 15_000L else 3_000L

    /** The reader's work state is re-checked at most this often; an unknown state retries on every poll. */
    const val READER_STATE_MS = 60_000L

    fun recheckState(live: Boolean?, checkedAt: Long, now: Long) = live == null || now - checkedAt >= READER_STATE_MS

    /** The reader always revalidates; only its cadence depends on the last known work state. */
    fun rearmReader(live: Boolean?, schedule: (Long) -> Unit) = schedule(readerMs(live))
}
