package dev.mote.collector

import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Generated emulator state only. These checks never start a screenshot service or read screen pixels. */
@RunWith(AndroidJUnit4::class)
class ServiceResponsivenessInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Before fun generatedEnvironmentOnly() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        require(context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty())
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
    }
    private fun mainRemainsResponsiveWhileQueueBusy(action: () -> Unit) {
        val locked = CountDownLatch(1); val release = CountDownLatch(1); val done = CountDownLatch(1)
        val result = AtomicReference<Throwable?>()
        val owner = Thread { DurableQueue.exclusive { locked.countDown(); release.await(10, TimeUnit.SECONDS) } }.apply { start() }
        try {
            assertTrue(locked.await(5, TimeUnit.SECONDS))
            Handler(Looper.getMainLooper()).post {
                try { action() } catch (error: Throwable) { result.set(error) } finally { done.countDown() }
            }
            assertTrue("Main looper must not wait for legacy queue scans", done.await(1, TimeUnit.SECONDS))
            result.get()?.let { throw AssertionError("Main looper action failed", it) }
        } finally { release.countDown(); owner.join(5000); assertTrue(done.await(5, TimeUnit.SECONDS)) }
    }
    @Test fun captureEligibilityNeverWaitsForQueueAccountingOrDiagnosticSampling() {
        val settings = Settings(context); val original = settings.read()
        val config = original.copy(server = "", token = "", diagnosticsEnabled = true, mode = "accessibility",
            nsfw = original.nsfw.copy(enabled = false), appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
        val pipeline = CapturePipeline(context) { }
        try {
            settings.save(config); settings.enabled = true
            val windows = WindowSnapshot(setOf("com.example.generated"), "com.example.generated", true)
            assertTrue("Generated emulator must be unlocked", CapturePipeline.unlocked(context))
            mainRemainsResponsiveWhileQueueBusy {
                assertTrue(pipeline.canCollect(config, windows, AppCollectionMode.ACTIVITY))
            }
        } finally { settings.enabled = false; pipeline.close(); settings.save(original) }
    }
    @Test fun serviceSyncSchedulingReturnsWhileQueueIsBusyAndSchedulesAfterRelease() {
        val settings = Settings(context); val original = settings.read(); val manager = WorkManager.getInstance(context)
        val config = original.copy(server = "https://127.0.0.1:1", token = "generated-responsiveness-fixture-token", syncMode = "batch")
        val accessed = CountDownLatch(1); val mainAccess = AtomicReference(false)
        val wrapper = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File {
                if (Looper.myLooper() == Looper.getMainLooper()) mainAccess.set(true)
                accessed.countDown()
                return super.getNoBackupFilesDir()
            }
        }
        try {
            settings.save(config)
            mainRemainsResponsiveWhileQueueBusy { UploadWorker.schedule(wrapper, config) }
            assertTrue("Deferred scheduler must still inspect the queue", accessed.await(10, TimeUnit.SECONDS))
            assertFalse("Scheduled queue reads must run off the main looper", mainAccess.get())
        } finally {
            // Restoring the configuration also invalidates any still-pending request's stamp.
            settings.save(original); manager.cancelAllWork().result.get(20, TimeUnit.SECONDS)
        }
    }
}
