package dev.mote.collector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Generated status snapshots only; no capture service or personal data. */
@RunWith(AndroidJUnit4::class)
class LocalStateInstrumentedTest {
    @Test fun localStateRefreshNeverHoldsQueueWhileWaitingForConfiguration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth() == 0)
        val repository = LocalStateRepository.get(context)
        val settingsLocked = CountDownLatch(1); val releaseSettings = CountDownLatch(1); val inspected = CountDownLatch(1)
        val error = AtomicReference<Throwable?>()
        val owner = Thread { synchronized(Settings::class.java) { settingsLocked.countDown(); releaseSettings.await(10, TimeUnit.SECONDS) } }.apply { start() }
        var reader: Thread? = null
        try {
            assertTrue(settingsLocked.await(5, TimeUnit.SECONDS))
            repository.refresh()
            // Let the real repository enter its storage refresh while configuration is pinned.
            Thread.sleep(500)
            reader = Thread {
                try { QueueStorage(context).openQueue().inventory() } catch (failure: Throwable) { error.set(failure) }
                finally { inspected.countDown() }
            }.apply { start() }
            assertTrue("A configuration read must not keep the queue lock held", inspected.await(2, TimeUnit.SECONDS))
            error.get()?.let { throw AssertionError("Generated inventory failed", it) }
        } finally { releaseSettings.countDown(); owner.join(5000); reader?.join(5000) }
        val deadline = android.os.SystemClock.elapsedRealtime() + 5000
        while (repository.state.value.active == null && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
        assertNotNull("Repository refresh must finish after configuration resumes", repository.state.value.active)
    }
    @Test fun delayedFileAnchorAndActualSignInCompleteWithoutLockInversion() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val settings = Settings(context); require(!settings.enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth() == 0)
        val previous = settings.read(); val queue = context.fileArchives()
        val source = LocalSource(id = "generated-signin-anchor", name = "Generated anchor", kind = "local-files", retention = "reference", uri = "content://fixture/tree/root", tree = true, extensions = "txt")
        val anchorEntered = CountDownLatch(1); val loginEntered = CountDownLatch(1); val prepared = CountDownLatch(1); val signedIn = CountDownLatch(1)
        val failures = AtomicReference<Throwable?>(); var preparer: Thread? = null; var login: Thread? = null
        try {
            settings.save(previous.copy(server = "https://127.0.0.1:1", token = "generated-before-signin-token-1234567890"))
            val item = org.json.JSONObject().put("externalId", "content://fixture/anchor").put("uri", "content://fixture/anchor").put("title", "anchor.txt").put("kind", "file").put("layer", "reference").put("text", "").put("mimeType", "text/plain").put("observedAt", "2026-10-05T00:00:00Z").put("metadata", org.json.JSONObject().put("version", 1).put("file", org.json.JSONObject().put("sizeBytes", 42)))
            queue.observe(source, item, queue.configure(source).getString("generation"), 0)
            preparer = Thread {
                try { assertNotNull(queue.prepare(source, { error("Generated reference does not read content") }, { true }, anchor = {
                    anchorEntered.countDown(); check(loginEntered.await(5, TimeUnit.SECONDS)); Settings(context).read(); "generated-prior-revision"
                })) } catch (failure: Throwable) { failures.compareAndSet(null, failure) } finally { prepared.countDown() }
            }.apply { isDaemon = true; start() }
            assertTrue(anchorEntered.await(5, TimeUnit.SECONDS))
            login = Thread {
                try { synchronized(Settings::class.java) { loginEntered.countDown(); settings.signIn("https://127.0.0.1:1", "generated-after-signin-token-1234567890", 2592000000L) } }
                catch (failure: Throwable) { failures.compareAndSet(null, failure) } finally { signedIn.countDown() }
            }.apply { isDaemon = true; start() }
            assertTrue("Actual sign-in must finish while the delayed anchor reads configuration", signedIn.await(5, TimeUnit.SECONDS))
            assertTrue("The current generated anchor must publish after sign-in", prepared.await(5, TimeUnit.SECONDS))
            failures.get()?.let { throw AssertionError("Generated sign-in/anchor failed", it) }
            assertEquals("generated-after-signin-token-1234567890", settings.read().token)
        } finally {
            loginEntered.countDown(); preparer?.join(5000); login?.join(5000)
            if (prepared.count == 0L && signedIn.count == 0L) { queue.remove(source.id); settings.save(previous) }
        }
    }
    @Test fun storageStatusReportsPendingAndHeldRecordsWithoutLegacyLocalOcr() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val previous = MoteI18n.preference()
        try {
            MoteI18n.select(context, "zh-CN")
            val active = QueueInventory(5, 3, 2, 2, 0, 1, 1024, 0)
            val quarantine = QueueInventory(1, 1, 1, 0, 0, 0, 512, 0)
            val snapshot = LocalStateSnapshot(active = active, quarantine = quarantine, sourcePending = 1)
            assertEquals(4, snapshot.totalImages); assertEquals(3, snapshot.pending)
            val label = snapshot.storageLabel()
            assertTrue(label.contains("待同步 2 条")); assertTrue(label.contains("需处理 1 条"))
            assertFalse(label.contains("OCR")); assertTrue(label.contains("待决定区"))
        } finally { MoteI18n.select(context, previous) }
    }
    @Test fun unavailableStateNeverTurnsUnknownMeasurementsIntoZero() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val previous = MoteI18n.preference()
        try {
            MoteI18n.select(context, "zh-CN")
            val snapshot = LocalStateSnapshot(error = "generated storage failure")
            assertNull(snapshot.totalImages); assertNull(snapshot.pending)
            assertTrue(snapshot.storageLabel().contains("暂不可读取")); assertFalse(snapshot.storageLabel().contains("0 条"))
        } finally { MoteI18n.select(context, previous) }
    }
}
