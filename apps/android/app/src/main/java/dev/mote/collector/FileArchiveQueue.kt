package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Local per-file journal. A pending manifest and its bytes never change during retry. */
class FileArchiveQueue(private val directory: File, private val cipher: ByteCipher, private val processors: LocalFileProcessors = LocalFileProcessors.default) {
    companion object { const val PART_BYTES = 4 * 1024 * 1024; const val MAX_BYTES = 512L * 1024 * 1024; private val lock = Any() }
    init { directory.mkdirs() }
    private fun root(id: String): File { require(id.matches(Regex("[A-Za-z0-9_.:-]{1,128}"))); return File(directory, id).apply { mkdirs() } }
    private fun stateFile(id: String) = File(root(id), "state.enc")
    private fun itemFile(id: String, external: String) = File(root(id), "item-${SourceRules.hash(external)}.enc")
    private fun read(file: File) = if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else JSONObject()
    private fun write(file: File, value: JSONObject) {
        val temp = File(file.parentFile, UUID.randomUUID().toString() + ".tmp")
        try { FileOutputStream(temp).use { it.write(cipher.seal(value.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }; check(temp.renameTo(file)) } finally { temp.delete() }
    }
    fun state(id: String): JSONObject = synchronized(lock) {
        val file = stateFile(id)
        if (!file.exists()) return@synchronized JSONObject().put("transportQueueVersion", LocalDataFormat.VERSION)
        read(file).also { check(it.has("transportQueueVersion") && it.getInt("transportQueueVersion") == LocalDataFormat.VERSION) { MoteI18n.text(LocalDataFormat.RESET_MESSAGE) } }
    }
    fun saveState(id: String, state: JSONObject) = synchronized(lock) { check(!state.has("transportQueueVersion") || state.getInt("transportQueueVersion") == LocalDataFormat.VERSION); write(stateFile(id), state.put("transportQueueVersion", LocalDataFormat.VERSION)) }
    fun candidate(id: String, external: String): JSONObject? = synchronized(lock) { read(itemFile(id, external)).optJSONObject("candidate") }
    fun rows(id: String): List<JSONObject> = synchronized(lock) { root(id).listFiles()?.filter { it.name.startsWith("item-") && it.name.endsWith(".enc") }?.map { read(it) } ?: emptyList() }
    // Processing waits are not transport work. A completed local result is a new immutable revision.
    private fun dirty(row: JSONObject) = row.has("pending") || row.has("indexResult") || (!row.optBoolean("baseline") && row.optString("signature") != signature(row.getJSONObject("candidate")))
    private fun markers(id: String) = root(id).listFiles()?.filter { it.name.matches(Regex("todo-[a-f0-9]{64}")) } ?: emptyList()
    private fun mark(id: String, row: JSONObject) {
        val marker = File(root(id), "todo-" + SourceRules.hash(row.getJSONObject("candidate").getString("externalId")))
        if (dirty(row)) { if (!marker.exists()) FileOutputStream(marker).use { it.fd.sync() } } else marker.delete()
    }
    fun saveRow(id: String, row: JSONObject) = synchronized(lock) {
        val external = row.getJSONObject("candidate").getString("externalId"); val state = state(id); val key = SourceRules.hash(external)
        // The marker precedes the journal write; a crash may leave extra work, never conceal pending bytes.
        if (dirty(row)) mark(id, row)
        if (row.has("pending")) { state.put("activeKey", key); saveState(id, state) }
        write(itemFile(id, external), row)
        if (!dirty(row)) mark(id, row)
        if (!row.has("pending") && state.optString("activeKey") == key) { state.remove("activeKey"); saveState(id, state) }
    }
    private fun allowed(source: LocalSource, item: JSONObject): Boolean {
        val path = item.optString("_relativePath", item.optString("title"))
        val parts = path.split('/')
        return SourceRules.include(path, source) && parts.indices.none { index ->
            SourceRules.patterns(source.excluded).any { it.matches(parts.take(index + 1).joinToString("/")) }
        }
    }
    private fun discard(id: String, row: JSONObject) {
        val external = row.getJSONObject("candidate").getString("externalId")
        itemFile(id, external).delete()
        File(root(id), "todo-" + SourceRules.hash(external)).delete()
        if (row.has("pending")) File(root(id), "spool").deleteRecursively()
    }
    fun assertCurrent(source: LocalSource, row: JSONObject) = synchronized(lock) {
        check(allowed(source, row.getJSONObject("candidate"))) { "File excluded by current source policy" }
        val current = read(itemFile(source.id, row.getJSONObject("candidate").getString("externalId")))
        check(current.optJSONObject("pending")?.toString() == row.optJSONObject("pending")?.toString() && current.has("pending")) { "File policy or pending revision changed" }
    }
    fun configure(source: LocalSource): JSONObject = synchronized(lock) {
        state(source.id)
        val state = state(source.id)
        val policy = SourceRules.hash(listOf(source.uri, source.tree, source.maxFileMiB, source.extensions, source.excluded, source.retention, source.lightweightIndex, source.allowRead).joinToString("\u0000"))
        if (state.optString("policy") != policy) {
            rows(source.id).forEach { row ->
                // An exclusion edit must not turn old new-only baseline files into uploads.
                if (row.optBoolean("baseline") && allowed(source, row.getJSONObject("candidate"))) {
                    row.remove("pending"); row.remove("indexPending"); row.remove("indexResult"); saveRow(source.id, row)
                } else discard(source.id, row)
            }
            state.remove("activeKey")
            File(root(source.id), "spool").deleteRecursively()
            state.put("policy", policy).remove("stack"); state.put("generation", UUID.randomUUID().toString())
        }
        if (source.initialSync == "all" && state.optString("initialSync") == "new_only") rows(source.id).filter { it.optBoolean("baseline") }.forEach { it.put("baseline", false); saveRow(source.id, it) }
        if (!state.has("generation")) state.put("generation", UUID.randomUUID().toString())
        state.put("initialSync", source.initialSync); saveState(source.id, state); state
    }
    fun signature(item: JSONObject) = SourceRules.hash(SourceRules.canonical(JSONObject(item.toString()).apply { remove("observedAt"); remove("revision") }))
    fun observe(source: LocalSource, item: JSONObject, generation: String, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        require(allowed(source, item)) { "File excluded by current source policy" }
        SourcePrivacyGate.validate(source, item)
        val path = itemFile(source.id, item.getString("externalId")); val row = read(path)
        if (!path.exists()) check((root(source.id).listFiles()?.count { it.name.startsWith("item-") } ?: 0) < 50000) { MoteI18n.text("文件清单达到 50000 项上限，请缩小目录") }
        if (row.optJSONObject("candidate")?.let { signature(it) } != signature(item)) {
            row.put("stableSince", now).put("indexPending", false); row.remove("indexResult"); row.remove("nextProcessingAt"); row.remove("nextPrepareAt")
        }
        row.put("candidate", item).put("seen", generation)
        if (source.initialSync == "new_only" && !state(source.id).optBoolean("initialized")) row.put("baseline", true)
        saveRow(source.id, row)
    }
    fun finish(source: LocalSource, generation: String, absent: (String) -> Boolean) = synchronized(lock) {
        rows(source.id).filter { it.optString("seen") != generation && !it.optBoolean("baseline") }.forEach { row ->
            val item = row.getJSONObject("candidate")
            if (!item.optBoolean("deleted") && absent(item.getString("externalId"))) {
                item.put("deleted", true).put("observedAt", Instant.now().toString())
                row.put("candidate", item).put("indexPending", false); row.remove("indexResult"); saveRow(source.id, row)
            }
        }
        val state = state(source.id).put("initialized", true).put("scanComplete", true).put("lastScan", Instant.now().toString()).put("generation", UUID.randomUUID().toString())
        state.remove("stack"); saveState(source.id, state)
    }
    fun pendingPage(id: String, offset: Int, limit: Int = 30): JSONObject = synchronized(lock) {
        require(offset >= 0 && limit in 1..60); state(id)
        val all = markers(id).sortedBy { it.name }
        val items = all.drop(offset).take(limit).map { marker ->
            val row = read(File(root(id), "item-${marker.name.removePrefix("todo-")}.enc"))
            val item = row.optJSONObject("candidate") ?: JSONObject()
            JSONObject().put("name", item.optString("title", item.optString("externalId")))
                .put("size", item.optLong("size")).put("status", if (row.has("pending")) MoteI18n.text("等待上传 / 续传") else MoteI18n.text("等待准备"))
        }
        JSONObject().put("total", all.size).put("items", JSONArray(items))
    }
    fun pendingCount(id: String): Int = synchronized(lock) { state(id); markers(id).size }
    fun processingCount(id: String): Int = synchronized(lock) { rows(id).count { it.optBoolean("indexPending") && !it.getJSONObject("candidate").optBoolean("deleted") } }
    fun processingReady(id: String, now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
        rows(id).any { it.optBoolean("indexPending") && !it.has("indexResult") && !it.has("pending") && !it.getJSONObject("candidate").optBoolean("deleted") && now >= it.optLong("nextProcessingAt") && it.optString("signature") == signature(it.getJSONObject("candidate")) }
    }
    fun transportReady(id: String, now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
        state(id); rows(id).any { dirty(it) && now >= it.optLong("nextPrepareAt") && (it.has("pending") || it.getJSONObject("candidate").optString("layer") == "reference" || it.getJSONObject("candidate").optBoolean("deleted") || now - it.optLong("stableSince", now) >= 60000) }
    }
    /** Read/parse outside the journal lock: upload and other sources keep making progress. */
    fun processOne(source: LocalSource, open: (JSONObject) -> InputStream, unchanged: (JSONObject) -> Boolean,
                   selected: () -> Boolean = { true }, now: Long = System.currentTimeMillis(),
                   index: ((JSONObject, ByteArray, LocalSource) -> Unit)? = null): Boolean {
        if (source.retention != "snapshot" || !source.enabled) return false
        val job = synchronized(lock) {
            configure(source)
            rows(source.id).firstOrNull { it.optBoolean("indexPending") && !it.has("indexResult") && !it.has("pending") && !it.getJSONObject("candidate").optBoolean("deleted") && it.optString("signature") == signature(it.getJSONObject("candidate")) && now >= it.optLong("nextProcessingAt") }
                ?.let { row ->
                    // Legacy index waits pin the existing decoder once; upgrades never rewrite pending wire payloads.
                    if (!row.has("processor")) { row.put("processor", JSONObject().put("id", "local-file").put("version", 1)); saveRow(source.id, row) }
                    JSONObject(row.toString())
                }
        } ?: return false
        val candidate = job.getJSONObject("candidate"); val inputSignature = signature(candidate); val policy = state(source.id).getString("policy")
        val result = JSONObject(candidate.toString()).apply { remove("_relativePath") }
        val success = runCatching {
            check(selected() && unchanged(candidate)); val bytes = open(candidate).use { LocalFileIndex.bytes(it) }
            check(selected() && unchanged(candidate))
            if (index != null) index(result, bytes, source) else processors.get(job.getJSONObject("processor").getString("id"), job.getJSONObject("processor").getInt("version")).index(result, bytes, source)
            result.getJSONObject("document").getJSONObject("fileIndex").optString("status") != "pending"
        }.getOrDefault(false)
        synchronized(lock) {
            val current = read(itemFile(source.id, candidate.getString("externalId")))
            if (!selected() || state(source.id).optString("policy") != policy || current.optJSONObject("candidate")?.let { signature(it) } != inputSignature || !current.optBoolean("indexPending")) return true
            if (success) { SourcePrivacyGate.validate(source, result); current.put("indexResult", result).put("indexPending", false); current.remove("nextProcessingAt") }
            else current.put("nextProcessingAt", now + 300000)
            saveRow(source.id, current)
        }
        return true
    }
    fun pendingSync(): PendingSync = synchronized(lock) {
        var count = 0; var oldest: Long? = null
        directory.listFiles()?.filter { it.isDirectory }?.forEach { dir -> val n = pendingCount(dir.name); count += n; if (n > 0) oldest = minOf(oldest ?: Long.MAX_VALUE, dir.lastModified()) }
        PendingSync(count, oldest)
    }
    fun next(id: String): JSONObject? = synchronized(lock) {
        state(id); val state = state(id); val key = state.optString("activeKey")
        if (!key.matches(Regex("[a-f0-9]{64}"))) return@synchronized null
        val row = read(File(root(id), "item-$key.enc"))
        if (row.has("pending")) row else { state.remove("activeKey"); saveState(id, state); null }
    }
    /** Open is called only for archive bytes, after stability and baseline checks. */
    fun prepare(source: LocalSource, open: (JSONObject) -> InputStream, unchanged: (JSONObject) -> Boolean, now: Long = System.currentTimeMillis(), anchor: ((String) -> String?)? = null): JSONObject? = synchronized(lock) {
        configure(source)
        next(source.id)?.let { assertCurrent(source, it); return@synchronized it }
        val row = markers(source.id).asSequence().mapNotNull { marker ->
            val file = File(root(source.id), "item-${marker.name.removePrefix("todo-")}.enc")
            if (!file.exists()) { marker.delete(); null } else read(file).let { row ->
                if (!allowed(source, row.getJSONObject("candidate"))) { discard(source.id, row); null }
                else row.also { if (!dirty(it)) marker.delete() }
            }
        }.firstOrNull { dirty(it) && now >= it.optLong("nextPrepareAt") && (source.retention == "reference" || it.getJSONObject("candidate").optBoolean("deleted") || now - it.optLong("stableSince", now) >= 60000) } ?: return@synchronized null
        if (!row.has("revision") && anchor != null) anchor(row.getJSONObject("candidate").getString("externalId"))?.let { row.put("revision", it); saveRow(source.id, row) }
        val candidate = row.getJSONObject("candidate"); val item = JSONObject(candidate.toString()).apply { remove("_relativePath") }; SourcePrivacyGate.validate(source, item); val spool = File(root(source.id), "spool")
        spool.deleteRecursively(); spool.mkdirs()
        var size = candidate.optJSONObject("metadata")?.optJSONObject("file")?.optLong("sizeBytes", 0) ?: 0L
        var hash: String? = null
        try {
            if (source.retention == "archive" && !item.optBoolean("deleted")) {
                check(unchanged(candidate)) { MoteI18n.text("文件正在变化，稍后重新扫描") }
                val digest = MessageDigest.getInstance("SHA-256"); size = 0; var part = 0
                open(candidate).use { input ->
                    while (true) {
                        val buffer = ByteArray(PART_BYTES); var length = 0
                        while (length < buffer.size) { val n = input.read(buffer, length, buffer.size - length); if (n < 0) break; if (n == 0) continue; length += n }
                        if (length == 0) break
                        size += length; check(size <= minOf(MAX_BYTES, source.maxFileMiB * 1024L * 1024)) { MoteI18n.text("文件超过此来源的大小上限") }
                        val used = directory.walkTopDown().filter { it.isFile }.sumOf { it.length() }
                        check(used + length + 64 < 1024L * 1024 * 1024) { MoteI18n.text("文件暂存达到 1 GiB 上限") }
                        val bytes = buffer.copyOf(length); digest.update(bytes)
                        FileOutputStream(File(spool, part.toString())).use { it.write(cipher.seal(bytes)); it.fd.sync() }; part++
                    }
                }
                check(unchanged(candidate)) { MoteI18n.text("复制期间文件已变化，保留原文件并稍后重试") }
                hash = digest.digest().joinToString("") { "%02x".format(it) }
            }
            if (source.retention == "snapshot" && !item.optBoolean("deleted")) {
                val result = row.optJSONObject("indexResult")
                if (result != null) { for (key in listOf("text", "document")) item.put(key, result.get(key)) }
                else LocalFileIndex.pending(item, signature(candidate), source)
            }
            if (item.optBoolean("deleted") && item.optString("layer") == "snapshot") item.put("layer", "reference")
            SourcePrivacyGate.validate(source, item)
            val manifest = JSONObject().put("sourceId", source.id).put("previousRevision", row.optString("revision").takeIf { it.isNotBlank() } ?: JSONObject.NULL)
                .put("item", item).put("relativePath", candidate.optString("_relativePath", item.optString("title"))).put("sizeBytes", size)
            hash?.let { manifest.put("sha256", it) }
            item.put("revision", SourceRules.hash(SourceRules.canonical(manifest)))
            row.put("pending", JSONObject().put("manifest", manifest).put("signature", signature(candidate)).apply { row.optJSONObject("indexResult")?.let { put("indexResult", it.toString()) } })
            row.remove("nextPrepareAt")
            saveRow(source.id, row); row
        } catch (error: Exception) { spool.deleteRecursively(); row.put("nextPrepareAt", now + 60000); saveRow(source.id, row); throw error }
    }
    fun part(id: String, part: Int): ByteArray = synchronized(lock) { require(part >= 0); cipher.open(File(File(root(id), "spool"), part.toString()).readBytes()) }
    fun acknowledge(id: String, row: JSONObject, ack: JSONObject) = synchronized(lock) {
        val pending = row.getJSONObject("pending"); val manifest = pending.getJSONObject("manifest"); val item = manifest.getJSONObject("item")
        check(IngressV2Protocol.validFile(id, item, ack)) { MoteI18n.text("中央归档确认不匹配") }
        if (manifest.has("sha256")) check(ack.optString("sha256") == manifest.getString("sha256") && ack.optLong("sizeBytes", -1) == manifest.getLong("sizeBytes")) { MoteI18n.text("中央原件校验确认不匹配") }
        val current = read(itemFile(id, item.getString("externalId")))
        check(current.optJSONObject("pending")?.getJSONObject("manifest")?.getJSONObject("item")?.getString("revision") == item.getString("revision"))
        if (pending.optString("indexResult").isNotEmpty() && pending.optString("indexResult") == current.optJSONObject("indexResult")?.toString()) current.remove("indexResult")
        if (pending.getString("signature") == signature(current.getJSONObject("candidate")))
            current.put("indexPending", !current.has("indexResult") && item.optJSONObject("document")?.optJSONObject("fileIndex")?.optString("status") == "pending")
        current.put("signature", pending.getString("signature")).put("revision", item.getString("revision")).remove("pending")
        saveRow(id, current); saveState(id, state(id).put("lastAcknowledgedAt", Instant.now().toString())); File(root(id), "spool").deleteRecursively()
    }
    fun resetSynced() = synchronized(lock) { check(pendingSync().count == 0); directory.listFiles()?.filter { it.isDirectory }?.forEach { it.deleteRecursively() }; Unit }
    fun remove(id: String) = synchronized(lock) { root(id).deleteRecursively() }
}
