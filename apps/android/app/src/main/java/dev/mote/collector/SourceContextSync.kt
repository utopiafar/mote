package dev.mote.collector

import android.content.Context
import org.json.JSONObject

/** User-authored source metadata, never a semantic classification or global memory. */
data class SourceContextSnapshot(val sourceId: String, val version: Int, val description: String, val fingerprint: String? = null) {
    fun json() = JSONObject().put("sourceId", sourceId).put("version", version).put("description", description).put("fingerprint", fingerprint)
    companion object {
        fun from(value: JSONObject, expectedSourceId: String): SourceContextSnapshot {
            val version = value.get("version") as? Number ?: error("Invalid source context version")
            require(version.toDouble() == version.toInt().toDouble() && version.toInt() >= 0)
            val description = value.get("description") as? String ?: error("Invalid source context description")
            require(value.getString("sourceId") == expectedSourceId && description.length <= 12000)
            val fingerprint = if (value.has("fingerprint") && !value.isNull("fingerprint")) value.getString("fingerprint") else null
            require(if (version.toInt() == 0) description.isEmpty() && fingerprint == null else fingerprint?.matches(Regex("[a-f0-9]{64}")) == true)
            return SourceContextSnapshot(expectedSourceId, version.toInt(), description, fingerprint)
        }
    }
}

/** Source registration precedes this ACK; file transport must wait for it. */
internal object SourceContextSync {
    fun sync(context: Context, store: LocalSourceStore, source: LocalSource, config: CollectorConfig, target: String, slice: UploadSlice, stillSelected: () -> Boolean): LocalSource? {
        val client = CollectorHttp(context)
        return sync(store, source, config.server, target, slice, stillSelected) { method, url, body ->
            SyncSchedule.requireConditions(context, config)
            client.request(method, url, body, config.connectionToken())
        }
    }
    internal fun sync(store: LocalSourceStore, source: LocalSource, server: String, target: String, slice: UploadSlice, stillSelected: () -> Boolean,
                      request: (String, String, JSONObject?) -> Pair<Int, JSONObject?>): LocalSource? {
        // Old sources with no declaration never send an implicit clear or require a new API.
        if (!source.contextDirty && source.contextVersion == 0 && source.description.isEmpty()) return source
        if (!source.contextDirty && source.contextTarget == target) return source
        val path = server.trimEnd('/') + "/api/sources/${source.id}/context"
        var expectedVersion = source.contextVersion
        if (source.contextTarget != target) {
            check(stillSelected()); slice.record(0)
            val (code, body) = request("GET", path, null)
            if (code !in 200..299 || body == null) { store.status(source.id, "context-http"); return null }
            val current = SourceContextSnapshot.from(body, source.id)
            check(stillSelected())
            if (current.description == source.description && current.version > 0) return store.confirmContext(source, target, current)
            if (current.version > 0) { store.contextConflict(source.id, current); return null }
            expectedVersion = 0
        }
        check(stillSelected())
        val patch = JSONObject().put("expectedVersion", expectedVersion).put("description", source.description)
        slice.record(patch.toString().toByteArray(Charsets.UTF_8).size.toLong())
        val (code, body) = request("PATCH", path, patch)
        check(stillSelected())
        if (code == 409) {
            slice.record(0)
            val (readCode, latest) = request("GET", path, null)
            if (readCode in 200..299 && latest != null) store.contextConflict(source.id, SourceContextSnapshot.from(latest, source.id))
            else store.status(source.id, "context-conflict")
            return null
        }
        if (code !in 200..299 || body == null) { store.status(source.id, "context-http"); return null }
        val accepted = SourceContextSnapshot.from(body, source.id)
        check(accepted.version >= expectedVersion && accepted.description == source.description) { "Source context ACK mismatch" }
        return store.confirmContext(source, target, accepted)
    }
}
