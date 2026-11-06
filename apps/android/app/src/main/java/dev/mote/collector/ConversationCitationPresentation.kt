package dev.mote.collector

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/** The source and position shown for one saved answer citation. The card and
 * the reader use the same labels; a destination is only the citation's own
 * evidence id, never another archive lookup. */
internal object ConversationCitationPresentation {
    data class Citation(val name: String, val detail: String, val excerpt: String, val targetId: String)

    fun read(citation: JSONObject): Citation {
        val excerpt = citation.optString("excerpt").trim()
        val document = citation.optJSONObject("provenance")?.optJSONObject("document")
        val file = citation.optJSONObject("fileEvidence")
        val pathName = document?.optString("path")?.let(::fileName)
        val firstLine = excerpt.lineSequence().map(String::trim).firstOrNull(String::isNotEmpty)?.take(80)
        val name = when {
            citation.optString("title").isNotBlank() -> citation.optString("title")
            file != null && pathName != null -> pathName
            firstLine != null -> firstLine
            else -> citation.optString("appName").ifBlank { MoteI18n.text("查看原文依据") }
        }
        val detail = when {
            file != null -> fileLocation(file)
            pathName != null -> MoteI18n.text("文件")
            else -> recordLocation(citation)
        }
        return Citation(name, detail, excerpt, citation.optString("id"))
    }

    /** Exact evidence slices are preferred; a trimmed match tolerates the
     * whitespace a reader may add around a stored excerpt. */
    fun locate(text: String, excerpt: String): IntRange? {
        if (text.isEmpty() || excerpt.isEmpty()) return null
        val direct = text.indexOf(excerpt)
        if (direct >= 0) return direct until direct + excerpt.length
        val trimmed = excerpt.trim()
        if (trimmed.isEmpty() || trimmed == excerpt) return null
        val match = text.indexOf(trimmed)
        return if (match >= 0) match until match + trimmed.length else null
    }

    private fun fileName(path: String): String? =
        path.substringAfterLast('/').substringAfterLast('\\').trim().takeIf(String::isNotEmpty)

    private fun fileLocation(file: JSONObject): String {
        file.optJSONObject("documentLocation")?.let { location ->
            location.optInt("pageNumber", 0).takeIf { it > 0 }?.let { return MoteI18n.text("第 {0} 页", it) }
            val row = location.optInt("rowNumber", 0)
            if (row > 0) {
                val sheet = location.optString("sheetName").trim()
                val rowLabel = MoteI18n.text("第 {0} 行", row)
                return if (sheet.isEmpty()) rowLabel else "$sheet · $rowLabel"
            }
        }
        val start = file.optLong("startMs", -1L)
        if (start >= 0) return MoteI18n.text("录音") + " · " + clock(start)
        return MoteI18n.text("文件")
    }

    private fun recordLocation(citation: JSONObject): String {
        val at = citation.optString("contentAt").ifBlank { citation.optString("capturedAt") }
        val instant = runCatching { Instant.parse(at) }.getOrNull() ?: return MoteI18n.text("记录")
        val zone = ZoneId.systemDefault()
        val date = instant.atZone(zone).toLocalDate()
        val today = java.time.LocalDate.now(zone)
        val day = when (date) {
            today -> MoteI18n.text("今天")
            today.minusDays(1) -> MoteI18n.text("昨天")
            else -> MoteI18n.text("{0}月{1}日", date.monthValue, date.dayOfMonth)
        }
        val time = runCatching { NativeOriginalDetail.time(instant.toString()) }.getOrNull()
            ?: instant.atZone(zone).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
        return MoteI18n.text("记录") + " · " + day + " " + time
    }

    private fun clock(milliseconds: Long): String {
        val total = (milliseconds / 1000).coerceAtLeast(0)
        return String.format(java.util.Locale.ROOT, "%d:%02d", total / 60, total % 60)
    }
}
