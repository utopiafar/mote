package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

data class LocalSource(
    val id: String = "android-${UUID.randomUUID()}", val name: String, val kind: String,
    val retention: String = "snapshot", val enabled: Boolean = true,
    val calendarId: Long? = null, val uri: String? = null, val tree: Boolean = false,
    val extensions: String = "md,txt,json,csv,ics", val excluded: String = "",
    val daysBefore: Int = 30, val daysAfter: Int = 90, val intervalMinutes: Int = 60, val initialSync: String = "all"
) {
    fun validate() {
        require(id.matches(Regex("[A-Za-z0-9_.:-]{1,128}")) && name.isNotBlank() && name.length <= 200) { "检查来源名称" }
        require(kind in setOf("local-calendar", "local-files") && retention in setOf("snapshot", "reference", "archive") && initialSync in setOf("all", "new_only") && (kind == "local-files" || retention != "archive"))
        require(daysBefore in 0..365 && daysAfter in 1..365 && intervalMinutes in 15..1440) { "窗口为过去 0–365 天、未来 1–365 天，间隔 15–1440 分钟" }
        if (kind == "local-calendar") require(calendarId != null && calendarId >= 0)
        else require(uri != null && uri.startsWith("content://") && !uri.contains('?') && !uri.contains('#')) { "需要系统选择器提供的持久文件权限" }
        SourceRules.extensions(extensions); SourceRules.patterns(excluded)
    }
    fun json() = JSONObject().put("id", id).put("name", name).put("kind", kind).put("retention", retention).put("enabled", enabled)
        .put("calendarId", calendarId).put("uri", uri).put("tree", tree).put("extensions", extensions).put("excluded", excluded)
        .put("initialSync", initialSync).put("daysBefore", daysBefore).put("daysAfter", daysAfter).put("intervalMinutes", intervalMinutes)
    fun registration(deviceId: String) = JSONObject().put("id", id).put("name", name).put("kind", kind).put("deviceId", deviceId)
        .put("platform", "android").put("initialSync", initialSync).put("retention", retention).put("enabled", true)
    companion object {
        fun from(v: JSONObject) = LocalSource(v.getString("id"), v.getString("name"), v.getString("kind"), v.getString("retention"), v.getBoolean("enabled"),
            if (v.has("calendarId")) v.getLong("calendarId") else null, if (v.has("uri")) v.getString("uri") else null,
            v.optBoolean("tree"), v.optString("extensions", "md,txt,json,csv,ics"), v.optString("excluded", ""),
            v.optInt("daysBefore", 30), v.optInt("daysAfter", 90), v.optInt("intervalMinutes", 60), v.optString("initialSync", "all")).also { it.validate() }
    }
}

/** Literal path patterns with only '*' wildcard; includes newlines and avoids regex backtracking. */
class SourcePathPattern(private val pattern: String) {
    fun matches(value: String): Boolean {
        var offset = 0; var p = 0; var star = -1; var retry = 0
        while (offset < value.length) {
            when {
                p < pattern.length && pattern[p] == '*' -> { star = p++; retry = offset }
                p < pattern.length && pattern[p] == value[offset] -> { p++; offset++ }
                star >= 0 -> { p = star + 1; offset = ++retry }
                else -> return false
            }
        }
        while (p < pattern.length && pattern[p] == '*') p++
        return p == pattern.length
    }
}

object SourceRules {
    const val FILE_BYTES = 100 * 1024
    const val SCAN_ITEMS = 200
    const val SCAN_BYTES = 4 * 1024 * 1024
    fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    fun target(server: String, token: String) = hash(server.trim().trimEnd('/') + "\u0000" + token)
    fun extensions(value: String): Set<String> = value.split(',').map { it.trim().lowercase() }.filter { it.isNotBlank() }.toSet().also {
        require(it.isNotEmpty() && it.size <= 20 && it.all { v -> v.matches(Regex("[a-z0-9]{1,12}")) }) { "扩展名使用逗号分隔，如 md,txt,json,csv,ics" }
    }
    fun patterns(value: String): List<SourcePathPattern> = value.lines().filter { it.isNotBlank() }.also {
        require(it.size <= 40 && it.all { v -> v.length <= 200 }) { "排除路径最多 40 行，每行 200 字符" }
    }.map { SourcePathPattern(it) }
    fun include(path: String, source: LocalSource): Boolean = path.substringAfterLast('.', "").lowercase() in extensions(source.extensions) && patterns(source.excluded).none { it.matches(path) }
    fun utf8(bytes: ByteArray): String {
        require(bytes.size <= FILE_BYTES) { "文件超过 100 KiB" }
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        require(!text.contains('\u0000') && text.length <= 100000) { "只支持 UTF-8 文本，最多 100000 字符" }
        return text.removePrefix("\uFEFF")
    }
    fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    fun validAck(sourceId: String, body: JSONObject, ack: JSONObject?): Boolean = ack != null &&
        ack.optString("sourceId") == sourceId && ack.optString("externalId") == body.optString("externalId") &&
        ack.optString("revision") == body.optString("revision") && ack.opt("duplicate") is Boolean &&
        runCatching { UUID.fromString(ack.getString("id")) }.isSuccess
    fun contentHash(body: JSONObject): String = hash(canonical(JSONObject(body.toString()).apply { remove("observedAt"); remove("revision") }))
    fun withinWindow(body: JSONObject, from: Long?, until: Long?): Boolean {
        if (from == null || until == null) return true
        val calendar = body.optJSONObject("calendar") ?: return false
        return Instant.parse(calendar.getString("start")).toEpochMilli() < until && Instant.parse(calendar.getString("end")).toEpochMilli() >= from
    }
}

data class SourceScan(val items: List<JSONObject>, val complete: Boolean, val observedAt: String, val from: Long? = null, val until: Long? = null, val skipped: Int = 0)

/** Local snapshots plus immutable pending revisions. State changes are atomic and ACKs target-specific. */
class LocalSourceStore(private val directory: File, private val cipher: ByteCipher) {
    internal var onMutation: (() -> Unit)? = null
    init { directory.mkdirs() }
    fun migrateLegacyContent(shouldStop: () -> Boolean = { false }, onProgress: (Int, Int) -> Unit = { _, _ -> }): Int {
        val files = synchronized(lock) { directory.listFiles()?.filter { it.extension == "enc" }.orEmpty() }
        var changed = 0
        for ((index, file) in files.withIndex()) {
            if (shouldStop()) break
            synchronized(lock) { if (LocalContentMigration.migrate(file, cipher) { JSONObject(String(it, Charsets.UTF_8)) }) { changed++; onMutation?.invoke() } }
            onProgress(index + 1, files.size)
        }
        return changed
    }
    fun sources(): List<LocalSource> = synchronized(lock) {
        val array = read(File(directory, "config.enc")).optJSONArray("sources") ?: JSONArray()
        (0 until array.length()).map { LocalSource.from(array.getJSONObject(it)) }
    }
    fun save(source: LocalSource) = synchronized(lock) {
        source.validate(); val all = sources().toMutableList(); val old = all.find { it.id == source.id }
        require(old != null || all.size < 20) { "最多连接 20 个来源" }
        // Explicit selection/filter/retention edits discard old unsent material before the new scan.
        if (old != null && old.copy(enabled = source.enabled, intervalMinutes = source.intervalMinutes, name = source.name, initialSync = source.initialSync).json().toString() != source.json().toString()) file(source.id).delete()
        if (old == null || old.name != source.name || old.initialSync != source.initialSync) {
            val state = state(source.id); state.put("registered", false)
            if (!state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            write(file(source.id), state)
        }
        all.removeAll { it.id == source.id }; all.add(source)
        write(File(directory, "config.enc"), JSONObject().put("sources", JSONArray(all.map { it.json() })))
    }
    fun remove(id: String) = synchronized(lock) {
        write(File(directory, "config.enc"), JSONObject().put("sources", JSONArray(sources().filterNot { it.id == id }.map { it.json() })))
        file(id).delete()
    }
    fun state(id: String): JSONObject = synchronized(lock) { read(file(id)) }
    fun status(id: String, code: String, at: String = Instant.now().toString()) = synchronized(lock) {
        if (sources().none { it.id == id }) return@synchronized
        require(code in setOf("ready", "scanned", "partial", "synced", "offline", "permission", "paused", "configuration", "storage", "provider", "http", "ack"))
        val state = state(id); state.put("status", code).put("statusAt", at); write(file(id), state)
    }
    fun pendingSync(): PendingSync = synchronized(lock) {
        var count = 0; var updates = 0; var oldest: Long? = null
        sources().forEach { source ->
            val state = state(source.id)
            val size = state.optJSONArray("pending")?.length() ?: 0
            val metadata = source.enabled && !state.optBoolean("registered")
            if (size > 0 || metadata) { count += size; if (metadata) updates++; val at = state.optLong("pendingSince", file(source.id).lastModified().takeIf { it > 0 } ?: File(directory, "config.enc").lastModified()); oldest = oldest?.let { minOf(it, at) } ?: at }
        }; PendingSync(count, oldest, updates)
    }
    /** Explicit full replay of retained versions; paused sources and their privacy choices stay untouched. */
    fun requeueRetained(maxBytes: Long = 64L * 1024 * 1024): Int = synchronized(lock) {
        var count = 0
        for (source in sources().filter { it.enabled }) {
            val state = state(source.id)
            val pending = state.optJSONArray("pending") ?: JSONArray()
            val keys = (0 until pending.length()).map { identity(pending.getJSONObject(it)) }.toMutableSet()
            val current = state.optJSONObject("current") ?: JSONObject()
            for (key in current.keys()) {
                val body = current.getJSONObject(key).getJSONObject("body")
                if (keys.add(identity(body))) pending.put(body)
            }
            check(pending.length() <= 4096) { "来源队列已满，请先同步后重试全量上传" }
            state.put("pending", pending).put("registered", false)
            if (!state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            val bytes = cipher.seal(state.toString().toByteArray(Charsets.UTF_8))
            val other = directory.listFiles()?.filter { it != file(source.id) }?.sumOf { it.length() } ?: 0L
            check(bytes.size + other <= maxBytes) { "来源补传缓存达到上限，请先同步待发版本后重试" }
            writeBytes(file(source.id), bytes); count += pending.length()
        }; count
    }
    fun resetSyncedSnapshots() = synchronized(lock) {
        val all = sources(); check(all.all { (state(it.id).optJSONArray("pending")?.length() ?: 0) == 0 })
        all.forEach { if (file(it.id).exists()) { check(file(it.id).delete()); onMutation?.invoke() } }
    }
    fun selectTarget(id: String, target: String) = synchronized(lock) {
        val state = state(id)
        if (state.optString("target") != target) {
            state.put("target", target).put("registered", false)
            val pending = state.optJSONArray("pending") ?: JSONArray(); val current = state.optJSONObject("current") ?: JSONObject()
            val keys = (0 until pending.length()).map { identity(pending.getJSONObject(it)) }.toMutableSet()
            for (key in current.keys()) { val body = current.getJSONObject(key).getJSONObject("body"); if (keys.add(identity(body))) pending.put(body) }
            if (pending.length() > 0 && !state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            state.put("pending", pending); write(file(id), state)
        }
    }
    fun registered(id: String, target: String) = synchronized(lock) {
        val state = state(id); check(state.optString("target") == target); state.put("registered", true)
        if ((state.optJSONArray("pending")?.length() ?: 0) == 0) state.remove("pendingSince")
        write(file(id), state)
    }
    fun scan(source: LocalSource, result: SourceScan, maxBytes: Long = 64L * 1024 * 1024) = synchronized(lock) {
        val active = sources().find { it.id == source.id } ?: return@synchronized
        if (!active.enabled || active != source) return@synchronized
        val state = state(source.id); val current = state.optJSONObject("current") ?: JSONObject(); val pending = state.optJSONArray("pending") ?: JSONArray()
        val baseline = state.optJSONArray("baseline") ?: JSONArray()
        if (source.initialSync == "new_only" && !state.optBoolean("initialized") && current.length() == 0) {
            val ids = (0 until baseline.length()).map { baseline.getString(it) }.toMutableSet()
            result.items.forEach { ids.add(it.getString("externalId")) }
            state.put("baseline", JSONArray(ids.toList())).put("initialized", result.complete).put("scanComplete", result.complete).put("lastScan", result.observedAt)
            check(state.toString().toByteArray().size <= maxBytes) { "首次同步清单达到缓存上限" }
            write(file(source.id), state); return@synchronized
        }
        val ignored = if (source.initialSync == "new_only") (0 until baseline.length()).map { baseline.getString(it) }.toSet() else emptySet()
        if (source.initialSync == "all") state.remove("baseline")
        if (result.complete) state.put("initialized", true)

        val seen = mutableSetOf<String>()
        fun accept(input: JSONObject) {
            val body = JSONObject(input.toString()); val external = body.getString("externalId"); require(external.length <= 1000)
            val hash = SourceRules.contentHash(body); val previous = current.optJSONObject(external)
            if (previous?.optString("hash") == hash) return
            // The predecessor distinguishes deletion/restoration with identical original content.
            body.put("revision", SourceRules.hash(hash + ":" + (previous?.getJSONObject("body")?.optString("revision") ?: "")))
            pending.put(body); current.put(external, JSONObject().put("hash", hash).put("body", body))
        }
        result.items.forEach { body -> seen.add(body.getString("externalId")); if (body.getString("externalId") !in ignored) accept(body) }
        if (result.complete) for (external in current.keys().asSequence().toList()) {
            val previous = current.getJSONObject(external).getJSONObject("body")
            if (external !in seen && !previous.optBoolean("deleted") && SourceRules.withinWindow(previous, result.from, result.until)) {
                val deleted = JSONObject().put("externalId", external).put("observedAt", result.observedAt).put("title", "").put("text", "")
                    .put("kind", previous.getString("kind")).put("layer", previous.getString("layer")).put("deleted", true)
                if (previous.getString("kind") == "file") {
                    val known = previous.optJSONObject("metadata")?.optJSONObject("file")?.let { JSONObject(it.toString()) } ?: JSONObject()
                    known.put("deletionObservedAt", result.observedAt)
                    deleted.put("metadata", JSONObject().put("version", 1).put("file", known))
                    if (previous.has("modifiedAt")) deleted.put("modifiedAt", previous.getString("modifiedAt"))
                }
                accept(deleted)
            }
        }
        check(pending.length() <= 4096) { "来源队列已满，请先同步" }
        if (pending.length() > 0 && !state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
        state.put("current", current).put("pending", pending).put("lastScan", result.observedAt).put("status", if (result.complete) "scanned" else "partial").put("skipped", result.skipped).put("scanComplete", result.complete)
        val bytes = cipher.seal(state.toString().toByteArray(Charsets.UTF_8))
        val other = directory.listFiles()?.filter { it != file(source.id) }?.sumOf { it.length() } ?: 0L
        check(bytes.size + other <= maxBytes) { "来源缓存达到上限，请先同步或减少选择" }
        writeBytes(file(source.id), bytes)
    }
    fun next(id: String, target: String): JSONObject? = synchronized(lock) {
        val state = state(id); if (state.optString("target") != target) return@synchronized null
        state.optJSONArray("pending")?.takeIf { it.length() > 0 }?.getJSONObject(0)
    }
    fun acknowledge(id: String, target: String, externalId: String, revision: String) = synchronized(lock) {
        val state = state(id); if (state.optString("target") != target) return@synchronized
        val old = state.optJSONArray("pending") ?: JSONArray(); val next = JSONArray()
        for (i in 0 until old.length()) { val value = old.getJSONObject(i); if (value.getString("externalId") != externalId || value.getString("revision") != revision) next.put(value) }
        if (next.length() == 0) state.remove("pendingSince")
        state.put("pending", next); write(file(id), state)
    }
    private fun identity(value: JSONObject) = value.getString("externalId") + "\u0000" + value.getString("revision")
    private fun file(id: String): File { require(id.matches(Regex("[A-Za-z0-9_.:-]{1,128}"))); return File(directory, "source-$id.enc") }
    private fun read(file: File) = if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else JSONObject()
    private fun write(file: File, body: JSONObject) = writeBytes(file, cipher.seal(body.toString().toByteArray(Charsets.UTF_8)))
    private fun writeBytes(file: File, bytes: ByteArray) {
        val temp = File(directory, "${UUID.randomUUID()}.tmp")
        try { FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }; check(temp.renameTo(file)) { "无法保存来源状态" }; onMutation?.invoke() } finally { temp.delete() }
    }
    companion object { private val lock = Any() }
}
