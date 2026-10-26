package dev.mote.collector

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

internal object LibraryLocalSources {
    data class Page(val items: List<JSONObject>, val cursor: Pair<String, String>?)
    fun page(context: Context, after: String, before: String, cursor: Pair<String, String>?, kind: String, sourceId: String, limit: Int = 20): Page {
        val sources = context.localSources()
        val candidates = sources.sources().filter { sourceId.isBlank() || it.id == sourceId }.flatMap { source ->
            if (source.binaryFiles()) {
                if (kind.isNotBlank() && kind != "file") emptyList() else context.fileArchives().libraryRows(source, after, before, cursor, limit + 1).map { row ->
                    val pending = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item")
                    val item = pending ?: row.getJSONObject("candidate")
                    val receipt = LocalContentPresentation.currentReceipt(row)
                    JSONObject().put("type", "original").put("sourceId", source.id).put("sourceName", source.name).put("externalId", item.getString("externalId"))
                        .put("revision", pending?.getString("revision") ?: if (receipt != null) row.getString("revision") else "candidate:" + SourceRules.fileSignature(item))
                        .put("provisional", pending == null && receipt == null).put("captureId", receipt ?: "").put("deviceId", Settings(context).deviceId).put("title", item.optString("title"))
                        .put("sortAt", row.getJSONObject("candidate").getString("observedAt")).put("libraryKey", row.getString("libraryKey"))
                        .put("kind", "file").put("localFile", true).put("localReadable", pending != null).put("layer", item.optString("layer"))
                        .put("localItem", item).put("sourceDescription", source.description)
                }
            } else {
                val state = sources.state(source.id); val current = state.optJSONObject("current") ?: JSONObject()
                val bodies = linkedMapOf<String, JSONObject>()
                current.keys().forEach { key -> current.getJSONObject(key).getJSONObject("body").let { bodies[JSONArray(listOf(it.getString("externalId"), it.getString("revision"))).toString()] = it } }
                val pending = state.optJSONArray("pending") ?: JSONArray()
                repeat(pending.length()) { pending.getJSONObject(it).let { body -> bodies[JSONArray(listOf(body.getString("externalId"), body.getString("revision"))).toString()] = body } }
                bodies.values.filter { !it.optBoolean("deleted") && (kind.isBlank() || kind == "source" || it.optString("kind") == kind) }.map { body ->
                    JSONObject().put("type", "original").put("sourceId", source.id).put("sourceName", source.name).put("externalId", body.getString("externalId"))
                        .put("revision", body.getString("revision")).put("deviceId", Settings(context).deviceId).put("title", body.optString("title"))
                        .put("sortAt", body.getString("observedAt")).put("libraryKey", source.id + ":" + SourceRules.hash(body.getString("externalId")) + ":" + body.getString("revision"))
                        .put("kind", body.optString("kind")).put("localReadable", body.optString("layer") != "reference").put("localItem", body).put("sourceDescription", source.description)
                }
            }
        }.filter { val time = it.getString("sortAt"); val key = it.getString("libraryKey"); Instant.parse(time) >= Instant.parse(after) && Instant.parse(time) < Instant.parse(before) && (cursor == null || Instant.parse(time) < Instant.parse(cursor.first) || Instant.parse(time) == Instant.parse(cursor.first) && key > cursor.second) }
            .sortedWith(compareByDescending<JSONObject> { Instant.parse(it.getString("sortAt")) }.thenBy { it.getString("libraryKey") })
        val items = candidates.take(limit)
        return Page(items, if (candidates.size > limit) items.last().let { it.getString("sortAt") to it.getString("libraryKey") } else null)
    }
}
