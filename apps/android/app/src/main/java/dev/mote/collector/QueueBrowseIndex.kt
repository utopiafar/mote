package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.UUID

/** Rebuildable local metadata projection. No OCR, window titles, device metadata or image bytes.
 * Callers hold DurableQueue's lock. Sixteen shards bound rewrite cost on capture/OCR updates.
 * Invalidate on disk BEFORE changing authoritative events, so a crash can only force a rebuild.
 */
internal class QueueBrowseIndex(private val dir: File, private val cipher: ByteCipher) {
    private val shards = mutableMapOf<Char, MutableMap<String, JSONObject>>()
    private val dirty = mutableSetOf<Char>()
    private val rowBytes = mutableMapOf<Char, Long>()
    private var deferredWrites = 0
    private var blobReferences: MutableMap<String, Int>? = null
    private fun file(key: Char) = File(dir, ".browse-v1-$key")
    private fun load(key: Char): MutableMap<String, JSONObject> = shards.getOrPut(key) {
        runCatching {
            val array = JSONArray(String(cipher.open(file(key).readBytes()), Charsets.UTF_8))
            (0 until array.length()).associate { val row = array.getJSONObject(it); row.getString("id") to row }.toMutableMap()
        }.getOrDefault(mutableMapOf()).also { rows -> rowBytes[key] = rows.values.sumOf { it.toString().toByteArray(Charsets.UTF_8).size.toLong() } }
        // A derived index can always be rebuilt from retained events.
    }
    fun invalidate(id: String) {
        load(id.first())
        val target = file(id.first())
        check(!target.exists() || target.delete()) { MoteI18n.text("无法更新浏览索引") }
    }
    val isBatching: Boolean get() = deferredWrites > 0
    fun beginBatch() { deferredWrites++ }
    fun endBatch() { check(deferredWrites > 0); deferredWrites--; if (deferredWrites == 0) flush() }
    private fun persist(key: Char) {
        dirty += key
        if (deferredWrites == 0) runCatching { save(key) }
    }
    private fun flush() { dirty.toList().forEach { key -> runCatching { save(key) } } }
    private fun save(key: Char) {
        val target = file(key)
        val rows = load(key)
        if (rows.isEmpty()) { check(!target.exists() || target.delete()); dirty -= key; return }
        val temp = File(dir, "${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(JSONArray(rows.values.toList()).toString().toByteArray())); it.fd.sync() }
            check(temp.renameTo(target)) { MoteI18n.text("无法保存浏览索引") }
            dirty -= key
        } finally { temp.delete() }
    }
    private fun replace(id: String, row: JSONObject?) {
        val rows = load(id.first())
        val old = if (row == null) rows.remove(id) else rows.put(id, row)
        rowBytes[id.first()] = rowBytes.getOrDefault(id.first(), 0L) - (old?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: 0) +
            (row?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: 0)
        blobReferences?.let { references ->
            old?.optString("blob")?.takeIf(String::isNotBlank)?.let { hash ->
                val count = references.getOrDefault(hash, 0) - 1
                if (count <= 0) references.remove(hash) else references[hash] = count
            }
            row?.optString("blob")?.takeIf(String::isNotBlank)?.let { hash -> references[hash] = references.getOrDefault(hash, 0) + 1 }
        }
    }
    fun changed(eventFile: File, event: JSONObject?) {
        val id = eventFile.nameWithoutExtension
        replace(id, event?.let { project(eventFile, it) })
        // Cache persistence failure must never turn a successful event commit into a failed capture.
        persist(id.first())
    }
    private fun project(file: File, event: JSONObject): JSONObject {
        require(event.getString("id") == file.nameWithoutExtension) { MoteI18n.text("记录 ID 与存储文件不匹配") }
        Instant.parse(event.getString("capturedAt"))
        val blocked = event.optBoolean("_archiveMissing") || event.optBoolean("_ocrConflict") || event.optBoolean("_uploadConflict")
        val awaitingOcr = event.optJSONObject("ocr")?.optString("status") == "pending" && !event.has("_ocrResult")
        return JSONObject()
            .put("id", file.nameWithoutExtension).put("capturedAt", event.getString("capturedAt"))
            .put("lastCapturedAt", event.optJSONObject("stateSeries")?.optJSONArray("samples")?.let { it.optJSONObject(it.length() - 1)?.optString("at") } ?: event.getString("capturedAt"))
            .put("source", event.optString("source", "screen")).put("appId", event.optString("appId"))
            .put("appName", event.optString("appName")).put("hasImage", event.optString("_blob").isNotBlank())
            .put("blob", event.optString("_blob")).put("bytes", file.length()).put("modified", file.lastModified())
            .put("metadataVersion", 4).put("blocked", blocked).put("awaitingOcr", awaitingOcr)
            .put("retainedUntil", event.optLong("_retainedUntil")).put("ocrUploaded", event.optBoolean("_ocrUploaded"))
            .put("uploaded", event.optBoolean("_uploaded")).put("hasOcrResult", event.has("_ocrResult"))
            .put("pending", !blocked && (!event.optBoolean("_uploaded") || event.has("_ocrResult") && !event.optBoolean("_ocrUploaded")))
            .put("reservedBytes", if (awaitingOcr && !blocked) DurableQueue.OCR_RESERVE_BYTES else 0L)
    }
    private fun valid(row: JSONObject?, eventFile: File, requireStatistics: Boolean) = row != null &&
        (!requireStatistics || row.optInt("metadataVersion") == 4) &&
        row.optLong("bytes") == eventFile.length() && row.optLong("modified") == eventFile.lastModified()

    fun missing(files: List<File>, requireStatistics: Boolean): List<File> = files.filter { eventFile ->
        !valid(load(eventFile.name.first())[eventFile.nameWithoutExtension], eventFile, requireStatistics)
    }

    fun entry(eventFile: File, read: (File) -> JSONObject, requireStatistics: Boolean = false): JSONObject {
        val id = eventFile.nameWithoutExtension; val cached = load(id.first())[id]
        if (valid(cached, eventFile, requireStatistics)) return cached!!
        return project(eventFile, read(eventFile)).also { replace(id, it); persist(id.first()) }
    }

    fun entries(files: List<File>, read: (File) -> JSONObject, requireStatistics: Boolean = false): List<JSONObject> {
        val result = mutableListOf<JSONObject>()
        files.forEach { require(UUID.fromString(it.nameWithoutExtension).toString() == it.nameWithoutExtension) { MoteI18n.text("记录文件名无效") } }
        val groups = files.groupBy { it.name.first() }
        for (key in "0123456789abcdef") {
            val rows = load(key); var changed = false
            val members = groups[key].orEmpty()
            val ids = members.mapTo(mutableSetOf()) { it.nameWithoutExtension }
            (rows.keys - ids).forEach { id -> replace(id, null); changed = true }
            for (eventFile in members) {
                val id = eventFile.nameWithoutExtension
                if (!valid(rows[id], eventFile, requireStatistics)) {
                    replace(id, project(eventFile, read(eventFile))); changed = true
                }
                result += rows.getValue(id)
            }
            if (changed) persist(key)
        }
        return result
    }
    /** Deferred writes still consume quota even while their invalidated shard is absent.
     * 64 bytes covers the optional encryption/escape framing without encrypting just to size it.
     */
    fun pendingDiskBytes(): Long = dirty.sumOf { key ->
        val count = load(key).size
        if (count == 0) 0L else (rowBytes.getOrDefault(key, 0L) + count + 1L + 64L - file(key).length()).coerceAtLeast(0)
    }
    /** Unknown/old entries reserve the maximum possible OCR growth until background upgrade.
     * This is an upper bound only: it can authorize a safe append, never bypass the quota.
     */
    fun reservationUpperBound(files: List<File>): Long = files.sumOf { eventFile ->
        val row = load(eventFile.name.first())[eventFile.nameWithoutExtension]
        if (valid(row, eventFile, requireStatistics = true)) row!!.getLong("reservedBytes") else DurableQueue.OCR_RESERVE_BYTES
    }
    /** Build once, then maintain reference counts with each committed mutation. */
    fun references(hash: String, files: () -> List<File>, read: (File) -> JSONObject): Int {
        if (blobReferences == null) {
            val rows = entries(files(), read)
            blobReferences = rows.map { it.optString("blob") }.filter(String::isNotBlank).groupingBy { it }.eachCount().toMutableMap()
        }
        return blobReferences!!.getOrDefault(hash, 0)
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
