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
    val retention: String = if (kind == "local-files") "archive" else "snapshot", val enabled: Boolean = true,
    val calendarId: Long? = null, val uri: String? = null, val tree: Boolean = false,
    val extensions: String = "md,txt,json,csv,ics", val excluded: String = "",
    val daysBefore: Int = 30, val daysAfter: Int = 90, val intervalMinutes: Int = 60, val initialSync: String = "all", val maxFileMiB: Int = 0, val allowRead: Boolean = false,
    val centralProcessingConsent: Boolean = false, val syncContinuously: Boolean = true,
    val description: String = "", val contextVersion: Int = 0, val contextDirty: Boolean = false, val contextTarget: String = ""
) {
    fun validate() {
        require(id.matches(Regex("[A-Za-z0-9_.:-]{1,128}")) && name.isNotBlank() && name.length <= 200) { MoteI18n.text("检查来源名称") }
        require(kind.matches(Regex("[a-z][a-z0-9-]{0,63}(?:\\.[a-z][a-z0-9-]{0,63})*")) && retention in setOf("snapshot", "reference", "archive") && initialSync in setOf("all", "new_only"))
        require(daysBefore in 0..365 && daysAfter in 1..365 && intervalMinutes in 15..1440) { MoteI18n.text("窗口为过去 0–365 天、未来 1–365 天，间隔 15–1440 分钟") }
        SourceAdapters.default.forKind(kind).validateConfiguration(this)
        require(!tree || syncContinuously) { "Folder sources must sync continuously" }
        require(syncContinuously || initialSync == "all") { "One-time file imports require the selected file" }
        require(maxFileMiB >= 0)
        require(description.length <= 12000 && contextVersion >= 0) { MoteI18n.text("资料说明最多 12000 字符") }
        SourceRules.extensions(extensions); SourceRules.patterns(excluded)
    }
    fun json() = JSONObject().put("syncContinuously", syncContinuously).put("centralProcessingConsent", centralProcessingConsent).put("allowRead", allowRead).put("id", id).put("name", name).put("kind", kind).put("retention", retention).put("enabled", enabled)
        .put("calendarId", calendarId).put("uri", uri).put("tree", tree).put("extensions", extensions).put("excluded", excluded)
        .put("maxFileMiB", maxFileMiB).put("initialSync", initialSync).put("daysBefore", daysBefore).put("daysAfter", daysAfter).put("intervalMinutes", intervalMinutes)
        .put("description", description).put("contextVersion", contextVersion).put("contextDirty", contextDirty).put("contextTarget", contextTarget)
    fun registration(deviceId: String) = JSONObject().put("id", id).put("name", name).put("kind", kind).put("deviceId", deviceId)
        .put("platform", "android").put("initialSync", initialSync).put("retention", retention).put("enabled", true)
    companion object {
        private fun fileLimit(value: JSONObject): Int { val limit = FileTransfer.number(value, "maxFileMiB"); require(limit <= Int.MAX_VALUE); return limit.toInt() }
        private fun contextVersion(value: JSONObject): Int {
            if (!value.has("contextVersion")) return 0
            val version = value.get("contextVersion") as? Number ?: error("contextVersion must be numeric")
            require(version.toDouble() in 0.0..Int.MAX_VALUE.toDouble() && version.toDouble() == version.toInt().toDouble()) { "Invalid source context version" }
            return version.toInt()
        }
        fun from(v: JSONObject) = LocalSource(v.getString("id"), v.getString("name"), v.getString("kind"), v.getString("retention"), v.getBoolean("enabled"),
            if (v.has("calendarId")) v.getLong("calendarId") else null, if (v.has("uri")) v.getString("uri") else null,
            v.getBoolean("tree"), v.getString("extensions"), v.getString("excluded"),
            v.getInt("daysBefore"), v.getInt("daysAfter"), v.getInt("intervalMinutes"), v.getString("initialSync"), fileLimit(v), v.getBoolean("allowRead"), if (!v.has("centralProcessingConsent")) false else v.get("centralProcessingConsent") as? Boolean ?: error(MoteI18n.text("来源上传确认必须为布尔值")), if (v.has("syncContinuously")) v.get("syncContinuously") as? Boolean ?: error("syncContinuously must be boolean") else true,
            if (v.has("description")) v.get("description") as? String ?: error("description must be text") else "",
            contextVersion(v),
            if (v.has("contextDirty")) v.get("contextDirty") as? Boolean ?: error("contextDirty must be boolean") else false,
            if (v.has("contextTarget")) v.get("contextTarget") as? String ?: error("contextTarget must be text") else "").also { it.validate() }
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
        require(it.isNotEmpty() && it.size <= 20 && it.all { v -> v.matches(Regex("[a-z0-9]{1,12}")) }) { MoteI18n.text("扩展名使用逗号分隔，如 md,txt,json,csv,ics") }
    }
    fun patterns(value: String): List<SourcePathPattern> = value.lines().filter { it.isNotBlank() }.also {
        require(it.size <= 40 && it.all { v -> v.length <= 200 }) { MoteI18n.text("排除路径最多 40 行，每行 200 字符") }
    }.map { SourcePathPattern(it) }
    fun include(path: String, source: LocalSource): Boolean = path.substringAfterLast('.', "").lowercase() in extensions(source.extensions) && patterns(source.excluded).none { it.matches(path) }
    fun utf8(bytes: ByteArray): String {
        require(bytes.size <= FILE_BYTES) { MoteI18n.text("文件超过 100 KiB") }
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        require(!text.contains('\u0000') && text.length <= 100000) { MoteI18n.text("只支持 UTF-8 文本，最多 100000 字符") }
        return text.removePrefix("\uFEFF")
    }
    fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    fun validAck(sourceId: String, body: JSONObject, ack: JSONObject?): Boolean = IngressV2Protocol.validSource(sourceId, body, ack)
    fun fileSignature(item: JSONObject) = hash(canonical(JSONObject(item.toString()).apply { remove("observedAt"); remove("revision") }))
    fun contentHash(body: JSONObject): String = hash(canonical(JSONObject(body.toString()).apply { remove("observedAt"); remove("revision") }))
    fun withinWindow(body: JSONObject, from: Long?, until: Long?): Boolean {
        if (from == null || until == null) return true
        val calendar = body.optJSONObject("calendar") ?: return false
        return Instant.parse(calendar.getString("start")).toEpochMilli() < until && Instant.parse(calendar.getString("end")).toEpochMilli() >= from
    }
}

data class SourceScan(val items: List<JSONObject>, val complete: Boolean, val observedAt: String, val from: Long? = null, val until: Long? = null, val skipped: Int = 0)

/** A process-local permission to publish work for one exact source configuration. */
class SourceLease internal constructor(internal val hostKey: String, val source: LocalSource, val revision: Long)
// Both stores use this one metadata lock: config validation and queue publication
// cannot race, and there is no source-lock/archive-lock inversion. Provider I/O
// must never hold it. Configuration remains the durable authority after restart.
internal object SourceRuntime {
    val lock = Any()
    val revisions = mutableMapOf<String, Long>()
    val archiveDirectories = mutableMapOf<String, File>()
}
internal class SourceLeaseRevoked : IllegalStateException("Source configuration changed or was disabled")

/** Local snapshots plus immutable pending revisions. State changes are atomic and ACKs target-specific. */
class LocalSourceStore(private val directory: File, private val cipher: ByteCipher, private val archiveDirectory: File? = null) {
    internal var onMutation: (() -> Unit)? = null
    init { directory.mkdirs() }
    fun sources(): List<LocalSource> = synchronized(lock) {
        val array = read(File(directory, "config.enc")).optJSONArray("sources") ?: JSONArray()
        (0 until array.length()).map { LocalSource.from(array.getJSONObject(it)) }
    }
    private fun runtimeKey(id: String) = directory.absolutePath + ":" + id
    internal fun attachArchiveDirectory(value: File) { SourceRuntime.archiveDirectories[directory.absolutePath] = value }
    private fun reconcileArchives(id: String, source: LocalSource?) {
        val path = archiveDirectory ?: SourceRuntime.archiveDirectories[directory.absolutePath] ?: return
        if (path.isDirectory) FileArchiveQueue(path, cipher).reconcileScope(id, source)
    }
    internal fun lease(source: LocalSource): SourceLease? = synchronized(lock) {
        if (!source.enabled || sources().none { it == source }) null
        else SourceLease(runtimeKey(source.id), source, SourceRuntime.revisions[runtimeKey(source.id)] ?: 0L)
    }
    internal fun current(lease: SourceLease): Boolean = synchronized(lock) {
        lease.hostKey == runtimeKey(lease.source.id) && lease.source.enabled && sources().any { it == lease.source } &&
            (SourceRuntime.revisions[runtimeKey(lease.source.id)] ?: 0L) == lease.revision
    }
    private fun invalidate(id: String) {
        val key = runtimeKey(id); SourceRuntime.revisions[key] = (SourceRuntime.revisions[key] ?: 0L) + 1
    }
    fun save(source: LocalSource) = synchronized(lock) {
        source.validate(); val all = sources().toMutableList(); val old = all.find { it.id == source.id }
        if (old != source) invalidate(source.id)
        if (old != source) reconcileArchives(source.id, source)
        val retained = state(source.id)
        if (SourceAdmission.reconcile(retained, source)) write(file(source.id), retained)
        if (old == null || old.name != source.name || old.initialSync != source.initialSync || old.retention != source.retention) {
            val state = state(source.id); state.put("registered", false)
            if (!state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            write(file(source.id), state)
        }
        all.removeAll { it.id == source.id }; all.add(source)
        write(File(directory, "config.enc"), JSONObject().put("sources", JSONArray(all.map { it.json() })))
    }
    /** Apply the action shown to the owner; a stale Pause button must never resume a source. */
    fun setEnabled(id: String, enabled: Boolean): Boolean = synchronized(lock) {
        val current = sources().find { it.id == id } ?: return@synchronized false
        if (current.enabled != enabled) save(current.copy(enabled = enabled))
        true
    }
    /** Context ACKs only update metadata. A concurrent edit remains pending and never loses its draft. */
    fun confirmContext(expected: LocalSource, target: String, snapshot: SourceContextSnapshot): LocalSource? = synchronized(lock) {
        if (sources().find { it.id == expected.id } != expected) return@synchronized null
        val next = expected.copy(description = snapshot.description, contextVersion = snapshot.version, contextDirty = false, contextTarget = target)
        save(next)
        val state = state(next.id); state.remove("contextConflict"); write(file(next.id), state)
        next
    }
    fun contextConflict(id: String, snapshot: SourceContextSnapshot) = synchronized(lock) {
        if (sources().none { it.id == id && it.enabled }) return@synchronized
        val state = state(id); state.put("contextConflict", snapshot.json()).put("status", "context-conflict"); write(file(id), state)
    }
    fun remove(id: String) = synchronized(lock) {
        invalidate(id)
        reconcileArchives(id, null)
        write(File(directory, "config.enc"), JSONObject().put("sources", JSONArray(sources().filterNot { it.id == id }.map { it.json() })))
        val retained = state(id)
        if (SourceAdmission.reconcile(retained, null)) write(file(id), retained)
    }
    fun state(id: String): JSONObject = synchronized(lock) { read(file(id)) }
    fun status(id: String, code: String, at: String = Instant.now().toString(), lease: SourceLease? = null) = synchronized(lock) {
        if (sources().none { it.id == id } || lease != null && (lease.source.id != id || !current(lease))) return@synchronized
        require(code in setOf("ready", "scanned", "partial", "synced", "offline", "permission", "paused", "configuration", "storage", "provider", "http", "ack", "consent", "context-conflict", "context-http"))
        val state = state(id); state.put("status", code).put("statusAt", at); write(file(id), state)
    }
    fun pendingSync(): PendingSync = synchronized(lock) {
        var count = 0; var updates = 0; var oldest: Long? = null
        sources().forEach { source ->
            val state = state(source.id)
            val size = (state.optJSONArray("pending")?.length() ?: 0) + (state.optJSONArray("quarantine")?.length() ?: 0)
            val metadata = source.enabled && (!state.optBoolean("registered") || source.contextDirty)
            if (size > 0 || metadata) { count += size; if (metadata) updates++; val at = state.optLong("pendingSince", file(source.id).lastModified().takeIf { it > 0 } ?: File(directory, "config.enc").lastModified()); oldest = oldest?.let { minOf(it, at) } ?: at }
        }
        val known = sources().map { it.id }.toSet()
        directory.listFiles()?.filter { it.name.startsWith("source-") && it.extension == "enc" && it.name.removePrefix("source-").removeSuffix(".enc") !in known }?.forEach {
            val state = read(it); val size = (state.optJSONArray("pending")?.length() ?: 0) + (state.optJSONArray("quarantine")?.length() ?: 0)
            count += size; if (size > 0) oldest = minOf(oldest ?: Long.MAX_VALUE, it.lastModified())
        }
        PendingSync(count, oldest, updates)
    }
    /** Explicit full replay of retained versions; paused sources and their privacy choices stay untouched. */
    fun requeueRetained(origin: String): Int = synchronized(lock) {
        require(origin.isNotBlank())
        var count = 0
        for (source in sources().filter { it.enabled }) {
            val state = state(source.id)
            val pending = state.optJSONArray("pending") ?: JSONArray()
            val keys = (0 until pending.length()).map { identity(pending.getJSONObject(it)) }.toMutableSet()
            val proofs = state.optJSONObject("pendingScopes") ?: JSONObject()
            val held = state.optJSONArray("quarantine") ?: JSONArray()
            val heldKeys = (0 until held.length()).map { SourceAdmission.key(held.getJSONObject(it).getJSONObject("item")) }.toMutableSet()
            val current = state.optJSONObject("current") ?: JSONObject()
            for (key in current.keys()) {
                val row = current.getJSONObject(key); val body = row.getJSONObject("body"); val identity = identity(body)
                if (identity in keys || identity in heldKeys) continue
                val acknowledgment = state.optJSONObject("archiveAcknowledgments")?.optJSONObject(identity)
                if (acknowledgment?.optString("origin")?.let { it != origin.trim().trimEnd('/') } == true) continue
                val proof = row.optJSONObject("sourceScope")
                if (acknowledgment == null || !SourceAdmission.permits(source, body, proof)) {
                    held.put(JSONObject().put("item", body).put("sourceScope", proof ?: JSONObject.NULL).put("policy", SourceAdmission.quarantine())); heldKeys.add(identity)
                } else {
                    pending.put(body); keys.add(identity); proofs.put(identity, proof)
                }
            }
            state.put("pending", pending).put("pendingScopes", proofs).put("quarantine", held).put("registered", false)
            if (!state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            val bytes = cipher.seal(state.toString().toByteArray(Charsets.UTF_8))
            writeBytes(file(source.id), bytes); count += pending.length()
        }; count
    }
    fun selectTarget(id: String, target: String) = synchronized(lock) {
        if (sources().none { it.id == id && it.enabled }) return@synchronized
        val state = state(id)
        if (state.optString("target") != target) {
            state.put("target", target).put("registered", false).remove("lastAcknowledgedAt")
            val pending = state.optJSONArray("pending") ?: JSONArray()
            if (pending.length() > 0 && !state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
            state.put("pending", pending); write(file(id), state)
        }
    }
    fun registered(id: String, target: String) = synchronized(lock) {
        if (sources().none { it.id == id && it.enabled }) return@synchronized
        val state = state(id); check(state.optString("target") == target); state.put("registered", true)
        if ((state.optJSONArray("pending")?.length() ?: 0) == 0) state.remove("pendingSince")
        write(file(id), state)
    }
    fun scan(source: LocalSource, result: SourceScan, lease: SourceLease? = lease(source)) = synchronized(lock) {
        if (lease == null || lease.source != source || !current(lease)) return@synchronized
        result.items.forEach { SourcePrivacyGate.validate(source, it) }
        val state = state(source.id); val current = state.optJSONObject("current") ?: JSONObject(); val pending = state.optJSONArray("pending") ?: JSONArray()
        val baseline = state.optJSONArray("baseline") ?: JSONArray()
        if (source.initialSync == "new_only" && !state.optBoolean("initialized") && current.length() == 0) {
            val ids = (0 until baseline.length()).map { baseline.getString(it) }.toMutableSet()
            result.items.forEach { ids.add(it.getString("externalId")) }
            state.put("baseline", JSONArray(ids.toList())).put("initialized", result.complete).put("scanComplete", result.complete).put("lastScan", result.observedAt)
            write(file(source.id), state); return@synchronized
        }
        val ignored = if (source.initialSync == "new_only") (0 until baseline.length()).map { baseline.getString(it) }.toSet() else emptySet()
        if (source.initialSync == "all") state.remove("baseline")
        if (result.complete) state.put("initialized", true)

        val seen = mutableSetOf<String>()
        fun accept(input: JSONObject) {
            val body = JSONObject(input.toString()); val external = body.getString("externalId"); require(external.length <= 1000)
            val hash = SourceRules.contentHash(body); val previous = current.optJSONObject(external)
            val held = state.optJSONArray("quarantine") ?: JSONArray()
            val quarantined = (0 until held.length()).any { held.getJSONObject(it).getJSONObject("item").optString("revision") == previous?.optJSONObject("body")?.optString("revision") }
            if (previous?.optString("hash") == hash && !quarantined) return
            // The predecessor distinguishes deletion/restoration with identical original content.
            body.put("revision", SourceRules.hash(hash + ":" + (previous?.getJSONObject("body")?.optString("revision") ?: "")))
            val proof = SourceAdmission.capture(source, result.observedAt)
            pending.put(body); current.put(external, JSONObject().put("hash", hash).put("body", body).put("sourceScope", proof))
            val proofs = state.optJSONObject("pendingScopes") ?: JSONObject()
            proofs.put(SourceAdmission.key(body), proof); state.put("pendingScopes", proofs)
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
        if (pending.length() > 0 && !state.has("pendingSince")) state.put("pendingSince", System.currentTimeMillis())
        state.put("current", current).put("pending", pending).put("lastScan", result.observedAt).put("status", if (result.complete) "scanned" else "partial").put("skipped", result.skipped).put("scanComplete", result.complete)
        val bytes = cipher.seal(state.toString().toByteArray(Charsets.UTF_8))
        writeBytes(file(source.id), bytes)
    }
    fun next(id: String, target: String): JSONObject? = synchronized(lock) {
        val state = state(id); if (SourceAdmission.reconcile(state, sources().find { it.id == id })) write(file(id), state)
        if (state.optString("target") != target) return@synchronized null
        state.optJSONArray("pending")?.takeIf { it.length() > 0 }?.getJSONObject(0)
    }
    fun acknowledge(id: String, target: String, externalId: String, revision: String, origin: String? = null, captureId: String? = null) = synchronized(lock) {
        val state = state(id); if (state.optString("target") != target) return@synchronized
        val old = state.optJSONArray("pending") ?: JSONArray(); val next = JSONArray()
        for (i in 0 until old.length()) { val value = old.getJSONObject(i); if (value.getString("externalId") != externalId || value.getString("revision") != revision) next.put(value) }
        if (next.length() == 0) state.remove("pendingSince")
        if (next.length() < old.length()) {
            val at = Instant.now().toString()
            state.put("lastAcknowledgedAt", at)
            state.optJSONObject("pendingScopes")?.remove(externalId + "\u0000" + revision)
            if (origin != null && captureId != null) {
                val acknowledgments = state.optJSONObject("archiveAcknowledgments") ?: JSONObject()
                acknowledgments.put(externalId + "\u0000" + revision, JSONObject().put("sourceId", id).put("externalId", externalId)
                    .put("revision", revision).put("captureId", captureId).put("origin", origin).put("at", at))
                state.put("archiveAcknowledgments", acknowledgments)
            }
        }
        state.put("pending", next); write(file(id), state)
    }
    internal fun acknowledgeExact(identity: ItemUploadIdentity, captureId: String): Boolean = synchronized(lock) {
        UUID.fromString(captureId)
        if (sources().none { it.id==identity.sourceId && it.enabled }) return@synchronized false
        val state = state(identity.sourceId)
        if (SourceAdmission.reconcile(state, sources().find { it.id == identity.sourceId })) write(file(identity.sourceId), state)
        if (state.optString("target") != identity.target) return@synchronized false
        val held = state.optJSONArray("quarantine") ?: JSONArray()
        if ((0 until held.length()).any { SourceAdmission.key(held.getJSONObject(it).getJSONObject("item")) == identity.externalId + "\u0000" + identity.revision }) return@synchronized false
        val pending = state.optJSONArray("pending") ?: JSONArray()
        val matching = (0 until pending.length()).map { pending.getJSONObject(it) }.filter { it.optString("externalId")==identity.externalId && it.optString("revision")==identity.revision }
        if (matching.any { SourceRules.hash(SourceRules.canonical(it)) != identity.fingerprint }) return@synchronized false
        if (matching.isEmpty()) {
            val saved = state.optJSONObject("archiveAcknowledgments")?.optJSONObject(identity.externalId + "\u0000" + identity.revision)
            return@synchronized saved?.optString("captureId") == captureId && saved.optString("origin") == identity.origin
        }
        acknowledge(identity.sourceId,identity.target,identity.externalId,identity.revision,identity.origin,captureId)
        true
    }
    private fun identity(value: JSONObject) = value.getString("externalId") + "\u0000" + value.getString("revision")
    private fun file(id: String): File { require(id.matches(Regex("[A-Za-z0-9_.:-]{1,128}"))); return File(directory, "source-$id.enc") }
    private fun read(file: File) = if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else JSONObject()
    private fun write(file: File, body: JSONObject) = writeBytes(file, cipher.seal(body.toString().toByteArray(Charsets.UTF_8)))
    private fun writeBytes(file: File, bytes: ByteArray) {
        val temp = File(directory, "${UUID.randomUUID()}.tmp")
        try { FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }; check(temp.renameTo(file)) { MoteI18n.text("无法保存来源状态") }; onMutation?.invoke() } finally { temp.delete() }
    }
    companion object { private val lock = SourceRuntime.lock }
}
