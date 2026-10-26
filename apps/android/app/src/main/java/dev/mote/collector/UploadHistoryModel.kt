package dev.mote.collector

import android.content.Context
import java.time.Instant
import java.time.ZoneId

internal data class HistoryItem(val key: String, val captureId: String, val received: Boolean, val originalVersion: String)
internal data class HistoryBatch(val id: String, val at: Long, val attempts: List<CaptureUploadAttempt>, val items: List<HistoryItem>) {
    val received get() = items.count { it.received }
    val unconfirmed get() = items.size - received
    fun date(zone: ZoneId) = Instant.ofEpochMilli(at).atZone(zone).toLocalDate().toString()
}
internal object UploadHistoryModel {
    fun batches(attempts: List<CaptureUploadAttempt>, receipts: List<CaptureUploadReceipt>): List<HistoryBatch> {
        val ids = (attempts.map { it.batchId } + receipts.map { it.batchId }).toSet()
        return ids.map { batch ->
            val sent = attempts.filter { it.batchId == batch }
            val confirmed = receipts.filter { it.batchId == batch }
            val items = linkedMapOf<String, HistoryItem>()
            sent.forEach { attempt -> for (i in 0 until attempt.captures.length()) {
                val item = attempt.captures.getJSONObject(i); val id = item.getString("id")
                val key = id + ":" + item.getString("version")
                val received = attempt.results.optInt(id) in setOf(200, 201)
                items[key] = HistoryItem(key, id, received || items[key]?.received == true, item.getString("version"))
            } }
            confirmed.forEach { receipt ->
                val key = receipt.captureId + ":" + receipt.transportVersion
                items[key] = HistoryItem(key, receipt.captureId, true, receipt.queueVersion)
            }
            HistoryBatch(batch, (sent.map { it.startedAt } + confirmed.map { it.receivedAt }).max(), sent.sortedBy { it.startedAt }, items.values.toList())
        }.sortedWith(compareByDescending<HistoryBatch> { it.at }.thenBy { it.id })
    }
    fun read(context: Context): List<HistoryBatch> {
        val settings = Settings(context); val config = settings.read()
        if (config.server.isBlank()) return emptyList()
        val scope = CaptureUploadReceipt.scope(config.server, settings.deviceId)
        val store = context.captureUploadHistory(); val days = UploadHistoryRetention.read(context)
        val attempts = mutableListOf<CaptureUploadAttempt>(); var cursor: Pair<Long, String>? = null
        do { val page = store.attempts(scope, cursor, 100, days); attempts.addAll(page)
            cursor = page.lastOrNull()?.let { it.startedAt to it.id }
        } while (page.size == 100)
        val receipts = mutableListOf<CaptureUploadReceipt>(); cursor = null
        do { val page = store.page(scope, cursor, 100, days); receipts.addAll(page)
            cursor = page.lastOrNull()?.let { it.receivedAt to it.itemKey }
        } while (page.size == 100)
        return batches(attempts, receipts)
    }
    fun filter(batches: List<HistoryBatch>, result: Int) = batches.filter { when (result) { 1 -> it.received > 0; 2 -> it.unconfirmed > 0; else -> true } }
}
