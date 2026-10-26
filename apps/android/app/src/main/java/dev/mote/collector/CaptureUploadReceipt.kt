package dev.mote.collector

import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID

/** Content-free identities for a received capture version. Never store the capture body here. */
internal data class CaptureUploadReceipt(
    val scope: String, val itemKey: String, val captureId: String, val queueVersion: String,
    val transportVersion: String, val origin: String, val deviceId: String, val source: String,
    val capturedAt: String, val batchId: String, val receivedAt: Long, val payloadBytes: Long,
    val localRetentionDays: Int
) {
    fun json() = JSONObject().put("kind", "capture").put("scope", scope).put("itemKey", itemKey).put("captureId", captureId)
        .put("queueVersion", queueVersion).put("transportVersion", transportVersion).put("origin", origin)
        .put("deviceId", deviceId).put("source", source).put("capturedAt", capturedAt).put("batchId", batchId)
        .put("receivedAt", receivedAt).put("payloadBytes", payloadBytes).put("localRetentionDays", localRetentionDays)
    fun completion() = CaptureUploadCompletion(itemKey, scope, captureId, queueVersion, origin, receivedAt, payloadBytes, localRetentionDays)
    companion object {
        fun scope(origin: String, deviceId: String): String {
            val uri = java.net.URI(origin.trim())
            val scheme = uri.scheme.lowercase(java.util.Locale.ROOT)
            val port = uri.port.takeUnless { scheme == "https" && it == 443 || scheme == "http" && it == 80 } ?: -1
            val normalized = java.net.URI(scheme, null, requireNotNull(uri.host).lowercase(java.util.Locale.ROOT), port, null, null, null).toASCIIString()
            return SourceRules.hash(normalized + "\n" + deviceId)
        }
        fun create(origin: String, deviceId: String, original: JSONObject, sent: JSONObject, batchId: String, now: Long, localRetentionDays: Int): CaptureUploadReceipt {
            val id = sent.getString("id"); UUID.fromString(id); UUID.fromString(batchId)
            require(id == original.getString("id") && sent.getString("deviceId") == deviceId && original.getString("deviceId") == deviceId)
            require(localRetentionDays in 0..365 && now > 0)
            val scope = scope(origin, deviceId); val transport = CaptureUploadVersion.of(sent)
            val at = sent.getString("capturedAt"); Instant.parse(at)
            return CaptureUploadReceipt(scope, SourceRules.hash("$scope\n$id\n$transport"), id, CaptureUploadVersion.of(original), transport,
                origin.trim().trimEnd('/'), deviceId, sent.getString("source"), at, batchId, now, sent.toString().toByteArray(Charsets.UTF_8).size.toLong(), localRetentionDays)
        }
        fun parse(value: JSONObject) = CaptureUploadReceipt(value.getString("scope"), value.getString("itemKey"), value.getString("captureId"),
            value.getString("queueVersion"), value.getString("transportVersion"), value.getString("origin"), value.getString("deviceId"),
            value.getString("source"), value.getString("capturedAt"), value.getString("batchId"), value.getLong("receivedAt"), value.getLong("payloadBytes"), value.getInt("localRetentionDays"))
    }
}

/** Only the minimum still-needed transport state survives history expiration. No date/source/batch. */
internal data class CaptureUploadCompletion(val itemKey: String, val scope: String, val captureId: String, val queueVersion: String,
    val origin: String, val receivedAt: Long, val payloadBytes: Long, val localRetentionDays: Int) {
    fun json() = JSONObject().put("kind", "capture").put("itemKey", itemKey).put("scope", scope).put("captureId", captureId).put("queueVersion", queueVersion)
        .put("origin", origin).put("receivedAt", receivedAt).put("payloadBytes", payloadBytes).put("localRetentionDays", localRetentionDays)
    companion object {
        fun parse(value: JSONObject) = CaptureUploadCompletion(value.getString("itemKey"), value.getString("scope"), value.getString("captureId"),
            value.getString("queueVersion"), value.getString("origin"), value.getLong("receivedAt"), value.getLong("payloadBytes"), value.getInt("localRetentionDays"))
    }
}

/** Same fingerprint for a stored event and its upload body, without retaining text/image bytes. */
internal object CaptureUploadVersion {
    fun of(event: JSONObject): String {
        val value = JSONObject(event.toString())
        val blob = value.optString("_blob").takeIf { it.matches(Regex("[a-f0-9]{64}")) }
            ?: value.optString("imageBase64").takeIf(String::isNotBlank)?.let { encoded ->
                MessageDigest.getInstance("SHA-256").digest(Base64.getDecoder().decode(encoded)).joinToString("") { "%02x".format(it) }
            }
        listOf("_archiveOrigin", "_centralDerived", "_reviewHeld", "_uploaded", "_retainedUntil", "_archiveMissing", "_uploadConflict", "_blob", "imageBase64").forEach(value::remove)
        blob?.let { value.put("imageSha256", it) }
        return SourceRules.hash(SourceRules.canonical(value))
    }
}

internal interface CaptureReceiptStore {
    /** Persist confirmation and the transport completion marker in one durable transaction. */
    fun received(receipt: CaptureUploadReceipt): CaptureUploadCompletion
    fun pending(scope: String): List<CaptureUploadCompletion>
    fun completed(itemKey: String)
}

internal class CaptureReceiptFinalizer(private val store: CaptureReceiptStore) {
    fun received(queue: DurableQueue, receipt: CaptureUploadReceipt) {
        complete(queue, store.received(receipt)) // Storage failure must leave the outbox untouched.
    }
    fun recover(queue: DurableQueue, scope: String) { store.pending(scope).forEach { complete(queue, it) } }
    private fun complete(queue: DurableQueue, receipt: CaptureUploadCompletion) {
        queue.acknowledgeReceivedVersion(receipt.captureId, receipt.queueVersion, receipt.origin,
            receipt.payloadBytes, receipt.localRetentionDays, receipt.receivedAt)
        // A newer version is still pending. Its older confirmation is historical evidence only.
        // A missing/already-completed record also needs no transport marker after a restart.
        store.completed(receipt.itemKey)
    }
}
