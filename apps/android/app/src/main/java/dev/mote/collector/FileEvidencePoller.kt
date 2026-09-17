package dev.mote.collector

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object FileEvidencePoller {
    fun start(context: Context) {
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({ runCatching { ConnectionGuard.sync { poll(context.applicationContext) } } }, 10, 10, TimeUnit.SECONDS)
    }
    internal fun poll(context: Context) {
        if (QueueStorage.recovering || ConnectionGuard.reconfiguring()) return
        val settings = Settings(context); val config = settings.read()
        if (!config.hasSyncConnection() || SyncSchedule.waitingReason(context, config) != null) return
        settings.ensureDataOrigin(config)
        for (source in context.localSources().sources().filter { it.enabled && it.allowRead && it.kind == "local-files" && it.retention == "snapshot" }) {
            val (code, body) = HttpJson.get("${config.server}/api/sources/${source.id}/read-requests", config.token)
            if (code != 200) continue
            val items = body?.optJSONArray("items") ?: continue
            for (i in 0 until minOf(100, items.length())) {
                val request = items.getJSONObject(i); val id = request.getString("id"); check(id.matches(Regex("[a-f0-9-]{36}")))
                val version = request.getString("contentVersion"); val offset = request.getInt("offset"); val length = request.getInt("length"); check(offset in 0..10000000 && length in 1..16000)
                val result = JSONObject().put("status", "denied").put("text", "").put("contentVersion", version)
                val candidate = context.fileArchives().candidate(source.id, request.getString("externalId"))
                fun authorized() = !ConnectionGuard.reconfiguring() && context.localSources().sources().any { it == source && it.enabled && it.allowRead } && settings.read().let { it.server == config.server && it.token == config.token } && SourceAccess.available(context, source)
                if (request.getString("sourceId") == source.id && candidate != null && authorized() && SourceRules.include(candidate.optString("_relativePath", candidate.getString("title")), source)) {
                    runCatching {
                        val uri = Uri.parse(candidate.getString("uri")); val selected = Uri.parse(source.uri)
                        val inScope = if (!source.tree) uri == selected else runCatching { val root = android.provider.DocumentsContract.buildDocumentUriUsingTree(selected, android.provider.DocumentsContract.getTreeDocumentId(selected)); uri == root || android.provider.DocumentsContract.isChildDocument(context.contentResolver, root, uri) }.getOrDefault(false)
                        check(inScope)
                        val before = FileSources(context).metadata(uri, source) ?: error("Unavailable file"); val bytes = context.contentResolver.openInputStream(uri)!!.use { LocalFileIndex.bytes(it) }
                        if (LocalFileIndex.hash(bytes) != version) result.put("status", "version_changed")
                        else {
                            val parser = LocalFileIndex.extract(bytes, candidate.optString("mimeType"), candidate.getString("title"))
                            if (parser.status != "ready") result.put("status", "unavailable")
                            else if (FileSources(context).metadata(uri, source)?.let { context.fileArchives().signature(it) } != context.fileArchives().signature(before)) result.put("status", "version_changed")
                            else if (authorized()) result.put("status", "ready").put("text", parser.text.drop(offset).take(length))
                        }
                    }.onFailure { result.put("status", "unavailable").put("text", "") }
                }
                if (authorized()) HttpJson.request("PUT", "${config.server}/api/sources/${source.id}/read-requests/$id", result, config.token)
            }
        }
    }
}
