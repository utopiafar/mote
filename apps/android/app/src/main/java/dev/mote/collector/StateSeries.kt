package dev.mote.collector

import org.json.JSONObject
import org.json.JSONArray
import java.time.Instant

/** Exact structural state equality. No interpretation of contents or user intent. */
object StateSeries {
    private fun eligible(v: JSONObject) = !v.has("imageMime") && !v.has("imageBase64") && v.optString("ocrText").isEmpty() && (v.optString("source") == "activity" || v.optString("source") == "screen" && v.optJSONObject("metadata")?.optJSONObject("capture")?.optJSONObject("deduplication")?.optBoolean("duplicate") == true)
    private fun key(v: JSONObject): String {
        val copy = JSONObject(v.toString()); listOf("id", "capturedAt", "durationMs", "stateSeries").forEach(copy::remove)
        copy.optJSONObject("metadata")?.let { m -> m.remove("observedAt"); m.optJSONObject("state")?.let { it.remove("idleSeconds"); it.remove("availableStorageBytes") }; m.optJSONObject("observation")?.remove("elapsedRealtimeMs"); m.optJSONObject("media")?.remove("observedAt") }
        return SourceRules.canonical(copy)
    }
    fun extend(previous: JSONObject?, next: JSONObject): JSONObject {
        if (!eligible(next)) return next
        val samples = previous?.optJSONObject("stateSeries")?.optJSONArray("samples")
        val at = Instant.parse(next.getString("capturedAt")).toEpochMilli()
        val last = samples?.takeIf { it.length() > 0 }?.getJSONObject(samples.length() - 1)
        val gap = last?.let { at - Instant.parse(it.getString("at")).toEpochMilli() } ?: Long.MAX_VALUE
        val observation = JSONObject().put("at", next.getString("capturedAt")).put("durationMs", next.optLong("durationMs"))
        next.optJSONObject("metadata")?.optJSONObject("state")?.let { state -> listOf("idleSeconds", "availableStorageBytes").forEach { if (state.has(it)) observation.put(it, state.get(it)) } }
        if (previous != null && samples != null && eligible(previous) && key(previous) == key(next) && gap in 1..300000 && samples.length() < 720 && at - Instant.parse(previous.getString("capturedAt")).toEpochMilli() <= 21600000) {
            return JSONObject(previous.toString()).apply { getJSONObject("stateSeries").getJSONArray("samples").put(observation) }
        }
        return JSONObject(next.toString()).put("stateSeries", JSONObject().put("version", 1).put("samples", JSONArray().put(observation)))
    }
}
