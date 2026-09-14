package dev.mote.collector

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Generated data only. No accessibility or MediaProjection session is started. */
@RunWith(AndroidJUnit4::class)
class SettingsStorageInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    @Before fun generatedEnvironmentOnly() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        require(context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty())
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
    }
    private fun apply(next: CollectorConfig, change: (() -> Unit)? = null, whileApplying: (() -> Unit)? = null): RuntimeSettings.Applied {
        val complete = CountDownLatch(1); var result: Result<RuntimeSettings.Applied>? = null
        instrumentation.runOnMainSync { RuntimeSettings.apply(context, next, change = change) { result = it; complete.countDown() } }
        whileApplying?.invoke()
        assertTrue("settings callback", complete.await(30, TimeUnit.SECONDS))
        return result!!.getOrThrow()
    }
    @Test fun startupRecoveryGateDoesNotBlockMainThreadOnQueueLock() {
        val locked = CountDownLatch(1); val release = CountDownLatch(1)
        QueueStorage.recovering = true
        val background = Thread { DurableQueue.exclusive { locked.countDown(); release.await(5, TimeUnit.SECONDS) } }.apply { start() }
        try {
            assertTrue(locked.await(5, TimeUnit.SECONDS))
            val start = android.os.SystemClock.elapsedRealtime()
            instrumentation.runOnMainSync { assertThrows(IllegalStateException::class.java) { context.queue() } }
            assertTrue("UI must report recovery without waiting for the queue lock", android.os.SystemClock.elapsedRealtime() - start < 1000)
        } finally { release.countDown(); background.join(5000); QueueStorage.recovering = false }
        assertEquals(0, context.queue().depth())
    }
    @Test fun activeSettingsApplyWithoutManualStopAndConcurrentStopIsRespected() {
        val settings = Settings(context); val original = settings.read()
        try {
            val baseline = original.copy(server = "", token = "", mode = "accessibility", syncMode = "manual", nsfw = original.nsfw.copy(enabled = false))
            settings.save(baseline); settings.enabled = true // No capture service is connected in this fixture.
            val next = baseline.copy(intervalSeconds = 47, jpegQuality = 81, captureMaxSide = 1440, masks = "0,0,1,0.08", ocrChargingOnly = true)
            assertFalse(apply(next).projectionConsentRequired)
            assertEquals(next, settings.read()); assertTrue(settings.enabled); assertFalse(ConnectionGuard.changing())
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val stopped = next.copy(intervalSeconds = 60)
            apply(stopped, change = {
                // Same-thread nested connection changes are allowed only under the coordinator's write lock.
                ConnectionGuard.change(context, "") { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); settings.save(stopped) }
            }, whileApplying = {
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                assertNull(ConnectionGuard.sync { "must not run" })
                instrumentation.runOnMainSync { RuntimeSettings.cancelProjectionConsentRequest(); settings.enabled = false }
                release.countDown()
            })
            assertFalse(settings.enabled); assertEquals(stopped, settings.read()); assertFalse(ConnectionGuard.changing())
        } finally { settings.enabled = false; settings.save(original); WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS) }
    }
    @Test fun failedSinglePreferenceCommitRestoresConfigWithoutRollingBackUserStopOrStatus() {
        val settings = Settings(context); val original = settings.read()
        val failOnce = AtomicBoolean(true)
        val wrapper = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
                val delegate = super.getSharedPreferences(name, mode)
                if (name != "mote") return delegate
                return object : SharedPreferences by delegate {
                    override fun edit(): SharedPreferences.Editor {
                        val edit = delegate.edit()
                        return object : SharedPreferences.Editor by edit {
                            override fun commit(): Boolean {
                                val actual = edit.commit()
                                if (failOnce.getAndSet(false)) { settings.enabled = false; settings.status("paused", "generated stop during failed save"); return false }
                                return actual
                            }
                            // Preserve the wrapper throughout fluent Editor calls.
                            override fun putString(key: String, value: String?) = apply { edit.putString(key, value) }
                            override fun putInt(key: String, value: Int) = apply { edit.putInt(key, value) }
                            override fun putLong(key: String, value: Long) = apply { edit.putLong(key, value) }
                            override fun putBoolean(key: String, value: Boolean) = apply { edit.putBoolean(key, value) }
                            override fun remove(key: String) = apply { edit.remove(key) }
                        }
                    }
                }
            }
        }
        try {
            settings.enabled = true
            assertThrows(SettingsWriteFailure::class.java) { Settings(wrapper).save(original.copy(intervalSeconds = 72, masks = "0,0,1,0.12", jpegQuality = 90)) }
            assertEquals(original, settings.read()); assertFalse(settings.enabled); assertEquals("generated stop during failed save", settings.message())
        } finally { settings.enabled = false; settings.save(original) }
    }
    @Test fun realAppStorageMigrationUsesEncryptedFilesAndKeepsSettingsAndQueueBinding() {
        val settings = Settings(context); val original = settings.read(); val storage = QueueStorage(context); val initial = storage.current()
        require(initial.baseId == "internal")
        val target = storage.choices().first { it.id != "internal" }
        val id = UUID.randomUUID().toString()
        val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.CYAN) }
        val image = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }; bitmap.recycle()
        val event = JSONObject().put("id", id).put("source", "screen").put("capturedAt", "2026-09-14T00:00:00Z")
            .put("privacy", JSONObject().put("excluded", false)).put("imageMime", "image/png").put("ocrText", "generated fixture")
            .put("ocr", JSONObject().put("status", "completed"))
        try {
            val config = original.copy(server = "", token = "", syncMode = "manual", nsfw = original.nsfw.copy(enabled = false))
            settings.save(config); val origin = settings.dataOrigin(); val stale = context.queue()
            stale.enqueue(event, image, 2000000)
            val encrypted = File(initial.path).listFiles()!!.single { it.extension == "blob" }.readBytes()
            assertFalse(image.contentEquals(encrypted))
            apply(config, change = { storage.migrate(target.id) })
            assertEquals(target.id, storage.current().baseId); assertEquals(config, settings.read()); assertEquals(origin, settings.dataOrigin())
            assertArrayEquals(image, context.queue().image(id)); assertFalse(File(initial.path).exists())
            assertThrows(IllegalStateException::class.java) { stale.acknowledge(id) }
            assertArrayEquals(encrypted, File(storage.current().path).listFiles()!!.single { it.extension == "blob" }.readBytes())
            apply(config, change = { storage.migrate("internal") })
            assertEquals("internal", storage.current().baseId); assertArrayEquals(image, context.queue().image(id))
            context.queue().acknowledge(id); assertEquals(0, context.queue().depth())
        } finally {
            if (storage.current().baseId != "internal") storage.migrate("internal")
            context.queue().acknowledge(id); settings.enabled = false; settings.save(original)
            WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
        }
    }
}
