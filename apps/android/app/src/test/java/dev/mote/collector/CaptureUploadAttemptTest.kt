package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CaptureUploadAttemptTest {
    private val batch = UUID.randomUUID().toString()
    private val events = (0 until 4).map { JSONObject().put("id", UUID.randomUUID().toString()).put("ocrText", "Generated private text $it") }
    private class Store : CaptureAttemptStore {
        val rows = linkedMapOf<String, CaptureUploadAttempt>()
        var refuse = false
        override fun saveAttempt(attempt: CaptureUploadAttempt) { check(!refuse); rows[attempt.id] = attempt }
    }
    private fun receipt(id: String) = JSONObject().put("id", id).put("status", 201).put("receipt", JSONObject()
        .put("id", id).put("version", 2).put("kind", "capture").put("state", "received").put("duplicate", false))
    @Test fun unrecordableAttemptNeverStartsNetworkTraffic() {
        val store = Store().apply { refuse = true }; var requests = 0
        assertThrows(IllegalStateException::class.java) { CaptureUploadAttempts(store, batch, "scope", "process").send(events, 30, false) { requests++; 503 to null } }
        assertEquals(0, requests)
    }
    @Test fun lostAcknowledgementAndRetryAreSeparateAttemptsWithOneBatchAndNoOriginalContent() {
        val store = Store(); val sender = CaptureUploadAttempts(store, batch, "scope", "process")
        assertThrows(java.io.IOException::class.java) { sender.send(events.take(1), 30, true) { throw java.io.IOException("Generated lost ACK") } }
        sender.send(events.take(1), 30, true) { 201 to receipt(events[0].getString("id")).apply { remove("status") } }
        assertEquals(2, store.rows.size); assertEquals(listOf("unknown", "received"), store.rows.values.map { it.state })
        assertEquals(setOf(batch), store.rows.values.map { it.batchId }.toSet())
        assertEquals(1, store.rows.values.last().acknowledged)
        assertFalse(store.rows.values.any { it.json().toString().contains("Generated private text") })
    }
    @Test fun partialValidAcknowledgementIsDistinctFromRejectedAndUnknownResponses() {
        val store = Store(); val sender = CaptureUploadAttempts(store, batch, "scope", "process")
        sender.send(events, 30, false) { 200 to JSONObject().put("results", JSONArray().put(receipt(events[0].getString("id")))) }
        assertEquals("partial", store.rows.values.last().state); assertEquals(1, store.rows.values.last().acknowledged)
        assertEquals(201, store.rows.values.last().results.getInt(events[0].getString("id")))
        sender.send(events, 30, false) { 401 to JSONObject().put("error", "unauthorized") }
        assertEquals("unknown", store.rows.values.last().state); assertEquals(401, store.rows.values.last().status)
        sender.send(events, 30, false) { 503 to JSONObject().put("error", "response_unavailable") }
        assertEquals("unknown", store.rows.values.last().state); assertEquals(0, store.rows.values.last().acknowledged)
        sender.send(events, 30, false) { 200 to JSONObject().put("results", JSONArray()) }
        assertEquals("unknown", store.rows.values.last().state); assertEquals(0, store.rows.values.last().acknowledged)
    }
    @Test fun foreignOrDuplicateReceiptMakesWholeRequestUnknownWithoutAnyAcknowledgedCount() {
        val store = Store(); val sender = CaptureUploadAttempts(store, batch, "scope", "process")
        for (results in listOf(JSONArray().put(receipt(events[0].getString("id"))).put(receipt(UUID.randomUUID().toString())),
            JSONArray().put(receipt(events[0].getString("id"))).put(receipt(events[0].getString("id"))))) {
            assertThrows(IllegalArgumentException::class.java) { sender.send(events, 30, false) { 200 to JSONObject().put("results", results) } }
            assertEquals("unknown", store.rows.values.last().state); assertEquals(0, store.rows.values.last().acknowledged)
        }
    }
    @Test fun sizeNegotiationHasOneAttemptPerActualRequestAndNeverInfersReceivedFromHttp200() {
        val store = Store(); val sender = CaptureUploadAttempts(store, batch, "scope", "process")
        UploadNegotiation.sendShrinking(events) { selected -> sender.send(selected, selected.size.toLong(), false) {
            if (selected.size > 1) 413 to null else 200 to JSONObject().put("results", JSONArray().put(receipt(selected.single().getString("id"))))
        } }
        assertEquals(listOf(4, 2, 1), store.rows.values.map { it.captures.length() })
        assertEquals(listOf("rejected", "rejected", "received"), store.rows.values.map { it.state })
        assertEquals(3, store.rows.values.map { it.id }.toSet().size)
        assertThrows(IllegalArgumentException::class.java) { sender.send(events.take(1), 30, true) { 200 to JSONObject().put("id", events[0].getString("id")) } }
        assertEquals("unknown", store.rows.values.last().state)
    }
}
