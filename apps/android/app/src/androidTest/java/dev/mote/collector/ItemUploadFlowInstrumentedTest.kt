package dev.mote.collector

import android.os.Build
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.UUID
import java.io.ByteArrayInputStream

class ItemUploadFlowInstrumentedTest {
    @Test fun failedAttachmentNoteOpensOriginalThroughIntegratedLibraryReader() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemCaptureReaderFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val instrumentation=InstrumentationRegistry.getInstrumentation()
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context);settings.saveConnection("http://127.0.0.1:47890","generated-item-history-fixture-token","Generated reader",true)
        settings.save(settings.read().copy(syncMode="manual"))
        val original=JSONObject().put("id",UUID.randomUUID().toString()).put("deviceId",settings.deviceId).put("source","note").put("capturedAt","2026-10-26T00:00:00Z").put("durationMs",0).put("ocrText","Generated failed attachment original").put("privacy",JSONObject().put("excluded",false))
        context.queue().enqueue(original,null,100000)
        val outgoing=JSONObject(original.toString()).put("metadata",JSONObject().put("attachments",JSONArray().put(UUID.randomUUID().toString())))
        val batch=UUID.randomUUID().toString();val scope=CaptureUploadReceipt.scope(settings.read().server,settings.deviceId)
        CaptureUploadAttempts(context.captureUploadHistory(),batch,scope,LoginProcess.id).send(listOf(outgoing),100,true,listOf(original)) { 503 to JSONObject() }
        fun views(v:android.view.View):List<android.view.View> = listOf(v)+if(v is android.view.ViewGroup)(0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
        ActivityScenario.launch<UploadBatchActivity>(Intent(context,UploadBatchActivity::class.java).putExtra("batchId",batch)).use { scenario ->
            var clicked=false;val end=android.os.SystemClock.elapsedRealtime()+10000
            while(!clicked && android.os.SystemClock.elapsedRealtime()<end) { scenario.onActivity { a -> views(a.window.decorView).firstOrNull { it.tag=="history-original-${original.getString("id")}" }?.let { clicked=it.performClick() } };if(!clicked) Thread.sleep(50) };assertTrue(clicked)
            var read=false
            while(!read && android.os.SystemClock.elapsedRealtime()<end) { instrumentation.runOnMainSync {
                val visible=android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filterIsInstance<android.widget.TextView>()
                read=visible.any { it.text.contains("Generated failed attachment original") }
                assertFalse(visible.any { it.text.contains(MoteI18n.text("历史版本不可用：本机原件已更新或清理，不能将当前内容作为这次上传的原文。")) })
            };if(!read) Thread.sleep(50) };assertTrue(read)
            instrumentation.runOnMainSync { androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<CaptureRecordsActivity>().forEach { it.finish() } }
        }
    }
    @Test fun restartRestoresItemsAndOriginalNavigation() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemRestartFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context); val scope=CaptureUploadReceipt.scope(settings.read().server,settings.deviceId)
        val receipts=context.itemUploadHistory().receipts(scope); assertEquals(3,receipts.size)
        val batches=UploadHistoryModel.read(context)
        for(receipt in receipts) {
            val item=batches.single { it.id==receipt.batchId }.items.single { it.key==receipt.identity.key }
            assertTrue(HistoryOriginal.read(context,item).isNotBlank())
            val bytes=java.io.ByteArrayOutputStream(); HistoryOriginal.export(context,item,bytes)
            assertTrue(String(bytes.toByteArray()).startsWith("Generated"))
        }
        val receipt=receipts.single { it.identity.kind=="attachment" }
        ActivityScenario.launch<UploadBatchActivity>(Intent(context,UploadBatchActivity::class.java).putExtra("batchId",receipt.batchId)).use { scenario ->
            fun views(v:android.view.View):List<android.view.View> = listOf(v) + if(v is android.view.ViewGroup)(0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
            var clicked=false; val deadline=android.os.SystemClock.elapsedRealtime()+10000
            while(!clicked && android.os.SystemClock.elapsedRealtime()<deadline) {
                scenario.onActivity { activity -> views(activity.window.decorView).firstOrNull { it.tag=="history-original-${receipt.captureId}" }?.let { clicked=it.performClick() } }
                if(!clicked) Thread.sleep(50)
            }
            assertTrue(clicked)
            var opened=false
            while(!opened && android.os.SystemClock.elapsedRealtime()<deadline) {
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    val activity=androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<UploadOriginalActivity>().singleOrNull()
                    if(activity!=null && views(activity.window.decorView).filterIsInstance<android.widget.TextView>().any { it.text.contains(MoteI18n.text("原件版本已核验，可保存原件。")) }) {
                        val view=activity.window.decorView; val image=android.graphics.Bitmap.createBitmap(view.width,view.height,android.graphics.Bitmap.Config.ARGB_8888);view.draw(android.graphics.Canvas(image))
                        java.io.File(context.filesDir,"generated-item-original-ui.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };image.recycle()
                        activity.finish(); opened=true
                    }
                }
                if(!opened) Thread.sleep(50)
            }
            assertTrue(opened)
        }
    }
    @Test fun originalReaderRecreatesAndReturnsAfterCancelledSave() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemReaderFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val batch=UploadHistoryModel.read(context).first { b -> b.items.any { it.identity?.kind=="attachment" && it.received } };val item=batch.items.first { it.identity?.kind=="attachment" }
        fun views(v:android.view.View):List<android.view.View> = listOf(v) + if(v is android.view.ViewGroup)(0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
        ActivityScenario.launch<UploadOriginalActivity>(Intent(context,UploadOriginalActivity::class.java).putExtra("batchId",batch.id).putExtra("itemKey",item.key)).use { scenario ->
            fun waitReady() { var ready=false;val end=android.os.SystemClock.elapsedRealtime()+10000
                while(!ready && android.os.SystemClock.elapsedRealtime()<end) { scenario.onActivity { a -> ready=views(a.window.decorView).filterIsInstance<android.widget.TextView>().any { it.text.contains(MoteI18n.text("原件版本已核验，可保存原件。")) } };if(!ready) Thread.sleep(50) };assertTrue(ready)
            }
            waitReady();scenario.recreate();waitReady()
            scenario.onActivity { a -> assertTrue(views(a.window.decorView).filterIsInstance<android.widget.Button>().single { it.text==MoteI18n.text("保存原件") }.performClick()) }
            val instrumentation=InstrumentationRegistry.getInstrumentation(); val end=android.os.SystemClock.elapsedRealtime()+10000
            while(instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui")!=true && android.os.SystemClock.elapsedRealtime()<end) Thread.sleep(50)
            assertTrue(instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui")==true)
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);waitReady()
        }
    }
    @Test fun retentionSettingPrunesBothHistoriesWithoutRemovingPendingOriginal() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemRetentionFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context);val config=settings.read();val old=System.currentTimeMillis()-8*86_400_000L
        ConnectionGuard.change(context,config.server) {
        val event=JSONObject().put("id",UUID.randomUUID().toString()).put("deviceId",settings.deviceId).put("source","note").put("capturedAt","2026-10-26T00:00:00Z").put("durationMs",0).put("ocrText","Generated retention original").put("privacy",JSONObject().put("excluded",false))
        context.queue().enqueue(event,null,100000)
        val receipt=CaptureUploadReceipt.create(config.server,settings.deviceId,event,event,UUID.randomUUID().toString(),old,30)
        context.captureUploadHistory().received(receipt)
        val identity=ItemUploadIdentity("file",receipt.scope,"source",config.server,settings.deviceId,SourceRules.target(config.server,config.token),"generated-retention-source","generated-retention-item-${UUID.randomUUID()}","revision","fingerprint")
        context.itemUploadHistory().received(ItemUploadReceipt(identity,UUID.randomUUID().toString(),UUID.randomUUID().toString(),old))
        val draft=context.recordDraftStore().draft().toString()
        UploadHistoryRetention.save(context,7)
        assertFalse(context.captureUploadHistory().page(receipt.scope,days=365).any { it.itemKey==receipt.itemKey })
        assertFalse(context.itemUploadHistory().receipts(receipt.scope,days=365).any { it.identity.key==identity.key })
        assertTrue(context.captureUploadHistory().pending(receipt.scope).any { it.itemKey==receipt.itemKey })
        assertTrue(context.itemUploadHistory().pending(receipt.scope,"source").any { it.identity.key==identity.key })
        assertEquals("Generated retention original",context.queue().capture(event.getString("id"))!!.getString("ocrText"))
        assertEquals(draft,context.recordDraftStore().draft().toString())
        UploadHistoryRetention.save(context,30)
        }
    }
    @Test fun realCentralLostRepliesRecoverFileAttachmentAndSourceWithoutLosingOriginals() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("itemFlowFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context); val base="http://127.0.0.1:47890"; val token="generated-item-history-fixture-token"
        settings.saveConnection(base,token,"Generated history fixture",true)
        settings.save(settings.read().copy(wifiOnly=false,chargingOnly=false,syncMode="manual"))
        val config=settings.read(); val source=LocalSource(name="Generated history source",kind="local-files",uri="content://generated/history",tree=false,retention="archive",syncContinuously=false)
        val sourceStore=context.localSources(); sourceStore.save(source)
        assertEquals(200,HttpJson.post("$base/api/sources",source.registration(settings.deviceId),token).first)
        val bytes="Generated immutable history file".toByteArray()
        val fileItem=JSONObject().put("externalId","generated-file").put("uri","content://generated/file").put("title","generated.txt").put("kind","file").put("layer","original").put("text","").put("mimeType","text/plain").put("observedAt","2026-10-26T00:00:00Z").put("metadata",JSONObject().put("version",1).put("file",JSONObject().put("sizeBytes",bytes.size)))
        val queue=context.fileArchives(); queue.observe(source,fileItem,queue.configure(source).getString("generation"),0)
        val pending=queue.prepare(source,{ByteArrayInputStream(bytes)},{true},captureImmediately=true)!!
        val session=ItemUploadSession(context,config,lane="source")
        assertThrows(FileTransportFailure::class.java) { FileUpload.sync(context,source,config,UploadSlice(),{true},session) }
        assertArrayEquals(bytes,queue.part(source.id,0)); assertNotNull(queue.next(source.id))
        val resumed=ItemUploadSession(context,config,lane="source").also { it.restore() }
        assertTrue(FileUpload.sync(context,source,config,UploadSlice(),{true},resumed))
        assertEquals(0,queue.pendingCount(source.id))
        val history=context.itemUploadHistory(); val scope=CaptureUploadReceipt.scope(base,settings.deviceId)
        val fileReceipt=history.receipts(scope).single { it.identity.kind=="file" }
        assertEquals(pending.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"),fileReceipt.identity.revision)
        assertTrue(history.pending(scope,"source").isEmpty())
        assertTrue(history.attempts(scope).any { it.phase=="commit" && it.state=="unknown" && it.status==503 })
        val store=context.recordDraftStore(); val attachment=store.stage(bytes,"generated.txt","text/plain")
        store.edit("Generated note",JSONArray().put(attachment),JSONObject())
        val note=store.prepare(base) { JSONObject().put("id",UUID.randomUUID().toString()).put("source","note").put("deviceId",settings.deviceId).put("capturedAt","2026-10-26T00:00:00Z").put("ocrText","Generated note") }
        assertThrows(CentralFailure::class.java) { RecordAttachmentSync.prepare(context,config,note,ItemUploadSession(context,config,lane="capture")) }
        assertEquals(0,store.record(note.getString("id"))!!.getJSONObject("acks").length())
        val prepared=RecordAttachmentSync.prepare(context,config,note,ItemUploadSession(context,config,lane="capture").also { it.restore() })
        val attachmentReceipt=history.receipts(scope).single { it.identity.kind=="attachment" }
        assertEquals(attachmentReceipt.captureId,prepared.getJSONObject("metadata").getJSONArray("attachments").getString(0))
        assertArrayEquals(bytes,store.bytes(attachment.getString("id")))
        val again=RecordAttachmentSync.prepare(context,config,note,ItemUploadSession(context,config,lane="capture"))
        assertEquals(prepared.toString(),again.toString()); assertEquals(2,history.receipts(scope).size)
        val sourceBody=JSONObject().put("externalId","generated-record").put("revision","generated-v1").put("title","Generated source").put("kind","file").put("layer","snapshot").put("text","Generated source original").put("observedAt","2026-10-26T00:00:00Z")
        val ordinary=LocalSource(name="Generated ordinary source",kind="local-files",uri="content://generated/ordinary")
        sourceStore.save(ordinary); val target=SourceRules.target(base,token); sourceStore.selectTarget(ordinary.id,target)
        assertEquals(200,HttpJson.post("$base/api/sources",ordinary.registration(settings.deviceId),token).first)
        sourceStore.scan(ordinary,SourceScan(listOf(sourceBody),true,"2026-10-26T00:00:00Z")); val body=sourceStore.next(ordinary.id,target)!!
        val sourceSession=ItemUploadSession(context,config,lane="source"); val identity=sourceSession.identity("source-item",ordinary.id,body)
        fun send()=sourceSession.send(identity,"item",body.toString().toByteArray().size.toLong(),{code,ack->if(code in 200..299 && SourceRules.validAck(ordinary.id,body,ack)) "received" else "unknown"}) { CollectorHttp(context).request("PUT","$base/api/sources/${ordinary.id}/items",body,token) }
        assertEquals(503,send().first); assertNotNull(sourceStore.next(ordinary.id,target))
        val reply=send(); assertTrue(reply.first in 200..299); assertTrue(reply.second!!.getJSONObject("receipt").getBoolean("duplicate"))
        sourceSession.received(identity,reply.second!!.getString("id")); assertNull(sourceStore.next(ordinary.id,target))
        val unavailable=identity.copy(externalId="generated-offline")
        assertThrows(java.io.IOException::class.java) { sourceSession.send(unavailable,"item",10,{_,_->"received"}) { throw java.io.IOException("Generated offline") } }
        assertThrows(SyncConditionsUnavailable::class.java) { sourceSession.send(unavailable,"item",10,{_,_->"received"}) { throw SyncConditionsUnavailable("Generated cancellation") } }
        assertTrue(history.attempts(scope).any { it.state=="cancelled" }); assertEquals(3,history.receipts(scope).size)
        val batch=UploadHistoryModel.read(context).single { it.id==attachmentReceipt.batchId }
        assertEquals(1,batch.received); assertEquals(1,batch.items.size)
        assertTrue(HistoryOriginal.read(context,batch.items.single()).contains(MoteI18n.text("原件版本已核验，可保存原件。")))
        ActivityScenario.launch<UploadBatchActivity>(Intent(context,UploadBatchActivity::class.java).putExtra("batchId",batch.id)).use { scenario ->
            Thread.sleep(800); scenario.recreate(); Thread.sleep(800)
            scenario.onActivity { activity ->
                fun text(v:android.view.View):String=if(v is android.view.ViewGroup)(0 until v.childCount).joinToString { text(v.getChildAt(it)) } else if(v is android.widget.TextView)v.text.toString() else ""
                assertTrue(text(activity.window.decorView).contains(MoteI18n.text("已确认 {0} · 未确认 {1}",1,0)))
            }
        }
    }
}
