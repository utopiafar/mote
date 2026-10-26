package dev.mote.collector

import org.json.JSONObject

/** The rendered snapshot, not the directory, determines whether a detail is current. */
internal class MemoryTopicDetailGuard {
    private var snapshot: String? = null
    fun clear() { snapshot = null }
    fun accept(id: String, row: JSONObject): Boolean {
        val value = identity(id, row) ?: return false
        if (snapshot != null && snapshot != value) return false
        snapshot = value
        return true
    }
    // A poll may finish before the initial detail; its first valid identity pins that view too.
    fun current(id: String, row: JSONObject): Boolean = accept(id, row)
    private fun identity(id: String, row: JSONObject): String? {
        if (row.optString("id") != id || row.optInt("version", 0) < 1 || row.optString("status") !in setOf("published", "proposed") || !row.optString("supersededBy").let { it.isBlank() || it == "null" }) return null
        return listOf(id, row.getInt("version"), row.optString("status"), row.optString("fingerprint")).joinToString("\u0000")
    }
}

internal data class MemoryTopicEdit(val label: String, val initial: String)
