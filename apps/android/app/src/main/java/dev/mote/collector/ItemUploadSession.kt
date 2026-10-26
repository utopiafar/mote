package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.util.UUID

internal class ItemUploadSession(private val context: Context, private val config: CollectorConfig,
    val batchId: String = UUID.randomUUID().toString(), private val lane: String) {
    private val settings = Settings(context)
    private val store = context.itemUploadHistory()
    private val origin = config.server.trim().trimEnd('/')
    private val device = settings.deviceId
    private val target = SourceRules.target(config.server, config.token)
    private val scope = CaptureUploadReceipt.scope(origin, device)
    fun identity(kind: String, sourceId: String, body: JSONObject, manifest: JSONObject = body,
        recordId: String = "", attachmentId: String = "") = ItemUploadIdentity(kind,scope,lane,origin,device,target,sourceId,
        body.getString("externalId"),body.getString("revision"),SourceRules.hash(SourceRules.canonical(manifest)),manifest.optString("sha256"),manifest.optLong("sizeBytes"),recordId,attachmentId)
    fun restore(includeCurrent: Boolean = true) {
        store.prune(UploadHistoryRetention.read(context))
        store.recoverInterrupted(scope,lane,LoginProcess.id,includeCurrent)
        store.pending(scope,lane).forEach { finish(it) }
    }
    fun send(identity: ItemUploadIdentity, phase: String, bytes: Long, classify: (Int, JSONObject?) -> String,
        action: () -> Pair<Int, JSONObject?>): Pair<Int, JSONObject?> {
        val attempt = ItemUploadAttempt(UUID.randomUUID().toString(),batchId,LoginProcess.id,identity,phase,System.currentTimeMillis(),bytes)
        store.save(attempt)
        val started = System.nanoTime(); var status = 0
        fun elapsed() = ((System.nanoTime()-started)/1_000_000).coerceAtLeast(0)
        try {
            val response = action(); status = response.first
            val state = classify(status,response.second)
            store.save(attempt.copy(state=state,status=status,elapsedMs=elapsed(),reason=if(state=="unknown") "unconfirmed" else ""))
            return response
        } catch(error: Exception) {
            val code = when(error) { is FileTransportFailure -> error.httpStatus; is FileIngressRejection -> error.httpStatus; else -> status }
            store.save(attempt.copy(state=if(error is SyncConditionsUnavailable) "cancelled" else "unknown",status=code,elapsedMs=elapsed(),reason=if(error is SyncConditionsUnavailable) "conditions" else "unconfirmed"))
            throw error
        }
    }
    fun received(identity: ItemUploadIdentity, canonicalId: String) {
        val receipt = store.received(ItemUploadReceipt(identity,batchId,canonicalId,System.currentTimeMillis()))
        check(finish(receipt)) { MoteI18n.text("目标或原件已变化，已保留上传确认，请稍后重试。") }
    }
    private fun finish(receipt: ItemUploadReceipt): Boolean {
        val identity = receipt.identity
        val current = settings.read()
        if (identity.scope != scope || identity.target != SourceRules.target(current.server,current.token) || current.server.trim().trimEnd('/') != identity.origin) return false
        val done = when(identity.kind) {
            "source-item" -> context.localSources().acknowledgeExact(identity)
            "file" -> context.localSources().sources().singleOrNull { it.id==identity.sourceId && it.enabled }?.let { context.fileArchives().acknowledgeExact(it,identity,receipt.captureId) } ?: false
            "attachment" -> context.recordDraftStore().acknowledgeExact(identity,receipt.captureId)
            else -> false
        }
        if(done) store.completed(identity.key)
        return done
    }
}
