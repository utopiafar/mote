package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Base64
import java.util.UUID

class CaptureUploadReceiptTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = "https://generated.example"
    private val device = UUID.randomUUID().toString()
    private val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun note() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", device).put("source", "note")
        .put("capturedAt", "2026-10-26T00:00:00Z").put("durationMs", 0).put("ocrText", "Generated private original must never enter receipt metadata")
        .put("privacy", JSONObject().put("excluded", false))
    private fun queue() = DurableQueue(folder.newFolder(), cipher).apply { archiveOrigin = origin }
    private fun receipt(original: JSONObject, sent: JSONObject = original, now: Long = 1000, days: Int = 7) =
        CaptureUploadReceipt.create(origin, device, original, sent, UUID.randomUUID().toString(), now, days)
    private class Store : CaptureReceiptStore {
        val rows = linkedMapOf<String, CaptureUploadReceipt>()
        val unfinished = linkedMapOf<String, CaptureUploadCompletion>()
        var failBeforeSave = false
        var stopAfterSave = false
        var failCompletion = false
        override fun received(receipt: CaptureUploadReceipt): CaptureUploadCompletion {
            check(!failBeforeSave)
            val first = rows.getOrPut(receipt.itemKey) { receipt }
            val completion = unfinished.getOrPut(receipt.itemKey) { first.completion() }
            check(!stopAfterSave)
            return completion
        }
        override fun pending(scope: String) = unfinished.values.filter { it.scope == scope }
        override fun completed(itemKey: String) { check(!failCompletion); unfinished.remove(itemKey) }
    }
    @Test fun storageFailureNeverDiscardsAnAcknowledgedOriginalFromOutbox() {
        val queue = queue(); val event = note(); queue.enqueue(event, null, 100000)
        val store = Store().apply { failBeforeSave = true }
        assertThrows(IllegalStateException::class.java) { CaptureReceiptFinalizer(store).received(queue, receipt(event, days = 0)) }
        assertEquals(event.getString("id"), queue.peek()!!.getString("id")); assertTrue(store.rows.isEmpty())
    }
    @Test fun restartAfterDurableReceiptCompletesExactlyOnceUsingFirstConfirmationTime() {
        val queue = queue(); val event = note(); queue.enqueue(event, null, 100000)
        val store = Store().apply { stopAfterSave = true }
        val first = receipt(event, now = 1000)
        assertThrows(IllegalStateException::class.java) { CaptureReceiptFinalizer(store).received(queue, first) }
        assertNotNull(queue.peek()); assertEquals(1, store.unfinished.size)
        store.stopAfterSave = false
        CaptureReceiptFinalizer(store).recover(queue, first.scope)
        assertEquals(0, queue.pendingSync().count); assertEquals(0, store.unfinished.size)
        val retained = queue.capture(event.getString("id"))!!
        assertEquals(1000 + 7 * 86_400_000L, retained.getLong("retainedUntil"))
        CaptureReceiptFinalizer(store).received(queue, receipt(event, now = 50000))
        assertEquals(1, store.rows.size); assertEquals(1000, store.rows.values.single().receivedAt)
        assertEquals(retained.toString(), queue.capture(event.getString("id"))!!.toString())
    }
    @Test fun restartAfterQueueCompletionDoesNotRepeatDeletionOrOperationCount() {
        val ids = mutableListOf<String>(); val queue = DurableQueue(folder.newFolder(), cipher, onChange = { kind, _, id -> if (kind == OperationKind.NOTE_ACK) ids.add(id) }).apply { archiveOrigin = origin }
        val event = note(); queue.enqueue(event, null, 100000)
        val store = Store().apply { failCompletion = true }; val confirmed = receipt(event, days = 0)
        assertThrows(IllegalStateException::class.java) { CaptureReceiptFinalizer(store).received(queue, confirmed) }
        assertNull(queue.capture(event.getString("id"))); assertEquals(listOf(event.getString("id")), ids)
        store.failCompletion = false
        CaptureReceiptFinalizer(store).recover(queue, confirmed.scope)
        assertEquals(1, ids.size); assertTrue(store.unfinished.isEmpty())
    }
    @Test fun olderStateSeriesReceiptCannotClearNewObservationsAfterProcessRestart() {
        fun activity(at: String) = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", device).put("source", "activity").put("appId", "generated.app").put("appName", "Generated")
            .put("capturedAt", at).put("durationMs", 5000).put("privacy", JSONObject().put("excluded", false).put("collection", "activity"))
        val queue = queue(); queue.enqueue(activity("2026-10-26T00:00:00Z"), null, 100000)
        val selected = queue.peek()!!; val confirmed = receipt(selected)
        val store = Store(); store.received(confirmed)
        queue.enqueue(activity("2026-10-26T00:00:05Z"), null, 100000)
        CaptureReceiptFinalizer(store).recover(queue, confirmed.scope)
        assertEquals(1, queue.pendingSync().count)
        assertEquals(2, queue.peek()!!.getJSONObject("stateSeries").getJSONArray("samples").length())
        assertTrue(store.unfinished.isEmpty())
        val next = queue.peek()!!; CaptureReceiptFinalizer(store).received(queue, receipt(next))
        assertEquals(0, queue.pendingSync().count); assertEquals(2, store.rows.size)
    }
    @Test fun sameIdAndSampleCountWithChangedBodyCannotUseAnOlderConfirmation() {
        val queue = queue(); val event = note(); queue.enqueue(event, null, 100000)
        val altered = JSONObject(event.toString()).put("ocrText", "Different exact body")
        assertFalse(queue.acknowledgeReceivedVersion(event.getString("id"), CaptureUploadVersion.of(altered), origin, 1, 0, 1000))
        assertNotNull(queue.peek())
        assertFalse(queue.acknowledgeReceivedVersion(event.getString("id"), CaptureUploadVersion.of(event), "https://other.example", 1, 0, 1000))
        assertNotNull(queue.peek())
    }
    @Test fun imageBodyAndStoredBlobHaveSameVersionWhileNewImageDoesNot() {
        val original = note(); val bytes = "Generated image bytes".toByteArray()
        val sent = JSONObject(original.toString()).put("imageBase64", Base64.getEncoder().encodeToString(bytes))
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val stored = JSONObject(original.toString()).put("_blob", hash).put("_uploaded", true).put("_retainedUntil", 123).put("_archiveOrigin", origin)
        assertEquals(CaptureUploadVersion.of(sent), CaptureUploadVersion.of(stored))
        assertNotEquals(CaptureUploadVersion.of(sent), CaptureUploadVersion.of(JSONObject(sent.toString()).put("imageBase64", Base64.getEncoder().encodeToString("Different".toByteArray()))))
    }
    @Test fun receiptContainsOnlyLocatorsAndSendingFactsNotOriginalTextOrModelData() {
        val event = note(); val prepared = JSONObject(event.toString()).apply { put("metadata", JSONObject().put("attachments", org.json.JSONArray().put(UUID.randomUUID().toString()))) }
        val confirmed = receipt(event, prepared)
        assertFalse(confirmed.json().toString().contains(event.getString("ocrText")))
        assertFalse(confirmed.json().has("metadata")); assertFalse(confirmed.json().has("imageBase64"))
        assertNotEquals(confirmed.transportVersion, confirmed.queueVersion)
        assertEquals(confirmed, CaptureUploadReceipt.parse(confirmed.json()))
        assertFalse(confirmed.completion().json().has("capturedAt")); assertFalse(confirmed.completion().json().has("source")); assertFalse(confirmed.completion().json().has("batchId"))
    }
    @Test fun tokenRotationDoesNotChangeScopeButAnotherDeviceOrOriginDoes() {
        val event = note(); val a = receipt(event); val b = receipt(event, now = 3000)
        assertEquals(a.itemKey, b.itemKey); assertEquals(a.scope, b.scope)
        assertNotEquals(a.scope, CaptureUploadReceipt.scope(origin, UUID.randomUUID().toString()))
        assertNotEquals(a.scope, CaptureUploadReceipt.scope("https://other.example", device))
        assertEquals(a.scope, CaptureUploadReceipt.scope("$origin/", device))
        assertEquals(a.scope, CaptureUploadReceipt.scope("https://GENERATED.example:443/", device))
    }
    @Test fun historyRetentionIsIndependentAndHasBoundedExplicitChoices() {
        assertEquals(30, UploadHistoryRetention.DEFAULT_DAYS)
        listOf(7, 30, 90, 365).forEach(UploadHistoryRetention::validate)
        listOf(0, -1, 366).forEach { days -> assertThrows(IllegalArgumentException::class.java) { UploadHistoryRetention.validate(days) } }
    }
}
