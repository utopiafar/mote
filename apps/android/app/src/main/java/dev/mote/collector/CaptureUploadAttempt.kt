package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class CaptureUploadAttempt(val id: String, val batchId: String, val scope: String, val process: String,
    val startedAt: Long, val bodyBytes: Long, val captures: JSONArray, val state: String = "sending", val status: Int = 0,
    val acknowledged: Int = 0, val reason: String = "", val results: JSONObject = JSONObject()) {
    fun json() = JSONObject().put("kind", "capture").put("id", id).put("batchId", batchId).put("scope", scope).put("process", process)
        .put("startedAt", startedAt).put("bodyBytes", bodyBytes).put("captures", captures).put("state", state)
        .put("status", status).put("acknowledged", acknowledged).put("reason", reason).put("results", results)
    companion object {
        fun create(batchId: String, scope: String, process: String, events: List<JSONObject>, bytes: Long, now: Long, originals: List<JSONObject> = events): CaptureUploadAttempt {
            require(events.isNotEmpty() && bytes >= 0 && now > 0); UUID.fromString(batchId)
            return CaptureUploadAttempt(UUID.randomUUID().toString(), batchId, scope, process, now, bytes,
                JSONArray(events.map { JSONObject().put("id", it.getString("id")).put("version", CaptureUploadVersion.of(it)).put("queueVersion", CaptureUploadVersion.of(originals.single { original -> original.getString("id") == it.getString("id") })) }))
        }
        fun parse(value: JSONObject) = CaptureUploadAttempt(value.getString("id"), value.getString("batchId"), value.getString("scope"), value.getString("process"),
            value.getLong("startedAt"), value.getLong("bodyBytes"), value.getJSONArray("captures"), value.getString("state"), value.getInt("status"), value.getInt("acknowledged"), value.getString("reason"), value.getJSONObject("results"))
    }
}

internal interface CaptureAttemptStore {
    fun saveAttempt(attempt: CaptureUploadAttempt)
}

/** Each actual HTTP request has an identity, including bundle size negotiation and failed responses.
 * Request body size is known; this is never labeled total wire/network usage. */
internal class CaptureUploadAttempts(private val store: CaptureAttemptStore, private val batchId: String, private val scope: String,
    private val process: String, private val now: () -> Long = System::currentTimeMillis) {
    fun send(events: List<JSONObject>, bytes: Long, individual: Boolean, originals: List<JSONObject> = events, send: () -> Pair<Int, JSONObject?>): Pair<Int, JSONObject?> {
        val attempt = CaptureUploadAttempt.create(batchId, scope, process, events, bytes, now(), originals)
        store.saveAttempt(attempt) // If history cannot start, do not begin a request we cannot account for.
        var status = 0
        var validated = false
        try {
            val response = send(); status = response.first
            val receipts = if (individual) {
                if (status in setOf(200, 201)) {
                    require(IngressV2Protocol.validCapture(events.single().getString("id"), response.second))
                    mapOf(events.single().getString("id") to status)
                } else emptyMap()
            } else if (status == 200) BatchUpload.receipts(events.map { it.getString("id") }.toSet(), response.second) else emptyMap()
            val count = receipts.values.count { it in setOf(200, 201) }
            val state = when {
                count == events.size -> "received"
                count > 0 -> "partial"
                status == 413 || receipts.size == events.size && receipts.values.all { it in 400..499 } -> "rejected"
                else -> "unknown"
            }
            validated = true
            store.saveAttempt(attempt.copy(state = state, status = status, acknowledged = count, reason = if (state == "unknown") "http_unconfirmed" else "", results = JSONObject(receipts)))
            return response
        } catch (error: Exception) {
            val cancelled = error is SyncConditionsUnavailable
            store.saveAttempt(attempt.copy(state = if (cancelled) "cancelled" else "unknown", status = status,
                reason = if (cancelled) "conditions" else if (validated) "history_unavailable" else if (status in 200..299) "invalid_confirmation" else "interrupted"))
            throw error
        }
    }
}
