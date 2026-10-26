package dev.mote.collector

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Attachment ACKs precede the note; all requests use the cancellable collector sending gate. */
internal object RecordAttachmentSync {
    fun prepare(context: Context, config: CollectorConfig, original: JSONObject, history: ItemUploadSession): JSONObject {
        if (original.optString("source") != "note") return original
        val store = context.recordDraftStore()
        val record = store.record(original.getString("id")) ?: return original
        val attachments = record.getJSONArray("attachments")
        if (attachments.length() == 0) return original
        val bound = record.getString("server")
        require(bound == Settings(context).dataOrigin() || bound.isBlank()) { MoteI18n.text("目标节点已变化，请确认本机记录归属。") }
        val ids = JSONArray()
        for (index in 0 until attachments.length()) {
            val item = attachments.getJSONObject(index); val id = item.getString("id")
            var capture = record.getJSONObject("acks").optString(id)
            if (capture.isBlank()) {
                SyncSchedule.requireConditions(context, Settings(context).read())
                val spool = File.createTempFile("mote-record-", ".tmp", context.cacheDir)
                try {
                    spool.writeBytes(store.bytes(id))
                    var identity: ItemUploadIdentity? = null
                    var manifest: JSONObject? = null
                    val client = CentralClient(config.server, config.connectionToken(), transport = { method, url, body, token, mime ->
                        SyncSchedule.requireConditions(context, Settings(context).read())
                        if (url.endsWith("/api/file-sync/v1/uploads") && body != null) {
                            manifest = JSONObject(String(body, Charsets.UTF_8))
                            identity = history.identity("attachment", manifest!!.getString("sourceId"), manifest!!.getJSONObject("item"), manifest!!, original.getString("id"), id)
                        }
                        val itemIdentity = identity
                        if (itemIdentity == null) HttpJson.requestBytes(method, url, body, token, mime, sendingContext = context)
                        else history.send(itemIdentity, if (url.contains("/parts/")) "part" else if (url.endsWith("/commit")) "commit" else "manifest", (body?.size ?: 0).toLong(), { status, ack ->
                            if (status !in 200..299) "unknown" else {
                                if (url.contains("/parts/")) FileUploadConfirmation.part(checkNotNull(ack), url.substringAfterLast('/').toInt(), checkNotNull(body))
                                val final = ack?.optJSONObject("ack") ?: ack?.takeIf { it.has("receipt") }
                                if (final != null) { FileUploadConfirmation.canonicalId(itemIdentity.sourceId, manifest!!, final); "received" } else "transferred"
                            }
                        }) { HttpJson.requestBytes(method, url, body, token, mime, sendingContext = context) }
                    })
                    capture = CentralAttachments.upload(client, spool, item.getString("name"), item.getString("mime"), Settings(context).deviceId,
                        resolveTime = { java.time.Instant.parse(original.getString("capturedAt")).toEpochMilli() }, identityScope = original.getString("id"))
                    history.received(checkNotNull(identity), capture)
                } finally { spool.delete() }
            }
            ids.put(capture)
        }
        return JSONObject(original.toString()).apply {
            val metadata = optJSONObject("metadata") ?: JSONObject().also { put("metadata", it) }
            metadata.put("attachments", ids)
        }
    }
}
