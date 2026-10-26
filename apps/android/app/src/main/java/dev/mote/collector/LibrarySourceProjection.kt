package dev.mote.collector

import org.json.JSONObject

/** Original and Material are distinct namespaces; only verified exact source versions join. */
internal class LibrarySourceProjection {
    data class Key(val origin: String, val type: String, val source: String, val external: String, val device: String, val revision: String, val provisional: Boolean = false)
    data class Row(val key: Key, val local: JSONObject? = null, val central: JSONObject? = null) {
        val item get() = local ?: requireNotNull(central)
    }
    private val rows = linkedMapOf<Key, Row>()
    fun key(origin: String, value: JSONObject): Key = if (value.optString("type") == "material") Key(origin, "material", value.getString("id"), "", "", value.getString("revision"))
        else Key(origin, "original", value.getString("sourceId"), value.getString("externalId"), value.getString("deviceId"), value.getString("revision"), value.optBoolean("provisional"))
    fun clear() = rows.clear()
    fun local(origin: String, value: JSONObject) { val key = key(origin, value); rows[key] = (rows[key] ?: Row(key)).copy(local = value) }
    fun central(origin: String, value: JSONObject) { val key = key(origin, value); rows[key] = (rows[key] ?: Row(key)).copy(central = value) }
    fun clearCentral() { rows.keys.toList().forEach { key -> rows[key]?.let { if (it.local == null) rows.remove(key) else rows[key] = it.copy(central = null) } } }
    fun visible(location: String) = rows.values.filter { when(location) { "local" -> it.local != null; "central" -> it.central != null; else -> true } }.sortedWith(compareByDescending<Row> { java.time.Instant.parse(it.item.getString("sortAt")) }.thenBy { it.key.toString() })
    fun containsCapture(origin: String, item: JSONObject) = rows.values.any { row -> row.key.origin == origin && row.central?.let { it.optString("captureId") == item.optString("id") && it.optString("deviceId") == item.optString("deviceId") && it.optString("libraryVersion").isNotBlank() && it.optString("libraryVersion") == item.optString("libraryVersion") } == true }
}
