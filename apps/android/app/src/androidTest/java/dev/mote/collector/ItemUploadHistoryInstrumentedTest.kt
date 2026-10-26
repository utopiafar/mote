package dev.mote.collector

import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID

class ItemUploadHistoryInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val now=1_800_000_000_000L
    private fun identity()=ItemUploadIdentity("file","generated-scope","source","https://generated-private.example","generated-device","generated-target","generated-source","generated-private-external","revision","fingerprint","a".repeat(64),42)
    private fun fixture(run: (File,ByteCipher)->Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemHistoryFixture")=="true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val dir=File(context.cacheDir,"generated-item-history-${UUID.randomUUID()}").apply { check(mkdirs()) }
        try { run(File(dir,"history.sqlite"),context.secretBox()) } finally { dir.deleteRecursively() }
    }
    @Test fun tiedTimestampPaginationKeepsAllItemsAndSeparatesOrigins()=fixture { file,cipher ->
        val store=ItemUploadHistory(file,cipher); val base=identity(); val batch=UUID.randomUUID().toString()
        repeat(123) { n -> store.received(ItemUploadReceipt(base.copy(externalId="generated-$n"),batch,UUID.randomUUID().toString(),now)) }
        store.received(ItemUploadReceipt(base.copy(scope="other-scope"),batch,UUID.randomUUID().toString(),now))
        val loaded=mutableListOf<ItemUploadReceipt>(); var cursor:Pair<Long,String>?=null
        do { val page=store.receipts(base.scope,cursor,50,now=now);loaded.addAll(page);cursor=page.lastOrNull()?.let { it.receivedAt to it.identity.key } } while(page.size==50)
        assertEquals(123,loaded.size);assertEquals(123,loaded.map { it.identity.key }.toSet().size)
    }
    @Test fun firstReceiptAndPendingCompletionSurviveReopenWithoutPrivatePlaintext()=fixture { file,cipher ->
        val i=identity(); val first=ItemUploadReceipt(i,UUID.randomUUID().toString(),UUID.randomUUID().toString(),now)
        ItemUploadHistory(file,cipher).received(first)
        val reopened=ItemUploadHistory(file,cipher)
        val replay=reopened.received(first.copy(batchId=UUID.randomUUID().toString(),receivedAt=now+1000))
        assertEquals(now,replay.receivedAt); assertEquals(1,reopened.receipts(i.scope,now=now+1000).size)
        assertEquals(1,reopened.pending(i.scope,i.lane).size)
        assertThrows(UploadHistoryUnavailable::class.java) { reopened.received(first.copy(captureId=UUID.randomUUID().toString())) }
        assertEquals(first.captureId,reopened.pending(i.scope,i.lane).single().captureId)
        assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains("generated-private"))
        reopened.completed(i.key); assertTrue(reopened.pending(i.scope,i.lane).isEmpty())
    }
    @Test fun failedSecondWriteRollsBackReceiptAndCompletion()=fixture { file,cipher ->
        var seals=0; val failing=object:ByteCipher {
            override fun seal(bytes:ByteArray):ByteArray { if(++seals==2) throw java.io.IOException("Generated interrupted metadata write"); return cipher.seal(bytes) }
            override fun open(bytes:ByteArray)=cipher.open(bytes)
        }
        val i=identity(); val receipt=ItemUploadReceipt(i,UUID.randomUUID().toString(),UUID.randomUUID().toString(),now)
        assertThrows(UploadHistoryUnavailable::class.java) { ItemUploadHistory(file,failing).received(receipt) }
        val reopened=ItemUploadHistory(file,cipher)
        assertTrue(reopened.receipts(i.scope,now=now).isEmpty()); assertTrue(reopened.pending(i.scope,i.lane).isEmpty())
        reopened.received(receipt); assertEquals(1,reopened.pending(i.scope,i.lane).size)
    }
    @Test fun expiryDoesNotEraseMarkerOrResurrectReceiptOnReplay()=fixture { file,cipher ->
        val i=identity(); val receipt=ItemUploadReceipt(i,UUID.randomUUID().toString(),UUID.randomUUID().toString(),now-31*86_400_000L)
        val store=ItemUploadHistory(file,cipher); store.received(receipt)
        assertEquals(1,store.prune(30,now)); assertEquals(1,store.pending(i.scope,i.lane).size)
        assertEquals(receipt.receivedAt,store.received(receipt.copy(receivedAt=now)).receivedAt)
        assertTrue(store.receipts(i.scope,days=365,now=now).isEmpty())
        assertEquals(1,store.pending(i.scope,i.lane).size)
    }
    @Test fun processRecoveryDoesNotInterruptOtherLaneOrCurrentProcess()=fixture { file,cipher ->
        val store=ItemUploadHistory(file,cipher); val i=identity(); val batch=UUID.randomUUID().toString()
        val old=ItemUploadAttempt(UUID.randomUUID().toString(),batch,"old",i,"manifest",now,10)
        val active=old.copy(id=UUID.randomUUID().toString(),process="current")
        val other=old.copy(id=UUID.randomUUID().toString(),identity=i.copy(kind="attachment",lane="capture"))
        listOf(old,active,other).forEach(store::save); store.recoverInterrupted(i.scope,"source","current")
        var rows=store.attempts(i.scope,now=now)
        assertEquals("unknown",rows.single { it.id==old.id }.state)
        assertEquals("sending",rows.single { it.id==active.id }.state)
        assertEquals("sending",rows.single { it.id==other.id }.state)
        store.recoverInterrupted(i.scope,"source","current",true); rows=store.attempts(i.scope,now=now)
        assertEquals("unknown",rows.single { it.id==active.id }.state)
        assertEquals("sending",rows.single { it.id==other.id }.state)
    }
}
