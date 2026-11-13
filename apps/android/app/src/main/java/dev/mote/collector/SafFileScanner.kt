package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Provider IDs and locators are opaque; no filesystem inode or content hash is an identity. */
internal data class SafDocument(val id: String, val uri: String, val name: String, val mime: String,
                                val size: Long?, val modified: Long?, val directory: Boolean) {
    fun fingerprint() = SourceRules.hash(SourceRules.canonical(JSONArray(listOf(id, name, mime, size, modified))))
    fun item(source: LocalSource, externalId: String) = JSONObject().put("externalId", externalId).put("uri", uri)
        .put("title", name.take(2000)).put("kind", "file")
        .put("layer", if (source.retention == "archive") "original" else if (source.retention == "snapshot") "snapshot" else "reference")
        .put("text", "").put("mimeType", mime.take(200)).put("observedAt", Instant.now().toString()).apply {
            size?.takeIf { it >= 0 }?.let { put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", it))) }
            modified?.takeIf { it > 0 }?.let { put("modifiedAt", Instant.ofEpochMilli(it).toString()) }
        }
}

internal enum class SafChildrenResult { COMPLETE, STOPPED, INCOMPLETE }
internal class SafScanIncomplete : IllegalStateException("Document provider enumeration is incomplete")

/** A completed one-time import owns immutable bytes; continuous sources need a current grant. */
internal object SafUploadGate {
    fun runnable(enabled: Boolean, capturedImport: Boolean, readGrant: () -> Boolean): Boolean =
        enabled && (capturedImport || readGrant())
}

/** Only the provider/OS boundary is replaced by the generated JVM fixture. */
internal interface SafScanProvider {
    val watcher: String
    fun checkAccess()
    fun root(): SafDocument?
    fun document(uri: String): SafDocument?
    fun children(parent: String, visit: (SafDocument) -> Boolean): SafChildrenResult
    fun absent(uri: String): Boolean
}

/** Durable bounded traversal; a failed or invalidated traversal never reports removals. */
internal class SafFileScanner(private val queue: FileArchiveQueue, private val provider: SafScanProvider,
                              private val lease: SourceLease? = null, private val sliceSize: Int = 200) {
    fun scan(source: LocalSource): Boolean {
        require(sliceSize > 0)
        val state = queue.beginScan(source, provider.watcher, lease)
        val generation = state.getString("generation")
        try {
            provider.checkAccess()
            val root = provider.root() ?: throw SafScanIncomplete()
            val identities = queue.rows(source.id).mapNotNull { row ->
                val item = row.getJSONObject("candidate")
                SafIdentity.document(item.optString("uri"))?.let { it to item.getString("externalId") }
            }.toMap().toMutableMap()
            fun external(uri: String): String = SafIdentity.document(uri)?.let { identities.getOrPut(it) { uri } } ?: uri
            if (!source.tree) {
                if (root.directory) throw SafScanIncomplete()
                if (SourceRules.include(root.name, source)) queue.observe(source, root.item(source, external(root.uri)), generation, lease = lease)
                provider.checkAccess()
                val complete = queue.finish(source, generation, lease) { false }
                if (complete && !source.syncContinuously && queue.pendingCount(source.id) == 0) queue.captured(source, lease)
                return complete
            }
            if (!root.directory) throw SafScanIncomplete()
            val stack = state.optJSONArray("stack") ?: JSONArray().put(JSONObject().put("id", root.id).put("offset", 0).put("prefix", "").put("path", ""))
            var examined = 0
            while (stack.length() > 0 && examined < sliceSize) {
                provider.checkAccess()
                val current = stack.getJSONObject(stack.length() - 1)
                val offset = current.getInt("offset")
                if (offset > 0 && !current.has("prefix")) { queue.providerChanged(source, lease); return false }
                var index = 0; var prefix = ""; var mismatch = false
                val nested = mutableListOf<JSONObject>()
                val result = provider.children(current.getString("id")) { document ->
                    provider.checkAccess()
                    if (index == offset && prefix != current.optString("prefix")) { mismatch = true; return@children false }
                    if (index >= offset && examined >= sliceSize) return@children false
                    prefix = SourceRules.hash(prefix + "\u0000" + document.fingerprint())
                    index++
                    if (index <= offset) return@children true
                    examined++
                    current.put("offset", index).put("prefix", prefix)
                    val path = (current.getString("path").takeIf { it.isNotEmpty() }?.plus("/") ?: "") + document.name
                    if (SourceRules.patterns(source.excluded).any { it.matches(path) }) return@children true
                    if (document.directory) {
                        check(path.count { it == '/' } < 32) { MoteI18n.text("目录层级超过上限") }
                        nested.add(JSONObject().put("id", document.id).put("offset", 0).put("prefix", "").put("path", path))
                    } else if (SourceRules.include(path, source)) {
                        val currentDocument = provider.document(document.uri) ?: throw SafScanIncomplete()
                        if (currentDocument != document) throw SafScanIncomplete()
                        queue.observe(source, currentDocument.item(source, external(document.uri)).put("_relativePath", path), generation, lease = lease)
                    }
                    true
                }
                if (mismatch || index < offset || (index == offset && prefix != current.optString("prefix"))) {
                    queue.providerChanged(source, lease); return false
                }
                if (result == SafChildrenResult.INCOMPLETE) throw SafScanIncomplete()
                if (result == SafChildrenResult.COMPLETE) stack.remove(stack.length() - 1)
                nested.forEach { stack.put(it) }
                check(stack.length() <= 10000) { MoteI18n.text("待扫描目录超过上限") }
                provider.checkAccess()
                state.put("stack", stack); queue.checkpoint(source, state, generation, lease)
            }
            if (stack.length() != 0) return false
            provider.checkAccess()
            if (provider.root() != root) { queue.providerChanged(source, lease); return false }
            return queue.finish(source, generation, lease) { external ->
                provider.checkAccess()
                val uri = queue.candidate(source.id, external)?.optString("uri").orEmpty()
                val missing = uri.isNotBlank() && provider.absent(uri)
                provider.checkAccess()
                missing
            }
        } catch (error: Exception) {
            queue.interruptScan(source, generation, lease)
            throw error
        }
    }
}
