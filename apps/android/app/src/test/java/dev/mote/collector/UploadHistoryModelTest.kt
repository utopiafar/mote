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
    @Test fun tenThousandBatchesMatchTheOldAssemblyWithDuplicatesOrphansAndRetries() {
        val attempts = mutableListOf<CaptureUploadAttempt>()
        val receipts = mutableListOf<CaptureUploadReceipt>()
        val itemAttempts = mutableListOf<ItemUploadAttempt>()
        val itemReceipts = mutableListOf<ItemUploadReceipt>()
        val scope = CaptureUploadReceipt.scope("https://generated.example", "generated-device")
        repeat(10_000) { index ->
            val batch = UUID.randomUUID().toString()
            val capture = event().put("ocrText", "Generated original $index")
            val attempt = CaptureUploadAttempt.create(batch, scope, "generated-process", listOf(capture), 128, 1_000L + index % 17)
            attempts += attempt
            receipts += CaptureUploadReceipt.create("https://generated.example", "generated-device", capture, capture, batch, 2_000L + index % 23, 30)
            val identity = ItemUploadIdentity("file", scope, "source", "https://generated.example", "generated-device", "generated-target", "generated-source", "generated-$index", "revision-$index", "fingerprint-$index")
            val item = ItemUploadAttempt(UUID.randomUUID().toString(), batch, "generated-process", identity, "manifest", 3_000L + index % 13, 64, state = if (index % 3 == 0) "received" else "transferred")
            itemAttempts += item
            itemReceipts += ItemUploadReceipt(identity, batch, UUID.randomUUID().toString(), 4_000L + index % 19)
            if (index % 97 == 0) {
                attempts += attempt.copy(id = UUID.randomUUID().toString(), startedAt = attempt.startedAt - 1, results = JSONObject().put(capture.getString("id"), 201))
                itemAttempts += item.copy(id = UUID.randomUUID().toString(), phase = "part", startedAt = item.startedAt - 1)
                itemAttempts += item.copy(id = UUID.randomUUID().toString(), phase = "commit", state = "received")
            }
        }
        // Receipt-only capture and item batches remain visible, as do an attempt
        // whose exact identity has conflicting receipts in two other batches.
        val orphan = event()
        receipts += CaptureUploadReceipt.create("https://generated.example", "generated-device", orphan, orphan, UUID.randomUUID().toString(), 5_000, 0)
        val ambiguous = itemReceipts[11]
        itemReceipts += ambiguous.copy(batchId = UUID.randomUUID().toString(), captureId = UUID.randomUUID().toString(), receivedAt = 5_100)
        val unconfirmed = itemAttempts.first { it.identity == ambiguous.identity }.copy(id = UUID.randomUUID().toString(), batchId = UUID.randomUUID().toString(), state = "unknown")
        itemAttempts += unconfirmed
        val onlyReceipt = itemReceipts[17].copy(identity = itemReceipts[17].identity.copy(externalId = "generated-orphan"), batchId = UUID.randomUUID().toString(), captureId = UUID.randomUUID().toString(), receivedAt = 5_200)
        itemReceipts += onlyReceipt
        val expectedCaptures = referenceBatches(attempts, receipts)
        val captures = UploadHistoryModel.batches(attempts, receipts)
        assertEquals(expectedCaptures.size, captures.size)
        expectedCaptures.indices.forEach { assertEquals("capture batch $it", expectedCaptures[it], captures[it]) }
        val duplicate = captures[19]
        val inputs = captures + duplicate.copy(items = listOf(HistoryItem("generated-ambiguous-base", "generated-base", true, "generated-version")))
        val expected = referenceMerge(inputs, itemAttempts, itemReceipts)
        val actual = UploadHistoryModel.merge(inputs, itemAttempts, itemReceipts)
        assertTrue("the full 10,000 primary batches plus edge cases are retained", actual.size >= 10_000)
        assertEquals(expected.size, actual.size)
        expected.indices.forEach { assertEquals("merged batch $it", expected[it], actual[it]) }
        assertEquals("a duplicated capture batch has no unique base", 1, actual.single { it.id == duplicate.id }.items.size)
        val ambiguousItem = actual.single { it.id == unconfirmed.batchId }.items.single()
        assertEquals("two receipts for an identity are not a single locator", "", ambiguousItem.captureId)
        assertFalse(ambiguousItem.received)
        assertEquals(onlyReceipt.captureId, actual.single { it.id == onlyReceipt.batchId }.items.single().captureId)
    }

    private fun referenceBatches(attempts: List<CaptureUploadAttempt>, receipts: List<CaptureUploadReceipt>): List<HistoryBatch> {
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
    private fun referenceMerge(captures: List<HistoryBatch>, attempts: List<ItemUploadAttempt>, receipts: List<ItemUploadReceipt>): List<HistoryBatch> {
        // Cache only the pure serialized identity key; retain the old per-batch
        // filters and global singleOrNull scans at the full 10,000-batch scale.
        val receiptKeys = java.util.IdentityHashMap<ItemUploadReceipt, String>()
        receipts.forEach { receiptKeys[it] = it.identity.key }
        val ids = (captures.map { it.id } + attempts.map { it.batchId } + receipts.map { it.batchId }).toSet()
        return ids.map { id ->
            val base = captures.singleOrNull { it.id == id }
            val sent = attempts.filter { it.batchId == id }.sortedBy { it.startedAt }
            val received = receipts.filter { it.batchId == id }
            val items = linkedMapOf<String, HistoryItem>()
            base?.items?.forEach { items[it.key] = it }
            sent.forEach { attempt ->
                val identity = attempt.identity
                val identityKey = identity.key
                val receipt = receipts.singleOrNull { receiptKeys[it] == identityKey }
                items[identityKey] = HistoryItem(identityKey, receipt?.captureId.orEmpty(), attempt.state == "received" || items[identityKey]?.received == true,
                    identity.revision, identity)
            }
            received.forEach { receipt -> items[receipt.identity.key] = HistoryItem(receipt.identity.key, receipt.captureId, true, receipt.identity.revision, receipt.identity) }
            HistoryBatch(id, (listOfNotNull(base?.at) + sent.map { it.startedAt } + received.map { it.receivedAt }).max(), base?.attempts.orEmpty(), items.values.toList(), sent)
        }.sortedWith(compareByDescending<HistoryBatch> { it.at }.thenBy { it.id })
    }
}
