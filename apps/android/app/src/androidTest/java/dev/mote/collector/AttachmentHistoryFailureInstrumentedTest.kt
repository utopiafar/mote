package dev.mote.collector

import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Actual WorkManager/UploadWorker and SQLite, synthetic protocol peer only. */
class AttachmentHistoryFailureInstrumentedTest {
    @Test fun attachmentHistoryWriteFailureReportsStorageAndExplicitRetryRecovers() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("attachmentHistoryFailureFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context); val manager=WorkManager.getInstance(context)
        val ledger=File(context.noBackupFilesDir,"upload-history/items.sqlite")
        val backup=File(context.cacheDir,"generated-history-ledger-${UUID.randomUUID()}.sqlite")
        val server=ServerSocket(0,10,InetAddress.getByName("127.0.0.1"));val uploads=AtomicInteger();val registrations=AtomicInteger()
        var running=true;var serverError:Throwable?=null
        val thread=Thread {
            try { while(running) server.accept().use { socket ->
                val input=socket.getInputStream();fun line():String { val text=StringBuilder();while(true) {val b=input.read();if(b<0||b==10)break;if(b!=13)text.append(b.toChar())};return text.toString() }
                val path=line().split(' ')[1];var length=0
                while(true) { val h=line();if(h.isEmpty())break;if(h.startsWith("Content-Length:",true))length=h.substringAfter(':').trim().toInt() }
                require(length in 0..100000);val bytes=ByteArray(length);var offset=0
                while(offset<length) { val n=input.read(bytes,offset,length-offset);check(n>0);offset+=n }
                val body=if(length==0)JSONObject() else JSONObject(String(bytes))
                var status=200
                val response=when(path) {
                    "/api/sources" -> {
                        if(registrations.incrementAndGet()==1) { check(ledger.renameTo(backup));check(ledger.mkdir()) }
                        JSONObject().put("id",body.getString("id"))
                    }
                    "/api/file-sync/v1/uploads" -> {
                        uploads.incrementAndGet();val id=UUID.randomUUID().toString();val item=body.getJSONObject("item")
                        val ack=JSONObject().put("id",id).put("captureId",id).put("sourceId",body.getString("sourceId")).put("externalId",item.getString("externalId")).put("revision",item.getString("revision")).put("sha256",body.getString("sha256")).put("sizeBytes",body.getLong("sizeBytes"))
                        ack.put("receipt",JSONObject(ack.toString()).put("version",2).put("kind","file-revision").put("state","received").put("duplicate",true))
                        JSONObject().put("ack",ack)
                    }
                    "/api/captures" -> { val id=body.getString("id");JSONObject().put("id",id).put("receipt",JSONObject().put("version",2).put("id",id).put("kind","capture").put("state","received").put("duplicate",false)) }
                    "/api/devices/heartbeat" -> JSONObject().put("ok",true)
                    else -> { status=404;JSONObject() }
                }.toString().toByteArray()
                socket.getOutputStream().write("HTTP/1.1 $status Fixture\r\nContent-Type: application/json\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n".toByteArray());socket.getOutputStream().write(response)
            } } catch(error:Throwable) { if(running)serverError=error }
        }.apply { isDaemon=true;start() }
        fun waitFor(message:String,predicate:()->Boolean) { val end=android.os.SystemClock.elapsedRealtime()+15000;while(!predicate()) { serverError?.let { throw AssertionError(it) };check(android.os.SystemClock.elapsedRealtime()<end){message};Thread.sleep(50) } }
        try {
            settings.saveConnection("http://127.0.0.1:${server.localPort}","generated-history-failure-fixture-token","Generated failure",true)
            settings.save(settings.read().copy(syncMode="manual",wifiOnly=false,chargingOnly=false,packedUpload=false,uploadedRetentionDays=30))
            val draft=context.recordDraftStore();val originalBytes="Generated retained attachment".toByteArray();val attachment=draft.stage(originalBytes,"generated.txt","text/plain")
            draft.edit("Generated retained note",JSONArray().put(attachment),JSONObject())
            val note=draft.prepare(settings.read().server) { JSONObject().put("id",UUID.randomUUID().toString()).put("deviceId",settings.deviceId).put("source","note").put("capturedAt","2026-10-26T00:00:00Z").put("durationMs",0).put("ocrText","Generated retained note").put("privacy",JSONObject().put("excluded",false)) }
            context.queue().enqueue(note,null,100000)
            fun runWorker():WorkInfo.State {
                val request=OneTimeWorkRequestBuilder<UploadWorker>().setInputData(workDataOf("manual" to true,"continuation" to true,"syncStamp" to SyncSchedule.stamp(settings.read()))).build()
                manager.enqueueUniqueWork("generated-item-history-failure",ExistingWorkPolicy.REPLACE,request).result.get(5,TimeUnit.SECONDS)
                waitFor("Worker did not finish") { manager.getWorkInfoById(request.id).get()?.state?.isFinished==true }
                return manager.getWorkInfoById(request.id).get()!!.state
            }
            assertEquals(WorkInfo.State.FAILED,runWorker());assertEquals(0,uploads.get())
            assertTrue("Attachment storage failure must reach the history recovery handler",UploadHistoryRecovery.unavailable)
            assertEquals(UploadHistoryRecovery.message(),settings.uploadStatus())
            assertEquals(1,context.queue().pendingSync().count);assertArrayEquals(originalBytes,draft.bytes(attachment.getString("id")))
            assertTrue(ledger.delete());assertTrue(backup.renameTo(ledger))
            assertEquals(WorkInfo.State.SUCCEEDED,runWorker())
            assertFalse(UploadHistoryRecovery.unavailable);assertEquals(0,context.queue().pendingSync().count)
            assertEquals(1,uploads.get());assertArrayEquals(originalBytes,draft.bytes(attachment.getString("id")))
            assertEquals(1,context.itemUploadHistory().receipts(CaptureUploadReceipt.scope(settings.read().server,settings.deviceId)).size)
        } finally {
            manager.cancelUniqueWork("generated-item-history-failure").result.get(5,TimeUnit.SECONDS)
            if(backup.exists()) { if(ledger.isDirectory)check(ledger.delete());check(backup.renameTo(ledger)) }
            running=false;server.close();thread.join(2000)
        }
    }
}
