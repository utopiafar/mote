package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Platform-reported facts only. Neither titles nor package names dispatch semantic categories. */
internal object MediaPrivacy {
    val contentKeys = setOf("title", "artist", "album", "displaySubtitle", "mediaId")
    fun mode(appId: String, config: CollectorConfig): AppCollectionMode {
        if (appId.isBlank() || appId in PrivacyRules.exclusions(config.excludedPackages)) return AppCollectionMode.OFF
        val rules = AppCollectionRules.parse(config.appCollectionRules)
        return rules.apps[appId] ?: rules.defaultMode
    }
    fun session(raw: JSONObject, config: CollectorConfig, activityOnly: Boolean = false): JSONObject? {
        val mode = mode(raw.optString("appId"), config)
        if (mode == AppCollectionMode.OFF) return null
        return JSONObject(raw.toString()).apply {
            if (activityOnly || mode == AppCollectionMode.ACTIVITY) contentKeys.forEach(::remove)
        }
    }
    fun snapshot(status: String, sessions: List<JSONObject>, observedAt: String = java.time.Instant.now().toString()) = JSONObject().put("status", status).put("observedAt", observedAt)
        .put("sessions", JSONArray(if (status == "available") sessions else emptyList<JSONObject>()))
    fun powerAllowed(config: CollectorConfig, battery: Pair<Int, Boolean>) =
        (!config.chargingOnly || battery.second) &&
            (config.batteryPauseBelowPct == 0 || battery.first >= config.batteryPauseBelowPct)
    fun validateEvent(event: JSONObject) {
        require(listOf("imageMime", "imageBase64", "title", "mood", "provenance", "ocr").none(event::has))
        require(event.optString("ocrText").isEmpty() && event.optString("windowTitle").isEmpty())
        val collection = event.getJSONObject("privacy").getString("collection")
        require(collection in setOf("content", "activity"))
        val media = event.getJSONObject("metadata").getJSONObject("media")
        val sessions = media.getJSONArray("sessions")
        require(media.getString("status") in setOf("available", "disabled", "permission_required", "unavailable"))
        require(media.getString("status") == "available" || sessions.length() == 0)
        if (collection == "activity") for (i in 0 until sessions.length()) require(contentKeys.none(sessions.getJSONObject(i)::has))
        val duration = event.getLong("durationMs")
        require(duration in 0..60_000)
        if (duration > 0) {
            require(sessions.length() == 1)
            val session = sessions.getJSONObject(0)
            require(session.getString("playbackState") == "playing" && session.getString("appId").isNotBlank())
            require(event.optString("appId") == session.getString("appId") && event.optString("appName") == session.getString("appName"))
        }
    }
}

internal data class MediaSample(val sessions: List<JSONObject>, val durationMs: Long)

/** Each playing interval ends at the next observation. Restart, sleep and disconnect create gaps. */
internal class MediaTimeline {
    private data class Previous(val elapsed: Long, val awake: Long, val wall: Long, val context: String, val session: JSONObject)
    private val previous = linkedMapOf<String, Previous>()
    private var observedEmpty = false
    fun reset() { previous.clear(); observedEmpty = false }
    fun observe(elapsed: Long, awake: Long, wall: Long, sessions: List<JSONObject>, context: String = ""): List<MediaSample> {
        val samples = mutableListOf<MediaSample>()
        val next = linkedMapOf<String, Previous>()
        for (current in sessions) {
            val id = current.getString("sessionId")
            val old = previous[id]
            val delta = old?.let { elapsed - it.elapsed } ?: 0
            val continuous = old != null && delta in 1..60_000 &&
                kotlin.math.abs((awake - old.awake) - delta) <= 1_000 &&
                kotlin.math.abs((wall - old.wall) - delta) <= 5_000 && old.context == context && old.session.optString("appVisibility") == current.optString("appVisibility") && old.session.optString("appId") == current.optString("appId")
            val counted = continuous && old!!.session.optString("playbackState") == "playing"
            if (counted) samples += MediaSample(listOf(JSONObject(old!!.session.toString())), delta)
            if (old == null || !equivalent(old.session, current) || !continuous && current.optString("playbackState") == "playing") {
                samples += MediaSample(listOf(JSONObject(current.toString())), 0)
            }
            next[id] = Previous(elapsed, awake, wall, context, JSONObject(current.toString()))
        }
        if (previous.keys.any { it !in next } || sessions.isEmpty() && !observedEmpty) samples += MediaSample(sessions.map { JSONObject(it.toString()) }, 0)
        observedEmpty = sessions.isEmpty()
        previous.clear(); previous.putAll(next)
        return samples
    }
    private fun equivalent(a: JSONObject, b: JSONObject): Boolean {
        // Position updates alone are accounted by periodic samples; seek state remains observable.
        fun canonical(value: JSONObject) = value.keys().asSequence().filter { it != "positionMs" }.sorted()
            .joinToString("\u0000") { "$it=${value.get(it)}" }
        return canonical(a) == canonical(b)
    }
}
