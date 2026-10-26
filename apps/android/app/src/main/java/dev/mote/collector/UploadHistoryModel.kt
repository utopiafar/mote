package dev.mote.collector

import android.content.Context
import java.time.Instant
import java.time.ZoneId

internal data class HistoryItem(val key: String, val captureId: String, val received: Boolean, val originalVersion: String, val identity: ItemUploadIdentity? = null)
internal data class HistoryBatch(val id: String, val at: Long, val attempts: List<CaptureUploadAttempt>, val items: List<HistoryItem>, val itemAttempts: List<ItemUploadAttempt> = emptyList()) {
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
                items[key] = HistoryItem(key, id, received || items[key]?.received == true, item.getString("queueVersion"))
            } }
            confirmed.forEach { receipt ->
                val key = receipt.captureId + ":" + receipt.transportVersion
                items[key] = HistoryItem(key, receipt.captureId, true, receipt.queueVersion)
            }
            HistoryBatch(batch, (sent.map { it.startedAt } + confirmed.map { it.receivedAt }).max(), sent.sortedBy { it.startedAt }, items.values.toList())
        }.sortedWith(compareByDescending<HistoryBatch> { it.at }.thenBy { it.id })
    }
    fun merge(captures: List<HistoryBatch>, attempts: List<ItemUploadAttempt>, receipts: List<ItemUploadReceipt>): List<HistoryBatch> {
        val ids = (captures.map { it.id } + attempts.map { it.batchId } + receipts.map { it.batchId }).toSet()
        return ids.map { id ->
            val base = captures.singleOrNull { it.id == id }
            val sent = attempts.filter { it.batchId == id }.sortedBy { it.startedAt }
            val received = receipts.filter { it.batchId == id }
            val items = linkedMapOf<String, HistoryItem>()
            base?.items?.forEach { items[it.key] = it }
            sent.forEach { attempt ->
                val identity = attempt.identity
                val receipt = receipts.singleOrNull { it.identity.key == identity.key }
                items[identity.key] = HistoryItem(identity.key, receipt?.captureId.orEmpty(), attempt.state == "received" || items[identity.key]?.received == true,
                    identity.revision, identity)
            }
            received.forEach { receipt -> items[receipt.identity.key] = HistoryItem(receipt.identity.key, receipt.captureId, true, receipt.identity.revision, receipt.identity) }
            HistoryBatch(id, (listOfNotNull(base?.at) + sent.map { it.startedAt } + received.map { it.receivedAt }).max(), base?.attempts.orEmpty(), items.values.toList(), sent)
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
        val itemStore = context.itemUploadHistory()
        val itemAttempts = mutableListOf<ItemUploadAttempt>(); cursor = null
        do { val page = itemStore.attempts(scope, cursor, 100, days); itemAttempts.addAll(page)
            cursor = page.lastOrNull()?.let { it.startedAt to it.id }
        } while (page.size == 100)
        val itemReceipts = mutableListOf<ItemUploadReceipt>(); cursor = null
        do { val page = itemStore.receipts(scope, cursor, 100, days); itemReceipts.addAll(page)
            cursor = page.lastOrNull()?.let { it.receivedAt to it.identity.key }
        } while (page.size == 100)
        return merge(batches(attempts, receipts), itemAttempts, itemReceipts)
    }
    fun filter(batches: List<HistoryBatch>, result: Int) = batches.filter { when (result) { 1 -> it.received > 0; 2 -> it.unconfirmed > 0; else -> true } }
}
