package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** Reads the existing shared FileView; coverage is independent of original availability. */
internal data class CentralFileView(val captureId: String, val sourceId: String, val externalId: String, val revision: String,
                                    val retention: String, val hasOriginal: Boolean, val originMissing: Boolean,
                                    val canOpenOriginal: Boolean, val extraction: Coverage, val semantic: Coverage, val embedding: Coverage) {
    data class Coverage(val status: String, val completed: Long?, val total: Long?) {
        val bodyAvailable: Boolean get() = status == "ready" || status == "partial" && completed != null && completed > 0
    }
    val bodyAvailable get() = retention != "reference" && extraction.bodyAvailable
    companion object {
        private fun coverage(value: JSONObject): Coverage {
            val status = value.getString("status"); require(status in setOf("pending", "partial", "ready", "failed", "unsupported"))
            require(value.has("completed") == value.has("total"))
            fun count(key: String): Long? {
                if (!value.has(key)) return null
                val number = value.get(key) as? Number ?: error("Invalid coverage count")
                val result = number.toLong()
                require(number.toDouble() == result.toDouble() && result in 0..9_007_199_254_740_991L)
                return result
            }
            val completed = count("completed"); val total = count("total")
            if (completed != null && total != null) {
                require(completed >= 0 && total >= completed && (status != "ready" || completed == total) && (status != "partial" || completed < total))
            }
            return Coverage(status, completed, total)
        }
        fun read(value: JSONObject): CentralFileView {
            val id = value.getString("captureId"); require(UUID.fromString(id).toString() == id.lowercase())
            val item = value.getJSONObject("item"); require(item.getString("kind") == "file")
            val retention = value.getString("retention"); require(retention in setOf("reference", "snapshot", "archive"))
            val original = value.get("hasOriginal") as? Boolean ?: error("Invalid original availability")
            val open = value.get("canOpenOriginal") as? Boolean ?: error("Invalid original capability")
            require(!open || original); require(retention != "reference" || !original)
            val coverage = value.getJSONObject("coverage")
            return CentralFileView(id, value.getString("sourceId"), item.getString("externalId"), item.getString("revision"), retention,
                original, value.get("originMissing") as? Boolean ?: error("Invalid origin availability"), open, coverage(coverage.getJSONObject("extraction")),
                coverage(coverage.getJSONObject("semantic")), coverage(coverage.getJSONObject("embedding")))
        }
        fun forOriginal(row: JSONObject): CentralFileView? = runCatching {
            val view = read(row.getJSONObject("_fileView"))
            require(view.captureId == row.getString("captureId") && view.sourceId == row.getString("sourceId") &&
                view.externalId == row.getString("externalId") && view.revision == row.getString("revision"))
            view
        }.getOrNull()
        fun forDetail(detail: JSONObject, raw: JSONObject): CentralFileView? = runCatching {
            val view = read(raw)
            require(view.captureId == detail.getString("captureId") &&
                view.revision == detail.getJSONObject("item").optString("revision"))
            view
        }.getOrNull()
        /** Recheck each file before publishing the page. A failed access check
         * fails the page instead of disclosing metadata fetched before revocation. */
        fun enrichOriginals(page: JSONObject, fetch: (String) -> JSONObject) {
            val views = mutableMapOf<String, JSONObject>()
            fun enrich(row: JSONObject) {
                if (!row.has("fileArchive")) return
                val id = row.getString("captureId")
                row.put("_fileView", views.getOrPut(id) { fetch(id) })
            }
            val items = page.getJSONArray("items"); repeat(items.length()) { enrich(items.getJSONObject(it)) }
            val matched = page.getJSONArray("matches"); repeat(matched.length()) { matched.getJSONObject(it).optJSONObject("original")?.let(::enrich) }
        }
    }
}
