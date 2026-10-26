package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.UUID

class UploadHistoryModelTest {
    @Test fun itemPhasesAndCaptureRequestsShareBatchButNeverInflateConfirmedCount() {
        val batch=UUID.randomUUID().toString(); val capture=event()
        val original=UploadHistoryModel.batches(listOf(CaptureUploadAttempt.create(batch,"scope","process",listOf(capture),10,1000)),emptyList())
        val identity=ItemUploadIdentity("file","scope","source","https://generated.example","device","target","source","external","revision","fingerprint")
        val attempt=ItemUploadAttempt(UUID.randomUUID().toString(),batch,"process",identity,"manifest",1100,100,state="transferred")
        val phase=attempt.copy(id=UUID.randomUUID().toString(),phase="part")
        val commit=attempt.copy(id=UUID.randomUUID().toString(),phase="commit",state="received")
        val receipt=ItemUploadReceipt(identity,batch,UUID.randomUUID().toString(),1200)
        val rows=UploadHistoryModel.merge(original,listOf(attempt,phase,commit),listOf(receipt))
        assertEquals(2,rows.single().items.size); assertEquals(1,rows.single().received); assertEquals(3,rows.single().itemAttempts.size)
        val retry=attempt.copy(id=UUID.randomUUID().toString(),batchId=UUID.randomUUID().toString(),state="unknown")
        val replay=UploadHistoryModel.merge(original,listOf(attempt,phase,commit,retry),listOf(receipt))
        assertEquals(0,replay.single { it.id==retry.batchId }.received)
        assertEquals(receipt.captureId,replay.single { it.id==retry.batchId }.items.single().captureId)
    }
    @Test fun originalReaderDoesNotOfferUnavailableOrWrongBinaryOriginal() {
        val identity=ItemUploadIdentity("file","scope","source","https://generated.example","device","target","source","external","revision","fingerprint","hash",3)
        val id=UUID.randomUUID().toString(); val file=JSONObject().put("captureId",id).put("sourceId","source").put("item",JSONObject().put("externalId","external").put("revision","revision")).put("hasOriginal",true).put("sha256","hash").put("sizeBytes",3)
        HistoryOriginal.verifyFile(identity,id,file)
        assertThrows(IllegalStateException::class.java) { HistoryOriginal.verifyFile(identity,id,JSONObject(file.toString()).put("hasOriginal",false)) }
        assertThrows(IllegalStateException::class.java) { HistoryOriginal.verifyFile(identity,id,JSONObject(file.toString()).put("sha256","changed")) }
    }
    @Test fun originalReaderRejectsNewRevisionAndWrongCentralIdentity() {
        val body=JSONObject().put("externalId","external").put("revision","first").put("text","Generated old")
        val identity=ItemUploadIdentity("source-item","scope","source","https://generated.example","device","target","source","external","first",SourceRules.hash(SourceRules.canonical(body)))
        val state=JSONObject().put("current",JSONObject().put("external",JSONObject().put("body",body)))
        assertEquals("Generated old",HistoryOriginal.exactBody(identity,state)!!.getString("text"))
        body.put("revision","second").put("text","Generated new")
        assertNull(HistoryOriginal.exactBody(identity,state))
        val id=UUID.randomUUID().toString()
        val remote=JSONObject().put("id",id).put("deviceId","device").put("provenance",JSONObject().put("sourceId","source").put("externalId","external").put("revision","first"))
        HistoryOriginal.verify(identity,id,remote)
        remote.getJSONObject("provenance").put("revision","second")
        assertThrows(IllegalStateException::class.java) { HistoryOriginal.verify(identity,id,remote) }
    }
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
        assertEquals(receipt.queueVersion, result.items.single { it.received }.originalVersion)
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
