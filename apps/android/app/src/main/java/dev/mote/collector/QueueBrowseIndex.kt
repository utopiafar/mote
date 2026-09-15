package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.UUID

/** Rebuildable, encrypted projection. No OCR, window titles, device metadata or image bytes.
 * Callers hold DurableQueue's lock. Sixteen shards bound rewrite cost on capture/OCR updates.
 * Invalidate on disk BEFORE changing authoritative events, so a crash can only force a rebuild.
 */
internal class QueueBrowseIndex(private val dir: File, private val cipher: ByteCipher) {
    private val shards = mutableMapOf<Char, MutableMap<String, JSONObject>>()
    private fun file(key: Char) = File(dir, ".browse-v1-$key")
    private fun load(key: Char): MutableMap<String, JSONObject> = shards.getOrPut(key) {
        runCatching {
            val array = JSONArray(String(cipher.open(file(key).readBytes()), Charsets.UTF_8))
            (0 until array.length()).associate { val row = array.getJSONObject(it); row.getString("id") to row }.toMutableMap()
        }.getOrDefault(mutableMapOf()) // A derived index can always be rebuilt from retained events.
    }
    fun invalidate(id: String) {
        load(id.first())
        val target = file(id.first())
        check(!target.exists() || target.delete()) { "无法更新浏览索引" }
    }
    private fun save(key: Char) {
        val target = file(key)
        val rows = load(key)
        if (rows.isEmpty()) { target.delete(); return }
        val temp = File(dir, "${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(JSONArray(rows.values.toList()).toString().toByteArray())); it.fd.sync() }
            check(temp.renameTo(target)) { "无法保存浏览索引" }
        } finally { temp.delete() }
    }
    fun changed(eventFile: File, event: JSONObject?) {
        val id = eventFile.nameWithoutExtension; val rows = load(id.first())
        if (event == null) rows.remove(id) else rows[id] = project(eventFile, event)
        // Cache persistence failure must never turn a successful event commit into a failed capture.
        runCatching { save(id.first()) }
    }
    private fun project(file: File, event: JSONObject): JSONObject {
        require(event.getString("id") == file.nameWithoutExtension) { "记录 ID 与存储文件不匹配" }
        Instant.parse(event.getString("capturedAt"))
        return JSONObject()
        .put("id", file.nameWithoutExtension).put("capturedAt", event.getString("capturedAt"))
        .put("source", event.optString("source", "screen")).put("appId", event.optString("appId"))
        .put("appName", event.optString("appName")).put("hasImage", event.optString("_blob").isNotBlank())
        .put("blob", event.optString("_blob")).put("bytes", file.length()).put("modified", file.lastModified())
    }

    fun entry(eventFile: File, read: (File) -> JSONObject): JSONObject {
        val id = eventFile.nameWithoutExtension; val rows = load(id.first()); val cached = rows[id]
        if (cached != null && cached.optLong("bytes") == eventFile.length() && cached.optLong("modified") == eventFile.lastModified()) return cached
        return project(eventFile, read(eventFile)).also { rows[id] = it; runCatching { save(id.first()) } }
    }

    fun entries(files: List<File>, read: (File) -> JSONObject): List<JSONObject> {
        val result = mutableListOf<JSONObject>()
        files.forEach { require(UUID.fromString(it.nameWithoutExtension).toString() == it.nameWithoutExtension) { "记录文件名无效" } }
        for (key in "0123456789abcdef") {
            val rows = load(key); var changed = false
            val members = files.filter { it.name.first() == key }
            val ids = members.mapTo(mutableSetOf()) { it.nameWithoutExtension }
            if (rows.keys.retainAll(ids)) changed = true
            for (eventFile in members) {
                val id = eventFile.nameWithoutExtension; val existing = rows[id]
                if (existing == null || existing.optLong("bytes") != eventFile.length() || existing.optLong("modified") != eventFile.lastModified()) {
                    rows[id] = project(eventFile, read(eventFile)); changed = true
                }
                result += rows.getValue(id)
            }
            if (changed) runCatching { save(key) }
        }
        return result
    }
}

/** Fixed clock windows are browsing buckets, not inferred activities or tasks. */
internal object CaptureAlbums {
    const val WINDOW_SECONDS = 15 * 60L
    fun start(at: String): Instant = Instant.ofEpochSecond(Math.floorDiv(Instant.parse(at).epochSecond, WINDOW_SECONDS) * WINDOW_SECONDS)
    fun page(rows: List<JSONObject>, cursor: String?, limit: Int = 20): JSONObject {
        val position = cursor?.let { JSONObject(String(java.util.Base64.getUrlDecoder().decode(it), Charsets.UTF_8)) }
        require(limit in 1..60)
        val groups = rows.groupBy { start(it.getString("capturedAt")) to it.optString("appId") }
            .map { (key, items) ->
                val newest = items.maxBy { Instant.parse(it.getString("capturedAt")) }
                JSONObject().put("id", newest.getString("id")).put("capturedAt", newest.getString("capturedAt"))
                    .put("after", key.first.toString()).put("before", key.first.plusSeconds(WINDOW_SECONDS).toString())
                    .put("appId", key.second).put("appName", newest.optString("appName"))
                    .put("firstAt", items.minOf { Instant.parse(it.getString("capturedAt")) }.toString())
                    .put("count", items.size).put("imageCount", items.count { it.optBoolean("hasImage") })
            }.sortedWith(compareByDescending<JSONObject> { Instant.parse(it.getString("after")) }.thenBy { it.optString("appId") })
        val page = groups.filter { position == null || Instant.parse(it.getString("after")) < Instant.parse(position.getString("after")) ||
            it.getString("after") == position.getString("after") && it.getString("appId") > position.getString("appId") }.take(limit + 1)
        val next = if (page.size <= limit) JSONObject.NULL else page[limit - 1].let {
            java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject().put("after", it.getString("after")).put("appId", it.getString("appId")).toString().toByteArray())
        }
        return JSONObject().put("items", JSONArray(page.take(limit)))
            .put("totalCount", rows.size).put("albumCount", groups.size)
            .put("nextCursor", next)
    }
}
