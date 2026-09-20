package dev.mote.collector

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

class QueueFull : IllegalStateException(MoteI18n.text("本机空间已满，暂停新增记录；同步释放空间或调大本机存储上限后恢复"))

data class QueueStats(val depth: Int, val diskBytes: Long, val reservedOcrBytes: Long, val pendingSync: PendingSync) {
    val bytes: Long get() = diskBytes + reservedOcrBytes
}

/** Atomic events + content-addressed blobs. All callers share the process lock. */
class DurableQueue(private val dir: File, private val cipher: ByteCipher, createMissing: Boolean = true, private val onChange: ((OperationKind, Long, String) -> Unit)? = null) {
    companion object {
        private val lock = Any()
        private val stateHeads = object : LinkedHashMap<String, JSONObject>(4, .75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?) = size > 4
        }
        fun <T> exclusive(action: () -> T): T = synchronized(lock) { action() }
        // 100,000 UTF-16 code units can require six JSON bytes each, plus result fields.
        internal const val OCR_RESERVE_BYTES = 600_256L
        private val localFields = listOf("_centralDerived", "_reviewHeld", "_uploaded", "_retainedUntil", "_ocrUploaded", "_ocrResult", "_archiveMissing", "_ocrConflict", "_ocrAttempts", "_uploadConflict")
        // Only fixed statistics and date/source index fields are cached, never capture content. A bounded process cache
        // is shared by the short-lived queue handles; the record files remain authoritative.
        private const val MAX_CACHED_DIRECTORIES = 4
        private val browseIndexes = object : LinkedHashMap<String, QueueBrowseIndex>(4, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, QueueBrowseIndex>?) =
                size > MAX_CACHED_DIRECTORIES && eldest?.value?.isBatching == false
        }

        private data class BlobStamp(val bytes: Long, val modified: Long)
        private val validatedBlobs = object : LinkedHashMap<String, BlobStamp>(256, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, BlobStamp>?) = size > 4096
        }
    }
    /** Nonblocking invalidation only; listeners must never read storage inside this callback. */
    internal var onMutation: ((Boolean) -> Unit)? = null
    internal var assertCurrent: (() -> Unit)? = null
    private inline fun <T> guarded(action: () -> T): T = synchronized(lock) { assertCurrent?.invoke(); action() }
    init { check(dir.isDirectory || createMissing && dir.mkdirs()) { MoteI18n.text("本机存储目录不可用") } }
    private fun browseFiles() = dir.listFiles()?.filter { it.extension == "event" } ?: error(MoteI18n.text("无法读取本机存储目录"))
    private fun browseIndex() = browseIndexes.getOrPut(dir.absolutePath) { QueueBrowseIndex(dir, cipher) }
    private fun records(): List<File> = dir.listFiles()?.filter { it.extension == "event" }?.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name }) ?: emptyList()
    private fun metadata(files: List<File> = browseFiles()) = browseIndex().entries(files, ::read, requireStatistics = true)
    fun stats(): QueueStats {
        prepareIndex()
        return guarded {
            val rows = metadata()
            val pending = rows.filter { it.optBoolean("pending") }
            QueueStats(rows.size, diskBytes(), rows.sumOf { it.optLong("reservedBytes") },
                PendingSync(pending.size, pending.minOfOrNull { it.getLong("modified") }))
        }
    }
    /** Exact inventory of committed records, distinct from cumulative operation counters. */
    fun inventory(): QueueInventory {
        prepareIndex()
        return guarded {
            val values = metadata()
            val files = dir.listFiles() ?: error(MoteI18n.text("无法读取本机存储目录"))
            val hashes = values.map { it.optString("blob") }.filter(String::isNotBlank).toSet()
            val blobs = files.filter { it.extension == "blob" }.mapTo(mutableSetOf()) { it.nameWithoutExtension }
            check(blobs.containsAll(hashes)) { MoteI18n.text("部分图片文件缺失，保留上次统计") }
            QueueInventory(values.size, values.count { it.optBoolean("hasImage") }, hashes.size,
                values.count { it.optBoolean("pending") }, values.count { it.optBoolean("awaitingOcr") && !it.optBoolean("blocked") }, values.count { it.optBoolean("blocked") },
                files.filter { it.isFile }.sumOf { it.length() }, values.sumOf { it.optLong("reservedBytes") })
        }
    }
    fun syncInventory(): JSONObject {
        prepareIndex()
        return guarded {
            val values = metadata()
            JSONObject().put("retained", values.size).put("pending", values.count { it.optBoolean("pending") })
                .put("blocked", values.count { it.optBoolean("blocked") }).put("awaitingOcr", values.count { it.optBoolean("awaitingOcr") && !it.optBoolean("blocked") })
                .put("uploadedRetained", values.count { it.optBoolean("uploaded") })
        }
    }
    fun syncIssues(limit: Int = 20): List<JSONObject> {
        prepareIndex()
        return guarded {
            require(limit in 1..100)
            metadata().asSequence().filter { it.optBoolean("blocked") }.sortedBy { it.getLong("modified") }.take(limit).map { row ->
                val file = File(dir, "${row.getString("id")}.event")
                val event = read(file)
                JSONObject().put("id", file.nameWithoutExtension).put("source", event.optString("source", "screen"))
                    .put("capturedAt", event.getString("capturedAt"))
                    .put("reviewHeld", event.optBoolean("_reviewHeld"))
                    .put("retryable", !event.optBoolean("_archiveMissing"))
                    .put("reason", if (event.optBoolean("_reviewHeld")) MoteI18n.text("上传审查待复核") else if (event.optBoolean("_archiveMissing")) MoteI18n.text("中央不可用 / 已删除") else if (event.optBoolean("_ocrConflict")) MoteI18n.text("OCR 内容冲突") else MoteI18n.text("记录内容冲突"))
            }.toList()
        }
    }
    /** Paginated metadata only; never loads image payloads to render the upload queue. */
    fun pendingPage(offset: Int = 0, limit: Int = 30): JSONObject {
        require(offset >= 0 && limit in 1..60)
        prepareIndex()
        return guarded {
            val rows = metadata().filter { it.optBoolean("pending") || it.optBoolean("blocked") || it.optBoolean("awaitingOcr") }
                .sortedWith(compareBy<JSONObject> { it.getLong("modified") }.thenBy { it.getString("id") })
            val items = rows.drop(offset).take(limit).map { row -> JSONObject(row.toString()).put("status", when {
                row.optBoolean("blocked") -> MoteI18n.text("需处理")
                row.optBoolean("uploaded") && row.optBoolean("hasOcrResult") -> MoteI18n.text("OCR 待上传")
                row.optBoolean("uploaded") -> MoteI18n.text("等待 OCR")
                else -> MoteI18n.text("等待上传")
            }) }
            JSONObject().put("total", rows.size).put("items", org.json.JSONArray(items))
        }
    }
    fun syncIds(after: String? = null, limit: Int = 100): List<String> = guarded {
        require(limit in 1..100)
        records().map { it.nameWithoutExtension }.filter { after == null || it > after }.sorted().take(limit)
    }
    /** Replay original immutable events, never display/OCR-merged records or centrally rejected IDs. */
    fun requeueRetained(): Int = guarded {
        var count = 0
        for (file in records()) {
            val event = read(file)
            if (syncFailed(event)) continue
            if (event.optBoolean("_uploaded")) { event.remove("_uploaded"); event.remove("_ocrUploaded"); event.remove("_retainedUntil"); atomic(file, event.toString().toByteArray()) }
            count++
        }; count
    }
    /** Explicit retry revalidates through the existing immutable-ID endpoint; never clears deletion blocks. */
    fun retryConflict(id: String, maxBytes: Long): Boolean = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return@guarded false
        val event = read(file)
        if (event.optBoolean("_archiveMissing")) return@guarded false
        if (!event.optBoolean("_uploadConflict") && !event.optBoolean("_ocrConflict")) return@guarded false
        val previousReserve = ocrReserve(event)
        event.remove("_uploadConflict"); event.remove("_ocrConflict"); event.remove("_reviewHeld")
        if (bytes() + ocrReserve(event) - previousReserve > maxBytes) throw QueueFull()
        atomic(file, event.toString().toByteArray()); true
    }
    fun uploadConflict(id: String) = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (file.exists()) atomic(file, read(file).put("_uploadConflict", true).toString().toByteArray())
    }
    fun cacheCentralDerived(item: JSONObject, maxBytes: Long) = guarded {
        val file = File(dir, "${UUID.fromString(item.getString("id"))}.event")
        if (!file.exists()) return@guarded
        val event = read(file)
        if (!event.optBoolean("_uploaded") || event.optBoolean("_reviewHeld")) return@guarded
        val old = file.length()
        event.put("_centralDerived", item)
        val body = event.toString().toByteArray()
        if (bytes() + body.size - old > maxBytes) return@guarded
        atomic(file, body)
    }
    fun pendingSync(): PendingSync = stats().pendingSync
    fun depth(): Int = guarded { dir.listFiles()?.count { it.extension == "event" } ?: 0 }
    fun diskBytes(): Long = guarded { dir.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L }
    fun reservedOcrBytes(): Long = stats().reservedOcrBytes
    fun bytes(): Long = stats().bytes
    private fun read(file: File): JSONObject = JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8))
    private fun syncFailed(event: JSONObject) = event.optBoolean("_archiveMissing") || event.optBoolean("_ocrConflict") || event.optBoolean("_uploadConflict")
    private fun ocrReserve(event: JSONObject) = if (event.optJSONObject("ocr")?.optString("status") == "pending" && !event.has("_ocrResult") && !syncFailed(event)) OCR_RESERVE_BYTES else 0L
    private fun atomic(file: File, bytes: ByteArray, modifiedAt: Long? = null) {
        val temp = File(dir, "${UUID.randomUUID()}.tmp")
        try {
            if (file.extension == "event") browseIndex().invalidate(file.nameWithoutExtension)
            FileOutputStream(temp).use { it.write(cipher.seal(bytes)); it.fd.sync() }
            check(temp.renameTo(file)) { MoteI18n.text("无法原子写入队列") }
            if (modifiedAt != null) file.setLastModified(modifiedAt)
            if (file.extension == "blob") validatedBlobs.remove(file.absolutePath)
            onMutation?.invoke(file.extension == "event")
            // Atomic replacements may have the same length and timestamp on coarse filesystems.
            if (file.extension == "event") browseIndex().changed(file, JSONObject(String(bytes, Charsets.UTF_8)))
        } finally { temp.delete() }
    }
    private fun isDuplicate(event: JSONObject): Boolean {
        val dedupe = event.optJSONObject("metadata")?.optJSONObject("capture")?.optJSONObject("deduplication") ?: return false
        return event.optString("source") == "screen" && dedupe.optBoolean("duplicate") &&
            dedupe.optString("mode") in setOf("exact", "conservative", "balanced", "aggressive") &&
            event.optString("ocrText").isEmpty() && event.optJSONObject("ocr")?.optString("status") == "disabled" &&
            !event.has("imageMime") && !event.has("imageBase64")
    }
    private fun capacityUpperBound(): Long = diskBytes() + browseIndex().pendingDiskBytes() + browseIndex().reservationUpperBound(browseFiles())
    fun enqueue(rawEvent: JSONObject, image: ByteArray?, maxBytes: Long, reviewHeld: Boolean = false) {
        // Sufficient upper-bound headroom permits capture before a legacy index has finished
        // rebuilding. Otherwise discover the exact reservation without monopolizing the lock.
        val event = rawEvent
        val maximumAddition = event.toString().toByteArray().size + 4096L + (image?.size ?: 0) + ocrReserve(event)
        if (guarded { capacityUpperBound() > maxBytes - maximumAddition }) prepareIndex()
        guarded {
        val event = StateSeries.extend(stateHeads[dir.absolutePath], rawEvent)
        require(!event.getJSONObject("privacy").optBoolean("excluded")) { "Excluded captures must never be queued" }
        fun requireAppName(value: JSONObject) {
            if (value.optString("appId").isNotEmpty()) require(value.opt("appName") is String && value.getString("appName").isNotBlank() && value.getString("appName").length <= 200) { MoteI18n.text("应用标识必须同时包含应用名称") }
        }
        requireAppName(event)
        event.optJSONObject("metadata")?.optJSONObject("media")?.optJSONArray("sessions")?.let { sessions ->
            for (i in 0 until sessions.length()) requireAppName(sessions.getJSONObject(i))
        }
        val id = UUID.fromString(event.getString("id")).toString()
        val file = File(dir, "$id.event")
        val source = event.optString("source", "screen")
        if (image == null) require((source in setOf("note", "activity", "media", "notification", "device_event", "ui_page") || isDuplicate(event)) && !event.has("imageMime") && !event.has("imageBase64")) { "Only notes, activity or media can omit images" }
        if (source == "activity") {
            require(image == null && event.getJSONObject("privacy").optString("collection") == "activity" && event.optString("appId").isNotBlank())
            require(listOf("ocrText", "title", "windowTitle", "mood", "provenance", "imageMime", "imageBase64").none(event::has)) { "Activity must not contain content" }
            event.optJSONObject("metadata")?.optJSONObject("capture")?.let { require(it.keys().asSequence().all { key -> key == "intervalMs" }) }
        }
        if (source == "ui_page") { require(image == null); UiPageRules.validateEvent(event) }
        if (source in SystemEventRules.sources) { require(image == null); SystemEventRules.validate(event) }
        if (source == "media") { require(image == null); MediaPrivacy.validateEvent(event) }
        if (source == "activity") event.optJSONObject("metadata")?.optJSONObject("media")?.optJSONArray("sessions")?.let { sessions ->
            for (i in 0 until sessions.length()) require(MediaPrivacy.contentKeys.none(sessions.getJSONObject(i)::has))
        }
        val hash = image?.let { MessageDigest.getInstance("SHA-256").digest(it).joinToString("") { byte -> "%02x".format(byte) } }
        val stored = JSONObject(event.toString()).put("_blob", hash)
        if (file.exists() && SourceRules.canonical(read(file).apply { localFields.forEach(::remove) }) == SourceRules.canonical(stored)) return@guarded
        if (file.exists() && !event.has("stateSeries")) { check(read(file).apply { localFields.forEach(::remove) }.toString() == stored.toString()) { MoteI18n.text("相同记录 ID 的内容发生变化") }; return@guarded }
        val blob = hash?.let { File(dir, "$it.blob") }
        if (reviewHeld) stored.put("_uploadConflict", true).put("_reviewHeld", true)
        val body = stored.toString().toByteArray()
        val added = body.size + 2048L + if (blob == null || blob.exists()) 0 else image!!.size + 64L
        val required = added + ocrReserve(stored)
        val upperBound = capacityUpperBound()
        if (upperBound > maxBytes - required && bytes() + browseIndex().pendingDiskBytes() > maxBytes - required) throw QueueFull()
        if (blob != null && !blob.exists()) atomic(blob, image!!)
        atomic(file, body)
        stateHeads[dir.absolutePath] = JSONObject(event.toString())
        onChange?.invoke(when (source) { "ui_page" -> OperationKind.PAGE_QUEUED; "notification", "device_event" -> OperationKind.SYSTEM_EVENT_QUEUED; "media" -> OperationKind.MEDIA_QUEUED; "activity" -> OperationKind.ACTIVITY_QUEUED; "note" -> OperationKind.NOTE_QUEUED; else -> OperationKind.SCREEN_QUEUED }, added, id)
        }
    }
    fun peek(): JSONObject? = peekBatch(1).firstOrNull()
    /** Bound both count and UTF-8 transport size; never acknowledges while selecting. */
    fun peekBatch(maxCount: Int = 25, maxBytes: Int = 8 * 1024 * 1024, metadataWindowMinutes: Int = 10): List<JSONObject> {
        prepareIndex()
        return guarded {
            require(maxCount in 1..500 && maxBytes > 0 && metadataWindowMinutes in 1..1440)
            val result = mutableListOf<JSONObject>()
            var bytes = 32L
            var metadataWindow: Long? = null
            for (row in metadata().sortedWith(compareBy<JSONObject> { it.getLong("modified") }.thenBy { it.getString("id") })) {
                if (row.optBoolean("uploaded") || row.optBoolean("blocked")) continue
                val event = read(File(dir, "${row.getString("id")}.event"))
                localFields.forEach(event::remove)
                val hash = event.optString("_blob", "")
                event.remove("_blob")
                val metadataOnly = hash.isEmpty()
                if (metadataWindow != null && (!metadataOnly || metadataWindow(event.getString("capturedAt"), metadataWindowMinutes) != metadataWindow)) continue
                if (metadataOnly) {
                    require(event.getString("source") in setOf("note", "activity", "media", "notification", "device_event", "ui_page") || isDuplicate(event))
                    if (metadataWindow == null) metadataWindow = metadataWindow(event.getString("capturedAt"), metadataWindowMinutes)
                }
                else {
                    require(hash.matches(Regex("[a-f0-9]{64}")))
                    event.put("imageBase64", Base64.getEncoder().encodeToString(cipher.open(File(dir, "$hash.blob").readBytes())))
                }
                val size = event.toString().toByteArray(Charsets.UTF_8).size + 1L
                if (result.isNotEmpty() && bytes + size > maxBytes) break
                result.add(event); bytes += size
                // A single oversized record is returned alone so the uploader can report it.
                if (result.size == maxCount || bytes >= maxBytes) break
        }
        result
        }
    }
    private fun metadataWindow(capturedAt: String, minutes: Int): Long =
        java.time.Instant.parse(capturedAt).toEpochMilli() / (minutes * 60_000L)
    fun acknowledge(id: String, uploadedBytes: Long = 0, retentionDays: Int = 0, now: Long = System.currentTimeMillis(), observations: Int? = null): Unit = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val record = read(file)
        if (observations != null && (record.optJSONObject("stateSeries")?.optJSONArray("samples")?.length() ?: 0) > observations) return
        if (record.optBoolean("_uploaded")) return
        if (record.optJSONObject("ocr")?.optString("status") == "pending") atomic(file, record.put("_uploaded", true).toString().toByteArray())
        else retainOrRemove(file, record, retentionDays, now)
        onChange?.invoke(when (record.optString("source")) { "ui_page" -> OperationKind.PAGE_ACK; "notification", "device_event" -> OperationKind.SYSTEM_EVENT_ACK; "media" -> OperationKind.MEDIA_ACK; "activity" -> OperationKind.ACTIVITY_ACK; "note" -> OperationKind.NOTE_ACK; else -> OperationKind.SCREEN_ACK }, uploadedBytes, id)
    }
    private fun retainOrRemove(file: File, record: JSONObject, days: Int, now: Long) {
        require(days in 0..365)
        if (days == 0) remove(file, record)
        else atomic(file, record.put("_uploaded", true).put("_retainedUntil", now + days * 86_400_000L).toString().toByteArray())
    }
    /** Never prune pending uploads, pending OCR or conflict records. Deadline starts at final ACK. */
    fun pruneUploaded(now: Long = System.currentTimeMillis()): Int {
        prepareIndex()
        val ids = guarded { metadata().filter { it.optLong("retainedUntil") in 1..now && !it.optBoolean("pending") && !it.optBoolean("blocked") && !it.optBoolean("awaitingOcr") }.map { it.getString("id") } }
        var count = 0
        withDeferredIndexWrites {
            for (id in ids) guarded {
                val file = File(dir, "$id.event")
                if (file.exists()) {
                    val event = read(file)
                    if (event.optBoolean("_uploaded") && event.optLong("_retainedUntil") in 1..now && !syncFailed(event) &&
                        (event.optJSONObject("ocr")?.optString("status") != "pending" || event.optBoolean("_ocrUploaded"))) { remove(file, event); count++ }
                }
            }
        }
        return count
    }
    private fun remove(file: File, record: JSONObject) {
        val hash = record.optString("_blob", "")
        val lastReference = hash.isNotEmpty() && browseIndex().references(hash, ::browseFiles, ::read) == 1
        browseIndex().invalidate(file.nameWithoutExtension)
        check(file.delete()) { MoteI18n.text("无法删除已确认记录") }
        onMutation?.invoke(true)
        browseIndex().changed(file, null)
        if (lastReference) {
            File(dir, "$hash.blob").delete(); File(dir, "$hash.thumb").delete()
        }
    }
    fun pendingOcr(): JSONObject? {
        prepareIndex()
        return guarded {
            metadata().asSequence().filter { it.optBoolean("awaitingOcr") && !it.optBoolean("blocked") }.minByOrNull { it.getLong("modified") }
                ?.let { read(File(dir, "${it.getString("id")}.event")) }?.apply { remove("_blob"); remove("_uploaded") }
        }
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
    fun nextOcrUpdate(): JSONObject? {
        prepareIndex()
        return guarded {
            metadata().asSequence().filter { it.optBoolean("uploaded") && it.optBoolean("hasOcrResult") && !it.optBoolean("ocrUploaded") && !it.optBoolean("blocked") }.minByOrNull { it.getLong("modified") }
                ?.let { read(File(dir, "${it.getString("id")}.event")) }
                ?.let { JSONObject(it.getJSONObject("_ocrResult").toString()).put("id", it.getString("id")) }
        }
    }
    fun acknowledgeOcr(id: String, retentionDays: Int = 0, now: Long = System.currentTimeMillis()) = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val event = read(file); require(event.optBoolean("_uploaded") && event.has("_ocrResult"))
        if (event.optBoolean("_ocrUploaded")) return
        retainOrRemove(file, event.put("_ocrUploaded", true), retentionDays, now)
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
    /** The caller's work never holds the queue lock; each mutation still commits atomically.
     * A crash during a batch leaves invalidated shards absent and rebuildable from events.
     */
    fun <T> withDeferredIndexWrites(action: () -> T): T {
        val index = guarded { browseIndex().also { it.beginBatch() } }
        try { return action() } finally { synchronized(lock) { index.endBatch() } }
    }
    /** Upgrade/rebuild derived metadata in small lock acquisitions so collection can proceed. */
    fun prepareIndex(requireStatistics: Boolean = true, shouldStop: () -> Boolean = { false }) = withDeferredIndexWrites {
        val files = guarded { browseIndex().missing(browseFiles(), requireStatistics) }
        for (chunk in files.chunked(8)) {
            if (shouldStop()) break
            guarded { chunk.filter(File::exists).forEach { browseIndex().entry(it, ::read, requireStatistics = requireStatistics) } }
        }
    }
    private fun verifiedBlob(hash: String, readBytes: Boolean = false): ByteArray? {
        require(hash.matches(Regex("[a-f0-9]{64}")))
        val file = File(dir, "$hash.blob")
        if (!file.isFile) throw java.io.FileNotFoundException(MoteI18n.text("图片文件缺失，原记录已保留"))
        val stamp = BlobStamp(file.length(), file.lastModified())
        if (!readBytes && validatedBlobs[file.absolutePath] == stamp) return null
        val bytes = cipher.open(file.readBytes())
        val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        check(actual == hash) { MoteI18n.text("图片校验失败，原记录已保留") }
        validatedBlobs[file.absolutePath] = stamp
        return bytes
    }
    /** IDs only: callers read one record per lock acquisition while scanning in a worker. */
    fun dedupeIds(): List<String> = guarded { browseFiles().map { it.nameWithoutExtension } }
    fun dedupeRow(id: String): JSONObject? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) null else JSONObject(browseIndex().entry(file, ::read).toString())
    }
    /** Commit only against the exact blobs reviewed. Never remove the retained reference. */
    fun resolveDedupe(id: String, hash: String, referenceId: String?, referenceHash: String?, destination: DurableQueue?, destinationMaxBytes: Long = Long.MAX_VALUE): Boolean = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return@guarded false
        val event = read(file)
        if (event.optString("_blob") != hash) return@guarded false
        if (referenceId != null) {
            require(referenceId != id)
            val reference = File(dir, "${UUID.fromString(referenceId)}.event")
            if (!reference.exists() || read(reference).optString("_blob") != referenceHash) return@guarded false
            verifiedBlob(requireNotNull(referenceHash))
        }
        if (destination != null) {
            destination.assertCurrent?.invoke()
            require(destination.dir.canonicalFile != dir.canonicalFile)
            val target = File(destination.dir, file.name)
            val blob = File(destination.dir, "$hash.blob")
            // Validate the source and any already-committed destination before removing anything.
            verifiedBlob(hash)
            if (target.exists()) check(destination.read(target).toString() == event.toString()) { MoteI18n.text("目标已有不同记录，保留两份以供检查") }
            else {
                val additional = event.toString().toByteArray().size + 2048L + ocrReserve(event) +
                    if (blob.exists()) 0L else File(dir, "$hash.blob").length() + 64L
                if (destination.bytes() + destination.browseIndex().pendingDiskBytes() > destinationMaxBytes - additional) throw QueueFull()
                if (!blob.exists()) destination.atomic(blob, requireNotNull(verifiedBlob(hash, readBytes = true)))
                destination.verifiedBlob(hash)
                destination.atomic(target, event.toString().toByteArray())
                check(destination.read(target).toString() == event.toString())
            }
            // This also validates a destination left by an interrupted earlier attempt.
            destination.verifiedBlob(hash)
        }
        remove(file, event)
        true
    }
    fun archiveRecord(id: String): Pair<JSONObject, ByteArray?>? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) null else {
            val event = read(file)
            val hash = event.optString("_blob")
            event to if (hash.isBlank()) null else verifiedBlob(hash, readBytes = true)
        }
    }
    fun image(id: String): ByteArray? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return null
        val hash = browseIndex().entry(file, ::read).optString("blob")
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
        val hash = event.optString("_blob")
        event.put("sizeBytes", event.optString("ocrText").toByteArray().size.toLong() + if (hash.matches(Regex("[a-f0-9]{64}"))) File(dir, "$hash.blob").length() else 0L)
        event.put("ocrSynced", event.optBoolean("_ocrUploaded")).put("retainedUntil", event.optLong("_retainedUntil"))
        event.put("hasImage", event.optString("_blob").isNotBlank()).put("uploaded", event.optBoolean("_uploaded"))
        event.optJSONObject("_ocrResult")?.let { result ->
            event.put("ocrText", result.getString("ocrText"))
                .put("ocr", JSONObject().put("status", result.getString("status")).put("updatedAt", result.getString("updatedAt")))
        }
        if (event.optBoolean("_uploadConflict")) event.put("syncError", "upload_conflict")
        if (event.optBoolean("_archiveMissing")) event.put("syncError", "archive_missing").put("ocr", JSONObject().put("status", "failed"))
        if (event.optBoolean("_ocrConflict")) event.put("syncError", "ocr_conflict").put("ocr", JSONObject().put("status", "failed"))
        event.optJSONObject("_centralDerived")?.let { result ->
            event.put("centralProcessing", result.optJSONArray("perceptionJobs"))
            if (result.optJSONObject("ocr")?.optString("status") == "completed") {
                event.put("ocrText", result.optString("textPreview")); event.put("ocr", result.getJSONObject("ocr"))
                event.put("centralTextLength", result.optInt("textLength")); event.put("centralPreview", true)
            }
        }
        event.remove("_blob"); localFields.forEach(event::remove)
        return event
    }
    fun screenPage(after: String, before: String, cursor: String? = null, limit: Int = 20) = capturePage(after, before, cursor, limit, "screen")
    fun capturePage(after: String, before: String, cursor: String? = null, limit: Int = 20, source: String = "screen"): JSONObject {
        prepareIndex(requireStatistics = true)
        return guarded {
            require(limit in 1..60)
            require(source in setOf("screen", "media", "notification", "device_event", "note", "activity", "ui_page"))
            val start = java.time.Instant.parse(after); val end = java.time.Instant.parse(before)
            val position = cursor?.let { JSONObject(String(Base64.getUrlDecoder().decode(it), Charsets.UTF_8)) }
            val at = position?.getString("at")?.let(java.time.Instant::parse); val id = position?.getString("id")
            val matching = browseIndex().entries(browseFiles(), ::read).asSequence()
                .filter { it.optString("source") == source }
                .map { it to java.time.Instant.parse(it.getString("capturedAt")) }
                .filter { (row, date) -> java.time.Instant.parse(row.optString("lastCapturedAt", row.getString("capturedAt"))) >= start && date < end }
                .sortedWith(compareByDescending<Pair<JSONObject, java.time.Instant>> { it.second }.thenByDescending { it.first.getString("id") }).toList()
            val page = matching.filter { (row, date) -> at == null || date < at || (date == at && row.getString("id") < id!!) }.take(limit + 1)
            val items = page.take(limit).map { read(File(dir, "${it.first.getString("id")}.event")) }
            val next = if (page.size <= limit) null else items.last().let {
                Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject().put("at", it.getString("capturedAt")).put("id", it.getString("id")).toString().toByteArray())
        }
        JSONObject().put("items", org.json.JSONArray(items.map { display(it).apply { put("textPreview", optString("ocrText").take(160)); remove("ocrText") } }))
        .put("totalCount", matching.size).put("nextCursor", next ?: JSONObject.NULL)
        }
    }
    /** Album/grid paths never deserialize full capture records or OCR text. */
    fun albumPage(after: String, before: String, cursor: String? = null): JSONObject {
        prepareIndex(requireStatistics = false)
        return guarded {
            CaptureAlbums.page(browseRows(after, before), cursor)
        }
    }
    fun sessionPage(after: String, before: String, cursor: String? = null, sessionId: String? = null): JSONObject {
        prepareIndex(requireStatistics = false)
        return guarded {
            val rows = browseRows(after, before)
            if (sessionId == null) CaptureSessions.page(rows, cursor) else CaptureSessions.images(rows, sessionId, cursor)
        }
    }
    private fun browseRows(after: String, before: String): List<JSONObject> {
        val start = java.time.Instant.parse(after); val end = java.time.Instant.parse(before)
        require(start < end)
        return browseIndex().entries(browseFiles(), ::read).filter {
            val at = java.time.Instant.parse(it.getString("capturedAt"))
            it.optString("source") == "screen" && at >= start && at < end
        }
    }
    fun albumImages(after: String, before: String, appId: String, cursor: String? = null, limit: Int = 20): JSONObject {
        prepareIndex(requireStatistics = true)
        return guarded {
            require(limit in 1..60)
            val position = cursor?.let { JSONObject(String(Base64.getUrlDecoder().decode(it), Charsets.UTF_8)) }
            val at = position?.getString("at")?.let(java.time.Instant::parse); val id = position?.getString("id")
            val rows = browseRows(after, before).filter { it.optString("appId") == appId }
                .sortedWith(compareByDescending<JSONObject> { java.time.Instant.parse(it.getString("capturedAt")) }.thenByDescending { it.getString("id") })
            val page = rows.filter { at == null || java.time.Instant.parse(it.getString("capturedAt")) < at ||
                java.time.Instant.parse(it.getString("capturedAt")) == at && it.getString("id") < id!! }.take(limit + 1)
            val items = page.take(limit).map { row -> JSONObject().apply {
                for (key in listOf("id", "capturedAt", "source", "appId", "appName", "hasImage")) put(key, row.get(key))
                val hash = row.optString("blob")
                if (hash.matches(Regex("[a-f0-9]{64}"))) put("sizeBytes", File(dir, "$hash.blob").length())
            } }
            JSONObject().put("items", org.json.JSONArray(items)).put("totalCount", rows.size)
                .put("nextCursor", if (page.size > limit) Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject()
                    .put("at", items.last().getString("capturedAt")).put("id", items.last().getString("id")).toString().toByteArray()) else JSONObject.NULL)
        }
    }
    /** Encrypted derived thumbnail; the owning event remains authoritative for access/retention. */
    fun thumbnail(id: String): ByteArray? = guarded {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return@guarded null
        val hash = browseIndex().entry(file, ::read).optString("blob")
        if (!hash.matches(Regex("[a-f0-9]{64}"))) return@guarded null
        val thumbnail = File(dir, "$hash.thumb")
        if (thumbnail.exists()) runCatching { cipher.open(thumbnail.readBytes()) }.getOrNull() else null
    }
    fun cacheThumbnail(id: String, bytes: ByteArray, maxBytes: Long) = guarded {
        require(bytes.size <= 256 * 1024)
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return@guarded
        val hash = browseIndex().entry(file, ::read).optString("blob")
        if (!hash.matches(Regex("[a-f0-9]{64}"))) return@guarded
        val target = File(dir, "$hash.thumb")
        if (!target.exists() && capacityUpperBound() + bytes.size + 64 <= maxBytes) atomic(target, bytes)
    }
    fun summary(): JSONObject {
        prepareIndex()
        return guarded {
            val files = records(); var pages = 0; var screens = 0; var notes = 0; var activities = 0; var media = 0; var systemEvents = 0; var unreadable = 0
            val pending = org.json.JSONArray()
            files.take(100).forEach { file -> try {
                val body = read(file); val source = body.optString("source", "screen"); val id = UUID.fromString(body.getString("id")).toString()
                val at = java.time.Instant.parse(body.getString("capturedAt")).toString()
                when (source) { "ui_page" -> pages++; "screen" -> screens++; "note" -> notes++; "activity" -> activities++; "media" -> media++; "notification", "device_event" -> systemEvents++; else -> error("unknown") }
                pending.put(JSONObject().put("id", id).put("kind", source).put("createdAt", at).put("bytes", file.length())
                    .put("uploaded", body.optBoolean("_uploaded")).put("archiveMissing", body.optBoolean("_archiveMissing")))
            } catch (_: Exception) { unreadable++ } }
            JSONObject().put("total", files.size).put("pages", pages).put("screens", screens).put("notes", notes).put("activities", activities).put("media", media).put("systemEvents", systemEvents).put("unreadable", unreadable)
                .put("uninspected", (files.size - 100).coerceAtLeast(0)).put("bytes", diskBytes()).put("reservedOcrBytes", reservedOcrBytes()).put("pending", pending)
        }
    }
    fun verifyIntegrity() = guarded {
        val checked = mutableSetOf<String>()
        for (file in records()) {
            val event = read(file)
            check(file.nameWithoutExtension == UUID.fromString(event.getString("id")).toString()) { MoteI18n.text("记录 ID 与存储文件不匹配") }
            val hash = event.optString("_blob", "")
            if (hash.isEmpty()) { check(event.getString("source") in setOf("note", "activity", "media", "notification", "device_event", "ui_page")); continue }
            check(hash.matches(Regex("[a-f0-9]{64}"))) { MoteI18n.text("图片引用无效") }
            if (checked.add(hash)) {
                val blob = File(dir, "$hash.blob")
                check(blob.isFile && !java.nio.file.Files.isSymbolicLink(blob.toPath())) { MoteI18n.text("本机图片缺失，原副本已保留") }
                val actual = MessageDigest.getInstance("SHA-256").digest(cipher.open(blob.readBytes())).joinToString("") { "%02x".format(it) }
                check(hash == actual) { MoteI18n.text("本机图片校验失败，原副本已保留") }
            }
        }
    }
    /** Each authenticated legacy file is replaced atomically, independently of other files.
     * A failed read leaves the original untouched; mixed old/new libraries remain readable.
     */
    fun migrateLegacyContent(onProgress: (Int, Int) -> Unit = { _, _ -> }, shouldStop: () -> Boolean = { false }): Int {
        val codec = cipher as? LocalContentCipher ?: return 0
        var migrated = 0
        codec.withPlaintextWrites { withDeferredIndexWrites {
            val files = guarded { dir.listFiles()?.filter { it.extension in setOf("event", "blob", "thumb") || it.name.startsWith(".browse-v1-") } ?: error(MoteI18n.text("无法读取本机存储目录")) }
            for ((position, file) in files.withIndex()) {
                if (shouldStop()) break
                guarded {
                    if (file.exists()) {
                        val original = file.readBytes()
                        if (codec.isLegacy(original)) {
                            val decoded = codec.open(original)
                            when (file.extension) {
                                "event" -> {
                                    val event = JSONObject(String(decoded, Charsets.UTF_8))
                                    check(event.getString("id") == file.nameWithoutExtension)
                                    java.time.Instant.parse(event.getString("capturedAt"))
                                }
                                "blob" -> check(MessageDigest.getInstance("SHA-256").digest(decoded).joinToString("") { "%02x".format(it) } == file.nameWithoutExtension) { MoteI18n.text("图片校验失败，原文件已保留") }
                            }
                            atomic(file, decoded, file.lastModified())
                            migrated++
                        }
                    }
                }
                onProgress(position + 1, files.size)
            }
        } }
        return migrated
    }
    fun recoverOrphans() {
        // Legacy metadata upgrades release the lock between small chunks. Final reconciliation
        // and unlinking share the lock so a newly committed capture can never lose its blob.
        prepareIndex()
        guarded {
            val referenced = browseIndex().entries(browseFiles(), ::read).map { it.optString("blob") }.toSet()
            dir.listFiles()?.filter { it.extension == "tmp" || (it.extension in setOf("blob", "thumb") && it.nameWithoutExtension !in referenced) }
                ?.forEach { if (it.delete()) onMutation?.invoke(false) }
        }
    }
}
