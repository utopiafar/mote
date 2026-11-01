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
}
