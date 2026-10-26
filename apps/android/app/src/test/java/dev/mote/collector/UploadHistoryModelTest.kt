package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.UUID

class UploadHistoryModelTest {
    private fun event() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", "generated-device").put("source", "note").put("capturedAt", "2026-10-26T00:00:00Z").put("ocrText", "Generated original")
    @Test fun retriesNeverBecomeExtraItemsAndValidPartialCountsRemainVisible() {
        val batch = UUID.randomUUID().toString(); val first = event(); val second = event()
        val attempt = CaptureUploadAttempt.create(batch, "scope", "process", listOf(first, second), 10, 1000)
        val retry = attempt.copy(id = UUID.randomUUID().toString(), state = "partial", results = JSONObject().put(first.getString("id"), 201))
        val result = UploadHistoryModel.batches(listOf(attempt.copy(state = "unknown"), retry), emptyList()).single()
        assertEquals(2, result.items.size); assertEquals(1, result.received); assertEquals(1, result.unconfirmed)
        assertEquals(2, result.attempts.size)
        assertEquals(1, UploadHistoryModel.filter(listOf(result), 1).size)
        assertEquals(1, UploadHistoryModel.filter(listOf(result), 2).size)
    }
    @Test fun exactReceiptAndAttemptShareOneItemButDifferentVersionsRemainDistinct() {
        val batch = UUID.randomUUID().toString(); val original = event()
        val receipt = CaptureUploadReceipt.create("https://generated.example", "generated-device", original, original, batch, 2000, 30)
        val attempt = CaptureUploadAttempt.create(batch, receipt.scope, "process", listOf(original), 10, 1000)
        val changed = JSONObject(original.toString()).put("ocrText", "Generated changed version")
        val later = CaptureUploadAttempt.create(batch, receipt.scope, "process", listOf(changed), 20, 3000)
        val result = UploadHistoryModel.batches(listOf(attempt, later), listOf(receipt)).single()
        assertEquals(2, result.items.size); assertEquals(1, result.received); assertEquals(1, result.unconfirmed)
        assertEquals(3000L, result.at)
    }
    @Test fun batchesKeepAllRequestsAndUseLocalDateAcrossMidnight() {
        val event = event(); val first = CaptureUploadAttempt.create(UUID.randomUUID().toString(), "scope", "process", listOf(event), 10, 1800000000000)
        val second = CaptureUploadAttempt.create(UUID.randomUUID().toString(), "scope", "process", listOf(event), 10, 1800000000001)
        val rows = UploadHistoryModel.batches(listOf(first, second, first.copy(id = UUID.randomUUID().toString())), emptyList())
        assertEquals(listOf(second.batchId, first.batchId), rows.map { it.id })
        assertEquals(2, rows.last().attempts.size)
        assertNotEquals(rows.first().date(ZoneId.of("Pacific/Honolulu")), rows.first().date(ZoneId.of("Pacific/Kiritimati")))
        assertTrue(UploadHistoryModel.filter(rows, 1).isEmpty()); assertEquals(2, UploadHistoryModel.filter(rows, 2).size)
    }
}
