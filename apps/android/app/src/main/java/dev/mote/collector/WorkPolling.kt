package dev.mote.collector

import org.json.JSONArray

/**
 * Whether work-activity views keep their three-second refresh. Only work that can still
 * progress on the server is live; every terminal or input-waiting state stops rescheduling,
 * while resume, manual refresh, pagination and opening a result still read fresh.
 */
internal object WorkPolling {
    fun live(state: String) = state == "running" || state == "waiting"

    fun anyLive(items: JSONArray): Boolean =
        (0 until items.length()).any { live(items.optJSONObject(it)?.optString("state").orEmpty()) }
}
