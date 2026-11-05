package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Filter only on source metadata, never on an inferred meaning of the content. */
internal object LibraryBrowseRules {
    fun matches(item: JSONObject, category: String): Boolean {
        if (category == "all") return true
        val source = item.optString("source").ifBlank { item.optString("kind") }
        val local = item.optJSONObject("localItem")
        val mime = local?.optString("mimeType").orEmpty().ifBlank { item.optJSONObject("metadata")?.optJSONObject("file")?.optString("mimeType").orEmpty() }
        val image = source == "screen" || source == "image" || mime.startsWith("image/", ignoreCase = true)
        val type = item.optString("type")
        return when (category) {
            "records" -> source == "note"
            "images" -> image
            "notifications" -> source == "notification"
            "files" -> !image && (source == "file" || source == "ui_page" || type in setOf("material", "original"))
            else -> false
        }
    }

    fun matchesText(item: JSONObject, query: String): Boolean {
        val words = query.trim().split(Regex("\\s+")).filter(String::isNotBlank).take(12)
        if (words.isEmpty()) return true
        val body = item.optJSONObject("localItem")
        val text = listOf(item.optString("title"), item.optString("windowTitle"), item.optString("appName"), item.optString("textPreview"), item.optString("ocrText"), item.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optString("text").orEmpty(), body?.optString("title").orEmpty(), body?.optString("text").orEmpty()).joinToString("\n")
        return words.all { text.contains(it, ignoreCase = true) }
    }

    fun day(timestamp: String, zone: ZoneId): LocalDate = Instant.parse(timestamp).atZone(zone).toLocalDate()
}
