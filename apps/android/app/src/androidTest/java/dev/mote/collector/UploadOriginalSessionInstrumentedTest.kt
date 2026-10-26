package dev.mote.collector

import android.content.Intent
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** Controls HTTP completion and the existing UI executor; no production task hooks. */
class UploadOriginalSessionInstrumentedTest {
    @Test fun completedOriginalFromPriorSessionCannotRenderAfterPauseAndNodeChange() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("originalSessionFixture")=="true")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings=Settings(context); val socket=ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))
        val arrived=CountDownLatch(1);val release=CountDownLatch(1)
        val origin="http://127.0.0.1:${socket.localPort}";val id=UUID.randomUUID().toString();val batch=UUID.randomUUID().toString()
        val text="Generated old-session original must never reappear"
        val thread=Thread {
            try { socket.accept().use { peer ->
                val input=peer.getInputStream();var tail=""
                while(!tail.endsWith("\r\n\r\n")) {val b=input.read();check(b>=0);tail=(tail+b.toChar()).takeLast(4)}
                arrived.countDown();check(release.await(10,TimeUnit.SECONDS))
                val response=JSONObject().put("id",id).put("deviceId",settings.deviceId).put("ocrText",text)
                    .put("provenance",JSONObject().put("sourceId","generated-source").put("externalId","generated-item").put("revision","generated-revision")).toString().toByteArray()
                peer.getOutputStream().write("HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n".toByteArray());peer.getOutputStream().write(response)
            } } catch (error:java.net.SocketException) { if(!socket.isClosed) throw error }
        }.apply {isDaemon=true;start()}
        try {
            settings.saveConnection(origin,"generated-session-fixture-token-123456","Generated session A",true)
            settings.save(settings.read().copy(syncMode="manual"))
            val identity=ItemUploadIdentity("source-item",CaptureUploadReceipt.scope(origin,settings.deviceId),"source",origin,settings.deviceId,SourceRules.target(origin,settings.read().token),"generated-source","generated-item","generated-revision","generated-fingerprint")
            context.itemUploadHistory().received(ItemUploadReceipt(identity,batch,id,System.currentTimeMillis()))
            ActivityScenario.launch<UploadOriginalActivity>(Intent(context,UploadOriginalActivity::class.java).putExtra("batchId",batch).putExtra("itemKey",identity.key)).use { scenario ->
                assertTrue("Reader reached the synthetic peer",arrived.await(10,TimeUnit.SECONDS))
                lateinit var executor:ExecutorService
                scenario.onActivity { activity ->
                    val lazyTask=UploadOriginalActivity::class.java.getDeclaredField("task\$delegate").apply { isAccessible=true }.get(activity) as Lazy<*>
                    executor=UiTask::class.java.getDeclaredField("executor").apply { isAccessible=true }.get(lazyTask.value) as ExecutorService
                }
                scenario.moveToState(Lifecycle.State.CREATED)
                release.countDown()
                // FIFO barrier proves read + remote generation validation + result storage finished while paused.
                executor.submit {}.get(10,TimeUnit.SECONDS)
                settings.saveConnection("http://127.0.0.1:1","generated-session-b-fixture-token-123456","Generated session B",true)
                scenario.moveToState(Lifecycle.State.RESUMED)
                fun texts(view:android.view.View):List<String> = (if(view is android.widget.TextView)listOf(view.text.toString()) else emptyList()) + if(view is android.view.ViewGroup)(0 until view.childCount).flatMap { texts(view.getChildAt(it)) } else emptyList()
                var labels=emptyList<String>();val end=android.os.SystemClock.elapsedRealtime()+10000
                val unavailable=MoteI18n.text("历史版本暂不可读取：原件可能已更新、不可用或当前离线。请重试。")
                do { scenario.onActivity { labels=texts(it.window.decorView) };if(labels.none { it.contains(text)||it.contains(unavailable) })Thread.sleep(50) } while(labels.none { it.contains(text)||it.contains(unavailable) } && android.os.SystemClock.elapsedRealtime()<end)
                assertFalse("Completed text from session A must be discarded before rendering in session B",labels.any { it.contains(text) })
                assertTrue("The changed history binding must be re-read or explicitly unavailable",labels.any { it.contains(unavailable) })
            }
        } finally { release.countDown();socket.close();thread.join(2000) }
    }
}
