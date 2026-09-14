package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Dedicated API 35 Dev emulator only. All images and old queue records are generated here. */
@RunWith(AndroidJUnit4::class)
class AnrRegressionInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private var original: CollectorConfig? = null

    @Before fun generatedEnvironmentOnly() {
        require(context.packageName == "dev.mote.collector.dev" && Build.VERSION.SDK_INT == 35 &&
            Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (QueueStorage.recovering && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        require(!QueueStorage.recovering && QueueStorage.recoveryFailure == null)
        require(context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty())
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
        val settings = Settings(context)
        original = settings.read()
        settings.save(original!!.copy(server = "", token = "", syncMode = "manual", diagnosticsEnabled = false,
            nsfw = original!!.nsfw.copy(enabled = false)))
    }

    @After fun restoreSettings() {
        original?.let { Settings(context).save(it) }
    }

    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }

    private fun navigate(activity: MainActivity, label: String) {
        val tab = views(activity.window.decorView).filterIsInstance<TextView>()
            .single { it.isShown && it.isClickable && it.text.toString() == label }
        assertTrue(tab.performClick())
        assertTrue(tab.isSelected)
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(activity: MainActivity, name: String): T =
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity) as T

    private fun refresh(activity: MainActivity) {
        MainActivity::class.java.getDeclaredMethod("refreshStatus").apply { isAccessible = true }.invoke(activity)
    }

    private class HeldQueue : AutoCloseable {
        private val entered = CountDownLatch(1)
        private val release = CountDownLatch(1)
        private val holder = Thread({
            DurableQueue.exclusive { entered.countDown(); release.await(20, TimeUnit.SECONDS) }
        }, "generated-queue-contention").apply { start() }
        init { assertTrue("fixture must acquire the real queue lock", entered.await(5, TimeUnit.SECONDS)) }
        override fun close() { release.countDown(); holder.join(5000); assertFalse(holder.isAlive) }
    }

    @Test fun launchAndNavigationRemainResponsiveAfterRecoveryWhileQueueIsBusy() {
        assertFalse(QueueStorage.recovering)
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            HeldQueue().use {
                val launchedAt = SystemClock.elapsedRealtime()
                scenario = ActivityScenario.launch(MainActivity::class.java)
                // Cold view inflation gets more budget than an input callback, but cannot wait on the 20 s lock.
                assertTrue("home must launch without waiting for encrypted queue work",
                    SystemClock.elapsedRealtime() - launchedAt < 4000)
                for (label in listOf("设置", "随手记", "来源", "概览")) {
                    val started = SystemClock.elapsedRealtime()
                    scenario!!.onActivity { activity -> navigate(activity, label) }
                    assertTrue("$label must remain interactive while the queue lock is occupied",
                        SystemClock.elapsedRealtime() - started < 1000)
                }
            }
        } finally { scenario?.close() }
    }

    @Test fun repeatedRefreshesCoalesceAndDestroyDoesNotWaitForQueueWork() {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var activity: MainActivity
        lateinit var executor: ExecutorService
        val updates = AtomicInteger()
        try {
            scenario.onActivity {
                activity = it
                executor = field(it, "statusExecutor")
                // Keep the Activity resumed while removing the timer so this test controls refresh requests.
                field<Handler>(it, "handler").removeCallbacks(field<Runnable>(it, "refresh"))
            }
            executor.submit {}.get(10, TimeUnit.SECONDS)
            instrumentation.runOnMainSync {
                assertFalse(field<Boolean>(activity, "statusLoading"))
                field<TextView>(activity, "syncStatus").addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { updates.incrementAndGet() }
                    override fun afterTextChanged(s: Editable?) = Unit
                })
            }
            HeldQueue().use {
                val started = SystemClock.elapsedRealtime()
                instrumentation.runOnMainSync {
                    repeat(30) { refresh(activity) }
                    navigate(activity, "设置")
                    assertTrue(field<Boolean>(activity, "statusLoading"))
                }
                assertTrue("refresh requests must not wait for the queue", SystemClock.elapsedRealtime() - started < 1000)
                assertEquals(0, updates.get())
            }
            // This marker runs after all work submitted by the 30 requests. All their UI posts precede the main marker.
            executor.submit {}.get(10, TimeUnit.SECONDS)
            instrumentation.runOnMainSync {
                assertEquals("busy refreshes must produce one snapshot, without a backlog", 1, updates.get())
                assertFalse(field<Boolean>(activity, "statusLoading"))
            }
            HeldQueue().use {
                instrumentation.runOnMainSync { refresh(activity); assertTrue(field<Boolean>(activity, "statusLoading")) }
                val started = SystemClock.elapsedRealtime()
                scenario.close()
                assertTrue("destroy must not wait for an in-flight queue read", SystemClock.elapsedRealtime() - started < 1000)
                assertTrue(executor.isShutdown)
            }
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
            instrumentation.runOnMainSync { assertEquals("a destroyed Activity must not receive the late snapshot", 1, updates.get()) }
        } finally { scenario.close() }
    }

    @Test fun v001EncryptedScreenshotBacklogReopensWithoutChangingEventsOrImages() {
        val directory = File(context.noBackupFilesDir, "generated-v001-backlog-${UUID.randomUUID()}").apply { mkdirs() }
        val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) }
        val image = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it); it.toByteArray() }
        bitmap.recycle()
        val cipher = SecretBox() // Actual Android Keystore and the same v1 AES-GCM envelope as v0.0.1.
        val blob = MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it) }
        val ids = List(256) { UUID.randomUUID().toString() }
        val firstAt = 1_789_344_000_000L
        try {
            File(directory, "$blob.blob").writeBytes(cipher.seal(image))
            ids.forEachIndexed { index, id ->
                // v0.0.1 completed OCR inline and had no ocr object or _uploaded/_ocrResult state.
                val event = JSONObject().put("id", id).put("deviceId", "generated-v001-device")
                    .put("deviceName", "Generated upgrade fixture").put("platform", "android")
                    .put("capturedAt", java.time.Instant.ofEpochMilli(firstAt + index).toString())
                    .put("durationMs", 30_000).put("appId", "dev.mote.generated").put("appName", "Generated fixture")
                    .put("source", "screen").put("imageMime", "image/jpeg").put("ocrText", "GENERATED V001 SCREEN $index")
                    .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "local")
                        .put("collection", "content").put("reason", "generated fixture only"))
                    .put("_blob", blob)
                File(directory, "$id.event").apply {
                    writeBytes(cipher.seal(event.toString().toByteArray()))
                    assertTrue(setLastModified(firstAt + index))
                }
            }
            val before = directory.listFiles()!!.associate { it.name to NsfwModelStore.sha256(it) }
            val bytes = directory.listFiles()!!.sumOf { it.length() }
            val reopened = DurableQueue(directory, SecretBox())
            reopened.recoverOrphans()
            assertEquals(ids.size, reopened.depth())
            assertEquals(PendingSync(ids.size, firstAt), reopened.pendingSync())
            assertEquals("legacy inline OCR must not acquire a new pending-OCR reservation", bytes, reopened.bytes())
            val first = reopened.peek()!!
            assertEquals(ids.first(), first.getString("id"))
            assertEquals("GENERATED V001 SCREEN 0", first.getString("ocrText"))
            assertFalse(first.has("ocr"))
            assertArrayEquals(image, Base64.getDecoder().decode(first.getString("imageBase64")))
            assertArrayEquals(image, reopened.image(ids.last()))
            assertEquals("recovery and status must preserve the old encrypted files byte for byte", before,
                directory.listFiles()!!.associate { it.name to NsfwModelStore.sha256(it) })
            assertFalse(image.contentEquals(File(directory, "$blob.blob").readBytes()))
            assertEquals(ids.size, DurableQueue(directory, SecretBox()).pendingSync().count)
        } finally { directory.deleteRecursively() }
    }
}
