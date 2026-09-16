package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Dedicated emulator, generated records only. Never enables a real capture service. */
@RunWith(AndroidJUnit4::class)
class LibraryResponsivenessInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() }
    }
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun waitFor(label: String, timeoutMs: Long = 15000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { "Timed out: $label" }; Thread.sleep(40) }
    }
    private fun fixture(block: (Settings, MutableList<String>) -> Unit) {
        require(context.packageName == "dev.mote.collector.dev" && Build.VERSION.SDK_INT == 35 && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        waitFor("startup") { !QueueStorage.recovering && !QueueStorage.maintaining }
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
        val settings = Settings(context); val original = settings.read(); val state = settings.state(); val message = settings.message()
        require(context.queue().depth() == 0)
        val ids = mutableListOf<String>()
        try {
            settings.save(original.copy(server = "", token = "", syncMode = "manual", mode = "accessibility", screenCollectionEnabled = true,
                diagnosticsEnabled = false, notificationCollectionEnabled = false, deviceEventCollectionEnabled = false, mediaCollectionEnabled = false,
                appCollectionRules = AppCollectionRules.LEGACY_DEFAULT, contentEncryptionEnabled = false, nsfw = original.nsfw.copy(enabled = false)))
            block(settings, ids)
        } finally {
            QueueStorage.maintaining = false
            settings.enabled = false
            WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
            val queue = DurableQueue(File(QueueStorage(context).current().path), context.localContentCipher(), createMissing = false)
            queue.withDeferredIndexWrites { ids.forEach { queue.acknowledge(it) } }
            settings.save(original); settings.status(state, message); LocalStateChanges.changed(records = true, immediate = true)
        }
    }

    @Test fun startButtonCommitsWhileBackgroundLibraryWorkHoldsTheQueue() = fixture { settings, _ ->
        shell("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
        // Stub only availability; there is deliberately no service instance, so no
        // screenshot can be requested while exercising the real Start button.
        val connected = CaptureAccessibilityService::class.java.getDeclaredField("connected").apply { isAccessible = true }
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val holder = Thread { DurableQueue.exclusive { entered.countDown(); release.await(20, TimeUnit.SECONDS) } }
        try {
            connected.setBoolean(null, true)
            QueueStorage.maintaining = true
            holder.start(); assertTrue(entered.await(5, TimeUnit.SECONDS))
            val started = SystemClock.elapsedRealtime()
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity ->
                    val button = views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text == "开始采集" }
                    assertTrue(button.isEnabled); assertTrue(button.performClick())
                }
                waitFor("capture authorization without inventory", 3000) { settings.enabled }
                waitFor("Pause button without inventory", 3000) {
                    var visible = false
                    scenario.onActivity { activity -> visible = views(activity.window.decorView).filterIsInstance<Button>().any { it.isShown && it.text == "暂停采集" } }
                    visible
                }
                assertTrue("Start must not wait for background queue work", SystemClock.elapsedRealtime() - started < 6000)
                assertNull(CaptureAccessibilityService.instance)
                assertEquals(1L, release.count)
            }
        } finally { connected.setBoolean(null, false); release.countDown(); holder.join(5000) }
    }

    @Test fun twoThousandRecordsPageImmediatelyAndUnrelatedChangesKeepExistingRows() = fixture { _, ids ->
        val queue = DurableQueue(File(QueueStorage(context).current().path), context.localContentCipher(), createMissing = false)
        val bitmap = Bitmap.createBitmap(64, 96, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(20, 100, 160)) }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 75, it) }.toByteArray(); bitmap.recycle()
        val start = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant()
        queue.withDeferredIndexWrites {
            repeat(2000) { index ->
                val id = UUID.randomUUID().toString(); ids += id
                queue.enqueue(JSONObject().put("id", id).put("source", "screen").put("capturedAt", start.plusMillis(index + 1L).toString())
                    .put("appId", "fixture.library").put("appName", "Generated Library")
                    .put("ocr", JSONObject().put("status", "completed")).put("ocrText", "Generated $index")
                    .put("privacy", JSONObject().put("excluded", false)), bytes, 64 * 1024 * 1024)
            }
        }
        // The files a user copies/exports are ordinary JSON and original image bytes;
        // opening the library requires no local decryption for new records.
        val directory = File(QueueStorage(context).current().path)
        val readable = JSONObject(File(directory, "${ids.first()}.event").readText())
        assertEquals("Generated 0", readable.getString("ocrText"))
        assertArrayEquals(bytes, File(directory, readable.getString("_blob") + ".blob").readBytes())
        val indexes = directory.listFiles().orEmpty().filter { it.name.startsWith(".browse-v1-") }
        assertTrue(indexes.isNotEmpty())
        indexes.forEach { assertTrue(org.json.JSONArray(it.readText()).length() > 0) }
        LocalStateChanges.changed(records = true, immediate = true)
        val launched = SystemClock.elapsedRealtime()
        ActivityScenario.launch(CaptureRecordsActivity::class.java).use { scenario ->
            fun shown(value: String): Boolean {
                var found = false
                scenario.onActivity { found = views(it.window.decorView).filterIsInstance<TextView>().any { view -> view.isShown && view.text.contains(value) } }
                return found
            }
            waitFor("2000-record album first page", 8000) { shown("当天 2000 条") }
            android.util.Log.i("MotePerformance", "generated 2000 records album first page: ${SystemClock.elapsedRealtime() - launched} ms")
            scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag?.toString()?.startsWith("album:") == true }.performClick() }
            waitFor("20 metadata rows") {
                var count = 0; scenario.onActivity { count = views(it.window.decorView).count { view -> view.tag?.toString()?.startsWith("capture:") == true } }; count == 20
            }
            lateinit var first: View
            scenario.onActivity { activity -> first = views(activity.window.decorView).first { it.tag?.toString()?.startsWith("capture:") == true } }
            val noteId = UUID.randomUUID().toString(); ids += noteId
            queue.enqueue(JSONObject().put("id", noteId).put("source", "note").put("capturedAt", start.toString()).put("ocrText", "Generated unrelated note")
                .put("privacy", JSONObject().put("excluded", false)), null, 64 * 1024 * 1024)
            LocalStateChanges.changed(records = true, immediate = true)
            val revision = LocalStateChanges.revisions.value.records
            waitFor("background metadata refresh") {
                var complete = false
                scenario.onActivity { activity ->
                    val seen = CaptureRecordsActivity::class.java.getDeclaredField("lastRecordsRevision").apply { isAccessible = true }.getLong(activity)
                    val loading = CaptureRecordsActivity::class.java.getDeclaredField("metadataLoading").apply { isAccessible = true }.getBoolean(activity)
                    complete = seen >= revision && !loading
                }
                complete
            }
            val paged = SystemClock.elapsedRealtime()
            scenario.onActivity { activity ->
                assertSame("Unrelated records must preserve the current views and previews", first, views(activity.window.decorView).first { it.tag == first.tag })
                val next = views(activity.window.decorView).filterIsInstance<Button>().single { it.text == "下一页" }
                assertTrue("Paging is available independently of thumbnails", next.isEnabled); next.performClick()
            }
            waitFor("second page", 5000) { shown("第 2 页") }
            android.util.Log.i("MotePerformance", "generated 2000 records second page: ${SystemClock.elapsedRealtime() - paged} ms")
            scenario.onActivity { activity -> assertEquals(20, views(activity.window.decorView).count { it.tag?.toString()?.startsWith("capture:") == true }) }
        }
    }

    @Test fun developerEncryptionToggleAndCancellableDecryptionKeepCredentialsProtected() = fixture { settings, ids ->
        val token = "generated-local-storage-credential-1234567890"
        settings.save(settings.read().copy(token = token))
        val preferences = context.getSharedPreferences("mote", 0)
        val credentialBefore = preferences.getString("token", null)!!
        assertFalse(String(android.util.Base64.decode(credentialBefore, android.util.Base64.NO_WRAP)).contains(token))
        assertEquals(token, String(SecretBox().open(android.util.Base64.decode(credentialBefore, android.util.Base64.NO_WRAP))))
        val encryptedId = UUID.randomUUID().toString(); ids += encryptedId
        val plaintextId = UUID.randomUUID().toString(); ids += plaintextId
        val directory = File(QueueStorage(context).current().path)
        fun add(id: String) = context.queue().enqueue(JSONObject().put("id", id).put("source", "note")
            .put("capturedAt", java.time.Instant.now().toString()).put("ocrText", "Generated local content")
            .put("privacy", JSONObject().put("excluded", false)), null, 64 * 1024 * 1024)
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            fun click(label: String) = scenario.onActivity { activity ->
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text == label }.performClick())
            }
            fun menu(label: String) = scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }.performClick() }
            fun toggle(enabled: Boolean) {
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<android.widget.CheckBox>().single { it.text == "加密保存本地内容（默认关闭）" }.isChecked = enabled
                }
                click("保存设置")
                waitFor("content encryption saved") { settings.read().contentEncryptionEnabled == enabled && !ConnectionGuard.reconfiguring() }
            }
            click("设置"); menu("关于与更新"); menu("开发者选项")
            scenario.onActivity { activity -> assertFalse(views(activity.window.decorView).filterIsInstance<android.widget.CheckBox>().single { it.text == "加密保存本地内容（默认关闭）" }.isChecked) }
            toggle(true); add(encryptedId)
            val oldFile = File(directory, "$encryptedId.event")
            assertTrue(LocalContentCipher().isLegacy(oldFile.readBytes()))
            waitFor("encrypted metadata shard") { runCatching { LocalContentCipher().isLegacy(File(directory, ".browse-v1-${encryptedId.first()}").readBytes()) }.getOrDefault(false) }
            assertEquals("Generated local content", context.queue().capture(encryptedId)!!.getString("ocrText"))
            toggle(false); add(plaintextId)
            // Saving settings legitimately re-encrypts the same token with a fresh IV.
            // Only the explicit content migration must leave that saved ciphertext alone.
            val credentialBeforeDecryption = preferences.getString("token", null)!!
            assertFalse(String(android.util.Base64.decode(credentialBeforeDecryption, android.util.Base64.NO_WRAP)).contains(token))
            assertEquals(plaintextId, JSONObject(File(directory, "$plaintextId.event").readText()).getString("id"))
            waitFor("plaintext metadata shard") { runCatching { org.json.JSONArray(File(directory, ".browse-v1-${plaintextId.first()}").readText()).length() > 0 }.getOrDefault(false) }
            assertTrue("Turning encryption off does not secretly rewrite old captures", LocalContentCipher().isLegacy(oldFile.readBytes()))
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val holder = Thread { DurableQueue.exclusive { entered.countDown(); release.await(20, TimeUnit.SECONDS) } }.apply { start() }
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val started = SystemClock.elapsedRealtime()
                click("批量解密已有本地数据")
                assertTrue(LocalContentDecryptor.snapshot.running)
                assertTrue("Bulk decryption must not block its input callback", SystemClock.elapsedRealtime() - started < 1000)
                scenario.recreate(); scenario.awaitMainUi()
                assertTrue("Work must survive Activity recreation", LocalContentDecryptor.snapshot.running)
                click("取消批量解密")
            } finally { release.countDown(); holder.join(5000) }
            waitFor("decryption cancellation") { !LocalContentDecryptor.snapshot.running }
            assertTrue(LocalContentDecryptor.snapshot.message.contains("已取消"))
            assertTrue(LocalContentCipher().isLegacy(oldFile.readBytes()))
            waitFor("decrypt button available") {
                var available = false
                scenario.onActivity { activity -> available = views(activity.window.decorView).filterIsInstance<Button>().any { it.text == "批量解密已有本地数据" && it.isEnabled } }
                available
            }
            click("批量解密已有本地数据")
            waitFor("decryption complete") { !LocalContentDecryptor.snapshot.running }
            assertTrue(LocalContentDecryptor.snapshot.message.contains("批量解密完成"))
            assertEquals(encryptedId, JSONObject(oldFile.readText()).getString("id"))
            assertEquals(credentialBeforeDecryption, preferences.getString("token", null))
            assertEquals(token, settings.read().token)
        }
    }
}
