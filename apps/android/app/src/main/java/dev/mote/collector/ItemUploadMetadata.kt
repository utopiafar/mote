package dev.mote.collector

import org.json.JSONObject
import java.util.UUID

/** Whitelist only: no original body, title, URI, file name, response text or credential. */
internal data class ItemUploadIdentity(val kind: String, val scope: String, val lane: String, val origin: String,
    val deviceId: String, val target: String, val sourceId: String, val externalId: String, val revision: String,
    val fingerprint: String, val sha256: String = "", val sizeBytes: Long = 0, val recordId: String = "", val attachmentId: String = "") {
    init { require(kind in setOf("source-item", "file", "attachment") && lane in setOf("source", "capture")); require(sizeBytes >= 0) }
    val key get() = SourceRules.hash(listOf(scope,kind,sourceId,externalId,revision,fingerprint,sha256,recordId,attachmentId).joinToString("\u0000"))
    fun json() = JSONObject().put("kind",kind).put("scope",scope).put("lane",lane).put("origin",origin).put("deviceId",deviceId).put("target",target)
        .put("sourceId",sourceId).put("externalId",externalId).put("revision",revision).put("fingerprint",fingerprint).put("sha256",sha256)
        .put("sizeBytes",sizeBytes).put("recordId",recordId).put("attachmentId",attachmentId)
    companion object {
        fun parse(v: JSONObject) = ItemUploadIdentity(v.getString("kind"),v.getString("scope"),v.getString("lane"),v.getString("origin"),v.getString("deviceId"),v.getString("target"),v.getString("sourceId"),v.getString("externalId"),v.getString("revision"),v.getString("fingerprint"),v.getString("sha256"),v.getLong("sizeBytes"),v.getString("recordId"),v.getString("attachmentId"))
    }
}
internal data class ItemUploadAttempt(val id: String, val batchId: String, val process: String, val identity: ItemUploadIdentity,
    val phase: String, val startedAt: Long, val bodyBytes: Long, val state: String = "sending", val status: Int = 0,
    val elapsedMs: Long = 0, val reason: String = "") {
    init { UUID.fromString(id); UUID.fromString(batchId); require(phase in setOf("item","manifest","part","commit")); require(bodyBytes >= 0 && elapsedMs >= 0) }
    fun json() = JSONObject().put("id",id).put("batchId",batchId).put("process",process).put("identity",identity.json()).put("phase",phase).put("startedAt",startedAt)
        .put("bodyBytes",bodyBytes).put("state",state).put("status",status).put("elapsedMs",elapsedMs).put("reason",reason)
    companion object { fun parse(v: JSONObject) = ItemUploadAttempt(v.getString("id"),v.getString("batchId"),v.getString("process"),ItemUploadIdentity.parse(v.getJSONObject("identity")),v.getString("phase"),v.getLong("startedAt"),v.getLong("bodyBytes"),v.getString("state"),v.getInt("status"),v.getLong("elapsedMs"),v.getString("reason")) }
}
internal data class ItemUploadReceipt(val identity: ItemUploadIdentity, val batchId: String, val captureId: String, val receivedAt: Long) {
    init { UUID.fromString(batchId); UUID.fromString(captureId); require(receivedAt > 0) }
    fun json() = JSONObject().put("identity",identity.json()).put("batchId",batchId).put("captureId",captureId).put("receivedAt",receivedAt)
    companion object { fun parse(v: JSONObject) = ItemUploadReceipt(ItemUploadIdentity.parse(v.getJSONObject("identity")),v.getString("batchId"),v.getString("captureId"),v.getLong("receivedAt")) }
}
