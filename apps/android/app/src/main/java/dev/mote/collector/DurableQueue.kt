package dev.mote.collector

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

class QueueFull : IllegalStateException("本机空间已满，暂停新增记录；同步释放空间或调大本机存储上限后恢复")

data class QueueStats(val depth: Int, val diskBytes: Long, val reservedOcrBytes: Long, val pendingSync: PendingSync) {
    val bytes: Long get() = diskBytes + reservedOcrBytes
}

/** Atomic encrypted events + content-addressed blobs. All callers share the process lock. */
class DurableQueue(private val dir: File, private val cipher: ByteCipher, createMissing: Boolean = true, private val onChange: ((OperationKind, Long, String) -> Unit)? = null) {
    companion object {
        private val lock = Any()
        fun <T> exclusive(action: () -> T): T = synchronized(lock) { action() }
        // 100,000 UTF-16 code units can require six JSON bytes each, plus result fields.
        private const val OCR_RESERVE_BYTES = 600_256L
        private val localFields = listOf("_uploaded", "_ocrResult", "_archiveMissing", "_ocrConflict", "_ocrAttempts")
        // Only fixed statistics are cached, never decrypted capture content. A bounded process cache
        // is shared by the short-lived queue handles; the encrypted files remain authoritative.
        private const val MAX_CACHED_DIRECTORIES = 4
        private const val MAX_CACHED_EVENTS = 50_000
        private data class EventStamp(val bytes: Long, val modifiedAt: Long)
        private data class EventStats(val stamp: EventStamp, val pending: Boolean, val reservedBytes: Long)
        private val statistics = object : LinkedHashMap<String, MutableMap<String, EventStats>>(MAX_CACHED_DIRECTORIES, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, MutableMap<String, EventStats>>?) = size > MAX_CACHED_DIRECTORIES
        }
    }
    internal var assertCurrent: (() -> Unit)? = null
    private inline fun <T> guarded(action: () -> T): T = synchronized(lock) { assertCurrent?.invoke(); action() }
    init { check(dir.isDirectory || createMissing && dir.mkdirs()) { "本机存储目录不可用" } }
    private fun records(): List<File> = dir.listFiles()?.filter { it.extension == "event" }?.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name }) ?: emptyList()
    fun stats(): QueueStats = guarded {
        val files = dir.listFiles() ?: error("无法读取本机存储目录")
        val cache = statistics.getOrPut(dir.absolutePath) { mutableMapOf() }
        val eventNames = files.filter { it.extension == "event" }.mapTo(mutableSetOf()) { it.name }
        cache.keys.retainAll(eventNames)
        var diskBytes = 0L; var reservedBytes = 0L; var pending = 0; var oldestAt: Long? = null
        for (file in files) {
            val length = file.length()
            if (file.isFile) diskBytes += length
            if (file.extension != "event") continue
            val stamp = EventStamp(length, file.lastModified())
            val cached = cache[file.name]?.takeIf { it.stamp == stamp } ?: run {
                // A failed decrypt is propagated. It must never become an empty/healthy queue.
                cache.remove(file.name)
                val event = read(file)
                EventStats(stamp, !syncFailed(event) && (!event.optBoolean("_uploaded") || event.has("_ocrResult")), ocrReserve(event))
                    .also { if (cache.size < MAX_CACHED_EVENTS) cache[file.name] = it }
            }
            reservedBytes += cached.reservedBytes
            if (cached.pending) { pending++; oldestAt = oldestAt?.let { minOf(it, stamp.modifiedAt) } ?: stamp.modifiedAt }
        }
        QueueStats(eventNames.size, diskBytes, reservedBytes, PendingSync(pending, oldestAt))
    }
    fun pendingSync(): PendingSync = stats().pendingSync
    fun depth(): Int = guarded { dir.listFiles()?.count { it.extension == "event" } ?: 0 }
    fun diskBytes(): Long = guarded { dir.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L }
    fun reservedOcrBytes(): Long = stats().reservedOcrBytes
    fun bytes(): Long = stats().bytes
    private fun read(file: File): JSONObject = JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8))
    private fun syncFailed(event: JSONObject) = event.optBoolean("_archiveMissing") || event.optBoolean("_ocrConflict")
    private fun ocrReserve(event: JSONObject) = if (event.optJSONObject("ocr")?.optString("status") == "pending" && !event.has("_ocrResult") && !syncFailed(event)) OCR_RESERVE_BYTES else 0L
    private fun atomic(file: File, bytes: ByteArray) {
        val temp = File(dir, "${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(bytes)); it.fd.sync() }
            check(temp.renameTo(file)) { "无法原子写入队列" }
            // Atomic replacements may have the same length and timestamp on coarse filesystems.
            statistics[dir.absolutePath]?.remove(file.name)
        } finally { temp.delete() }
    }
    fun enqueue(event: JSONObject, image: ByteArray?, maxBytes: Long) = guarded {
        require(!event.getJSONObject("privacy").optBoolean("excluded")) { "Excluded captures must never be queued" }
        val id = UUID.fromString(event.getString("id")).toString()
        val file = File(dir, "$id.event")
        val source = event.optString("source", "screen")
        if (image == null) require(source in setOf("note", "activity") && !event.has("imageMime") && !event.has("imageBase64")) { "Only notes or activity can omit images" }
        if (source == "activity") {
            require(image == null && event.getJSONObject("privacy").optString("collection") == "activity" && event.optString("appId").isNotBlank())
            require(listOf("ocrText", "title", "windowTitle", "mood", "provenance", "imageMime", "imageBase64").none(event::has)) { "Activity must not contain content" }
            event.optJSONObject("metadata")?.optJSONObject("capture")?.let { require(it.keys().asSequence().all { key -> key == "intervalMs" }) }
        }
        val hash = image?.let { MessageDigest.getInstance("SHA-256").digest(it).joinToString("") { byte -> "%02x".format(byte) } }
        val stored = JSONObject(event.toString()).put("_blob", hash)
        if (file.exists()) { check(read(file).apply { localFields.forEach(::remove) }.toString() == stored.toString()) { "相同记录 ID 的内容发生变化" }; return@guarded }
        val blob = hash?.let { File(dir, "$it.blob") }
        val body = stored.toString().toByteArray()
        val added = body.size + 64L + if (blob == null || blob.exists()) 0 else image!!.size + 64L
        if (bytes() + added + ocrReserve(stored) > maxBytes) throw QueueFull()
        if (blob != null && !blob.exists()) atomic(blob, image!!)
        atomic(file, body)
        onChange?.invoke(when (source) { "activity" -> OperationKind.ACTIVITY_QUEUED; "note" -> OperationKind.NOTE_QUEUED; else -> OperationKind.SCREEN_QUEUED }, added, id)
    }
    fun peek(): JSONObject? = guarded {
        val file = records().firstOrNull { val event = read(it); !event.optBoolean("_uploaded") && !syncFailed(event) } ?: return null
        val event = read(file)
        localFields.forEach(event::remove)
        val hash = event.optString("_blob", "")
        if (hash.isEmpty()) { require(event.getString("source") in setOf("note", "activity")); event.remove("_blob"); return event }
        require(hash.matches(Regex("[a-f0-9]{64}")))
        event.remove("_blob")
        event.put("imageBase64", Base64.getEncoder().encodeToString(cipher.open(File(dir, "$hash.blob").readBytes())))
        event
    }
    fun acknowledge(id: String, uploadedBytes: Long = 0): Unit = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val record = read(file)
        if (record.optBoolean("_uploaded")) return
        if (record.optJSONObject("ocr")?.optString("status") == "pending") atomic(file, record.put("_uploaded", true).toString().toByteArray())
        else remove(file, record)
        onChange?.invoke(when (record.optString("source")) { "activity" -> OperationKind.ACTIVITY_ACK; "note" -> OperationKind.NOTE_ACK; else -> OperationKind.SCREEN_ACK }, uploadedBytes, id)
    }
    private fun remove(file: File, record: JSONObject) {
        val hash = record.optString("_blob", "")
        check(file.delete()) { "无法删除已确认记录" }
        statistics[dir.absolutePath]?.remove(file.name)
        if (hash.isNotEmpty() && records().none { read(it).optString("_blob", "") == hash }) File(dir, "$hash.blob").delete()
    }
    fun pendingOcr(): JSONObject? = guarded {
        records().asSequence().map(::read).firstOrNull { it.optJSONObject("ocr")?.optString("status") == "pending" && !it.has("_ocrResult") && !syncFailed(it) }
            ?.apply { remove("_blob"); remove("_uploaded") }
    }
    fun completeOcr(id: String, text: String, status: String, maxBytes: Long) = guarded {
        require(status in setOf("completed", "failed") && text.length <= 100_000)
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val event = read(file)
        require(event.optJSONObject("ocr")?.optString("status") == "pending")
        val reserve = ocrReserve(event)
        val result = JSONObject().put("status", status).put("ocrText", text).put("updatedAt", java.time.Instant.now().toString())
        val body = event.put("_ocrResult", result).toString().toByteArray()
        val growth = body.size + 64L - file.length()
        // Completing a bounded pending result consumes its reservation, even if the user shrank the cap.
        if (growth > reserve && bytes() - reserve + growth > maxBytes) throw QueueFull()
        atomic(file, body)
    }
    fun recordOcrFailure(id: String): Int = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return 0
        val event = read(file); val attempts = (event.optInt("_ocrAttempts") + 1).coerceAtMost(100)
        atomic(file, event.put("_ocrAttempts", attempts).toString().toByteArray())
        attempts
    }
    fun nextOcrUpdate(): JSONObject? = guarded {
        records().asSequence().map(::read).firstOrNull { it.optBoolean("_uploaded") && it.has("_ocrResult") && !syncFailed(it) }
            ?.let { JSONObject(it.getJSONObject("_ocrResult").toString()).put("id", it.getString("id")) }
    }
    fun acknowledgeOcr(id: String) = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val event = read(file); require(event.optBoolean("_uploaded") && event.has("_ocrResult"))
        remove(file, event)
    }
    fun archiveMissing(id: String) = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        atomic(file, read(file).put("_archiveMissing", true).toString().toByteArray())
    }
    fun ocrConflict(id: String) = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        atomic(file, read(file).put("_ocrConflict", true).toString().toByteArray())
    }
    fun image(id: String): ByteArray? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return null
        val hash = read(file).optString("_blob")
        if (hash.isBlank()) return null
        require(hash.matches(Regex("[a-f0-9]{64}")))
        cipher.open(File(dir, "$hash.blob").readBytes())
    }
    fun capture(id: String): JSONObject? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return null
        display(read(file))
    }
    private fun display(event: JSONObject): JSONObject {
        event.put("hasImage", event.optString("_blob").isNotBlank()).put("uploaded", event.optBoolean("_uploaded"))
        event.optJSONObject("_ocrResult")?.let { result ->
            event.put("ocrText", result.getString("ocrText"))
                .put("ocr", JSONObject().put("status", result.getString("status")).put("updatedAt", result.getString("updatedAt")))
        }
        if (event.optBoolean("_archiveMissing")) event.put("syncError", "archive_missing").put("ocr", JSONObject().put("status", "failed"))
        if (event.optBoolean("_ocrConflict")) event.put("syncError", "ocr_conflict").put("ocr", JSONObject().put("status", "failed"))
        event.remove("_blob"); localFields.forEach(event::remove)
        return event
    }
    fun screenPage(after: String, before: String, cursor: String? = null, limit: Int = 20): JSONObject = guarded {
        require(limit in 1..60)
        val start = java.time.Instant.parse(after); val end = java.time.Instant.parse(before)
        val position = cursor?.let { JSONObject(String(Base64.getUrlDecoder().decode(it), Charsets.UTF_8)) }
        val at = position?.getString("at")?.let(java.time.Instant::parse); val id = position?.getString("id")
        val matching = records().asSequence().map(::read).filter { it.optString("source", "screen") == "screen" }
            .filter { java.time.Instant.parse(it.getString("capturedAt")).let { date -> date >= start && date < end } }
            .sortedWith(compareByDescending<JSONObject> { java.time.Instant.parse(it.getString("capturedAt")) }.thenByDescending { it.getString("id") }).toList()
        val page = matching.filter { item -> at == null || java.time.Instant.parse(item.getString("capturedAt")).let { date -> date < at || (date == at && item.getString("id") < id!!) } }.take(limit + 1)
        val items = page.take(limit)
        val next = if (page.size <= limit) null else items.last().let {
            Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject().put("at", it.getString("capturedAt")).put("id", it.getString("id")).toString().toByteArray())
        }
        JSONObject().put("items", org.json.JSONArray(items.map { display(it).apply { put("textPreview", optString("ocrText").take(160)); remove("ocrText") } }))
            .put("totalCount", matching.size).put("nextCursor", next ?: JSONObject.NULL)
    }
    fun summary(): JSONObject = guarded {
        val files = records(); var screens = 0; var notes = 0; var activities = 0; var unreadable = 0
        val pending = org.json.JSONArray()
        files.take(100).forEach { file -> try {
            val body = read(file); val source = body.optString("source", "screen"); val id = UUID.fromString(body.getString("id")).toString()
            val at = java.time.Instant.parse(body.getString("capturedAt")).toString()
            when (source) { "screen" -> screens++; "note" -> notes++; "activity" -> activities++; else -> error("unknown") }
            pending.put(JSONObject().put("id", id).put("kind", source).put("createdAt", at).put("bytes", file.length())
                .put("uploaded", body.optBoolean("_uploaded")).put("archiveMissing", body.optBoolean("_archiveMissing")))
        } catch (_: Exception) { unreadable++ } }
        JSONObject().put("total", files.size).put("screens", screens).put("notes", notes).put("activities", activities).put("unreadable", unreadable)
            .put("uninspected", (files.size - 100).coerceAtLeast(0)).put("bytes", diskBytes()).put("reservedOcrBytes", reservedOcrBytes()).put("pending", pending)
    }
    fun verifyIntegrity() = guarded {
        val checked = mutableSetOf<String>()
        for (file in records()) {
            val event = read(file)
            check(file.nameWithoutExtension == UUID.fromString(event.getString("id")).toString()) { "记录 ID 与存储文件不匹配" }
            val hash = event.optString("_blob", "")
            if (hash.isEmpty()) { check(event.getString("source") in setOf("note", "activity")); continue }
            check(hash.matches(Regex("[a-f0-9]{64}"))) { "图片引用无效" }
            if (checked.add(hash)) {
                val blob = File(dir, "$hash.blob")
                check(blob.isFile && !java.nio.file.Files.isSymbolicLink(blob.toPath())) { "本机图片缺失，原副本已保留" }
                val actual = MessageDigest.getInstance("SHA-256").digest(cipher.open(blob.readBytes())).joinToString("") { "%02x".format(it) }
                check(hash == actual) { "本机图片校验失败，原副本已保留" }
            }
        }
    }
    fun recoverOrphans() = guarded {
        // Read every event first. Corruption is surfaced; never silently discard an event.
        val referenced = records().map { read(it).optString("_blob", "") }.toSet()
        dir.listFiles()?.filter { it.extension == "tmp" || (it.extension == "blob" && it.nameWithoutExtension !in referenced) }?.forEach { it.delete() }
    }
}
