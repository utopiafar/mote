package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/** Generated pixels only; neither accessibility collection nor a system screenshot is started. */
@RunWith(AndroidJUnit4::class)
class UiPageLifecycleInstrumentedTest {
    private fun generatedPixels() = Bitmap.createBitmap(64,64,Bitmap.Config.ARGB_8888).apply {
        for (y in 0 until height) for (x in 0 until width) setPixel(x,y,if ((x / 8 + y / 8) % 2 == 0) Color.BLUE else Color.YELLOW)
    }
    private fun awaitIdle(pipeline: CapturePipeline) {
        val until=android.os.SystemClock.elapsedRealtime()+10000
        while(pipeline.isBusy() && android.os.SystemClock.elapsedRealtime()<until)Thread.sleep(20)
        assertFalse("fixture pipeline completed",pipeline.isBusy())
    }
    @Test fun lateWindowChangeRejectsGeneratedFrameBeforeDurableQueueAndActivity() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName=="dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val settings=Settings(context);val original=settings.read()
        require(!settings.enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth()==0)
        val config=original.copy(server="",token="",mode="accessibility",syncMode="manual",uiPageMode="ui_preferred",appCollectionRules=AppCollectionRules.CONTENT_DEFAULT,
            chargingOnly=false,batteryPauseBelowPct=0,imageDedupeMode="off",uploadGate=UploadGateConfig(enabled=false))
        val windows=WindowSnapshot(setOf("dev.mote.generated.reader"),"dev.mote.generated.reader",true)
        val scheduled=AtomicInteger()
        val pipeline=CapturePipeline(context){ scheduled.incrementAndGet() }
        try {
            settings.save(config);settings.enabled=true
            assertTrue("isolated emulator is unlocked",CapturePipeline.unlocked(context))
            val checks=AtomicInteger()
            pipeline.submit(generatedPixels(),windows,config,isCurrent={ checks.incrementAndGet()==1 })
            awaitIdle(pipeline)
            assertTrue("guard rechecked after processing",checks.get()>1)
            assertEquals(0,context.queue().depth());assertEquals(0,scheduled.get())
            pipeline.submitPageActivity(windows,config,isCurrent={false});awaitIdle(pipeline)
            assertEquals(0,context.queue().depth());assertEquals(0,scheduled.get())
            // Positive control: the same generated frame is durably queued while its context stays current.
            pipeline.submit(generatedPixels(),windows,config,isCurrent={true});awaitIdle(pipeline)
            assertEquals(1,context.queue().depth());assertEquals(1,scheduled.get())
            val item=requireNotNull(context.queue().peek());assertEquals("screen",item.getString("source"));assertNotNull(context.queue().image(item.getString("id")))
            context.queue().acknowledge(item.getString("id"))
        } finally {
            pipeline.close();settings.enabled=false;settings.save(original)
            context.queue().peekBatch(10).forEach { context.queue().acknowledge(it.getString("id")) }
        }
    }
}
