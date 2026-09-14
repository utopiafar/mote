package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

enum class OperationKind {
    CAPTURE_REQUESTED, FRAME_RECEIVED, SCREEN_QUEUED, NOTE_QUEUED, SCREEN_ACK, NOTE_ACK,
    FRAME_BLOCKED, CAPTURE_FAILED, CAPTURE_PAUSED, UPLOAD_RETRY, HEARTBEAT_FAILED, SOURCE_ACK, SOURCE_FAILED,
    CONNECTION_OK, CONNECTION_FAILED, CAPTURE_STARTED, CAPTURE_STOPPED, ACTIVITY_QUEUED, ACTIVITY_ACK, ACTIVITY_FAILED
}
enum class OperationReason {
    NONE, LOCKED, CHARGING, BATTERY, MODEL_MISSING, EXCLUDED, WINDOW_UNKNOWN, QUEUE_FULL,
    MODEL_DENIED, LOCAL_DENIED, STATE_CHANGED, SYSTEM, MODEL, OCR, PRIVACY, STORAGE,
    NETWORK, WIFI, AUTH, HTTP, ACK, CANCELLED, RESPONSE, CONFIGURATION, TIMEOUT
}

/** Fixed vocabulary, numeric totals and a bounded history; never accepts captured content. */
class OperationLedger(private val file: File, private val limit: Int = 200, private val clock: () -> Long = System::currentTimeMillis) {
    init { require(limit in 1..500) }
    fun read(): JSONObject = synchronized(lock) { load() }
    fun record(kind: OperationKind, reason: OperationReason = OperationReason.NONE, bytes: Long = 0, httpStatus: Int? = null, elapsedMs: Long? = null, recordId: String? = null) = synchronized(lock) {
        require(bytes >= 0 && (httpStatus == null || httpStatus in 100..599) && (elapsedMs == null || elapsedMs >= 0))
        if (recordId != null) require(UUID.fromString(recordId).toString() == recordId)
        val state = load(); val counts = state.getJSONObject("counts")
        counts.put(kind.name, Math.addExact(counts.getLong(kind.name), 1L))
        if (kind in setOf(OperationKind.SCREEN_ACK, OperationKind.NOTE_ACK, OperationKind.ACTIVITY_ACK)) state.put("confirmedUploadBytes", Math.addExact(state.getLong("confirmedUploadBytes"), bytes))
        val old = state.getJSONArray("events"); val next = JSONArray()
        for (i in maxOf(0, old.length() - limit + 1) until old.length()) next.put(old.getJSONObject(i))
        next.put(JSONObject().put("atMs", clock()).put("kind", kind.name).put("reason", reason.name).put("bytes", bytes)
            .apply { httpStatus?.let { put("httpStatus", it) }; elapsedMs?.let { put("elapsedMs", it) }; recordId?.let { put("recordId", it) } })
        state.put("events", next); write(state)
    }
    fun reset() = synchronized(lock) { write(fresh("user_reset")) }
    private fun fresh(reason: String) = JSONObject().put("version", 1).put("epochId", UUID.randomUUID().toString()).put("epochAtMs", clock())
        .put("epochReason", reason).put("confirmedUploadBytes", 0L).put("counts", JSONObject().apply { OperationKind.entries.forEach { put(it.name, 0L) } }).put("events", JSONArray())
    private fun load(): JSONObject {
        if (!file.exists()) return fresh("first_record").also(::write)
        try {
            require(file.length() <= 256 * 1024)
            val state = JSONObject(file.readText()); require(state.getInt("version") == 1)
            UUID.fromString(state.getString("epochId")); require(state.getLong("epochAtMs") >= 0 && state.getLong("confirmedUploadBytes") >= 0)
            require(state.getString("epochReason") in setOf("first_record", "user_reset", "recovered"))
            require(state.keys().asSequence().toSet() == setOf("version", "epochId", "epochAtMs", "epochReason", "confirmedUploadBytes", "counts", "events"))
            val counts = state.getJSONObject("counts")
            val allowed = OperationKind.entries.map { it.name }.toSet()
            val added = setOf("ACTIVITY_QUEUED", "ACTIVITY_ACK", "ACTIVITY_FAILED")
            val existing = counts.keys().asSequence().toSet()
            require(existing.all { it in allowed } && existing.containsAll(allowed - added))
            // Adding activity statistics must not reset the user's existing 0.6 totals/epoch.
            added.filterNot(counts::has).forEach { counts.put(it, 0L) }
            OperationKind.entries.forEach { require(counts.getLong(it.name) >= 0) }
            val events = state.getJSONArray("events"); require(events.length() <= limit)
            for (i in 0 until events.length()) {
                val e = events.getJSONObject(i)
                require(e.keys().asSequence().all { it in setOf("atMs", "kind", "reason", "bytes", "httpStatus", "elapsedMs", "recordId") })
                if (e.has("recordId")) require(UUID.fromString(e.getString("recordId")).toString() == e.getString("recordId"))
                OperationKind.valueOf(e.getString("kind")); OperationReason.valueOf(e.getString("reason"))
                require(e.getLong("atMs") >= 0 && e.getLong("bytes") >= 0)
                if (e.has("httpStatus")) require(e.getInt("httpStatus") in 100..599)
                if (e.has("elapsedMs")) require(e.getLong("elapsedMs") >= 0)
            }
            return state
        } catch (_: Exception) { return fresh("recovered").also(::write) }
    }
    private fun write(state: JSONObject) {
        file.parentFile!!.mkdirs(); val temporary = File(file.parentFile, "${file.name}.tmp")
        try { FileOutputStream(temporary).use { it.write(state.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }; check(temporary.renameTo(file)) }
        finally { temporary.delete() }
    }
    companion object { private val lock = Any() }
}
