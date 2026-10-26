package dev.mote.collector

import org.json.JSONObject
import java.time.Instant

/** A read projection: changing availability never acknowledges or mutates a capture. */
internal class LibraryCaptureProjection {
    data class Identity(val scope: String, val deviceId: String, val id: String)
    enum class Remote { UNKNOWN, READABLE, OTHER_VERSION, UNAVAILABLE }
    data class Row(val identity: Identity, val local: JSONObject? = null, val central: JSONObject? = null, val remote: Remote = Remote.UNKNOWN) {
        val item get() = local ?: requireNotNull(central)
        val remoteOnly get() = local == null
        val readableCentral get() = remote == Remote.READABLE || remote == Remote.OTHER_VERSION
        val sortAt get() = item.optString("sortAt").ifBlank { item.getString("capturedAt") }
    }
    companion object {
        fun version(item: JSONObject) = item.optString("libraryVersion")
        fun observations(item: JSONObject) = if (item.has("observationCount")) item.getInt("observationCount") else item.optJSONObject("stateSeries")?.optJSONArray("samples")?.length() ?: 0
    }
    private val rows = linkedMapOf<Identity, Row>()
    fun clear() = rows.clear()
    /** Permission loss invalidates every remote body and availability claim for this origin. */
    fun clearCentral(scope: String) {
        rows.keys.filter { it.scope == scope }.forEach { identity ->
            val row = rows.getValue(identity)
            if (row.local == null) rows.remove(identity)
            else rows[identity] = row.copy(central = null, remote = Remote.UNKNOWN)
        }
    }
    fun local(item: JSONObject, scope: String, deviceId: String) {
        val identity = Identity(scope.ifBlank { "local:$deviceId" }, item.optString("deviceId").ifBlank { deviceId }, item.getString("id"))
        rows[identity] = (rows[identity] ?: Row(identity)).copy(local = item).let { row ->
            if (row.central != null) row.copy(remote = if (version(item).isNotBlank() && version(item) == version(row.central)) Remote.READABLE else Remote.OTHER_VERSION) else row
        }
    }
    fun central(item: JSONObject, scope: String) {
        val identity = Identity(scope, item.getString("deviceId"), item.getString("id"))
        rows[identity] = (rows[identity] ?: Row(identity)).copy(central = item, remote = if (rows[identity]?.local?.let { version(it).isBlank() || version(it) != version(item) } == true) Remote.OTHER_VERSION else Remote.READABLE)
    }
    fun availability(scope: String, deviceId: String, id: String, readable: Boolean, observationCount: Int = 0, libraryVersion: String = "") {
        val identity = Identity(scope, deviceId, id)
        rows[identity]?.let {
            val reference = if (!readable) null else if (it.local != null && (it.central == null || version(it.central) != libraryVersion)) JSONObject()
                .put("id", id).put("deviceId", deviceId).put("capturedAt", it.local.getString("capturedAt"))
                .put("source", it.local.getString("source")).put("observationCount", observationCount).put("libraryVersion", libraryVersion) else it.central
            rows[identity] = it.copy(central = reference, remote = if (!readable) Remote.UNAVAILABLE else if (it.local != null && (version(it.local).isBlank() || version(it.local) != libraryVersion)) Remote.OTHER_VERSION else Remote.READABLE) }
    }
    fun visible(location: String) = rows.values.filter {
        when (location) { "local" -> it.local != null; "central" -> it.readableCentral; else -> true }
    }.sortedWith(compareByDescending<Row> { Instant.parse(it.sortAt) }.thenByDescending { it.identity.id }.thenBy { it.identity.scope }.thenBy { it.identity.deviceId })
    fun candidates(scope: String) = rows.values.filter { it.local != null && it.identity.scope == scope }.map { it.identity }.take(100)
}
