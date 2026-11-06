package dev.mote.collector

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Generated status snapshots only; no capture service or personal data. */
@RunWith(AndroidJUnit4::class)
class LocalStateInstrumentedTest {
    /** Every disk/prefs path used by QueueStorage, format checks and its callbacks stays private. */
    private class GeneratedQueueContext(base: Context, private val root: File) : ContextWrapper(base) {
        private val preferences = mutableSetOf<String>()
        private val prefix = "generated-queue-${root.name}-"
        private val backup = File(root, "no-backup").apply { check(mkdir()) }
        private val files = File(root, "files").apply { check(mkdir()) }
        override fun getApplicationContext(): Context = this
        override fun getNoBackupFilesDir(): File = backup
        override fun getFilesDir(): File = files
        override fun getExternalFilesDirs(type: String?): Array<File> = emptyArray()
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val generatedName = prefix + name
            preferences.add(generatedName)
            return baseContext.getSharedPreferences(generatedName, mode)
        }
        fun dispose() {
            preferences.forEach { check(baseContext.deleteSharedPreferences(it)) }
            check(root.deleteRecursively())
        }
    }
    /**
     * The real Home wiring: `QueueStorage.stageRecoveryPending` on the selected location
     * bypasses `RevisionCache` even at an unchanged records revision, and each cycle reopens
     * the queue through `openQueue` — which is also what retries the replay. A malformed
     * accepted input keeps the truthful committed answer publishing; a repaired input commits.
     */
    @Test fun pendingStageRecoveryRetriesThroughTheSelectedQueueStorage() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        require(app.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        // Atomic fresh directory: neither the selected queue nor its location/pending files are
        // opened, inspected or cleaned up, even when a preflight or assertion below fails.
        val root = java.nio.file.Files.createTempDirectory(app.cacheDir.toPath(), "generated-stage-").toFile()
        val context = GeneratedQueueContext(app, root)
        try {
            val storage = QueueStorage(context)
            val dir = File(storage.current().path)
            assertEquals(File(context.noBackupFilesDir, "queue").canonicalFile, dir.canonicalFile)
            assertTrue("The real location pointer belongs to this generated profile", File(context.noBackupFilesDir,"queue-location.json").isFile)
            assertFalse(storage.stageRecoveryPending())
            assertFalse(storage.committedStored())
            val revision = LocalStateChanges.revisions.value.records
            val cache = RevisionCache()
            val collect = {
                HomeLocalCaptures.collect(cache, revision, JSONObject(),
                    pendingRecovery = { QueueStorage(context).stageRecoveryPending() }) {
                    HomeLocalCaptures.exists(
                        queue = { QueueStorage(context).openQueue() },
                        committedProbe = { QueueStorage(context).committedStored() })
                }
            }
            val inbox = File(dir, ".capture-stages.inbox")
            val event = JSONObject().put("id", UUID.randomUUID().toString())
                .put("capturedAt", "2026-01-01T00:00:00Z").put("platform", "android").put("durationMs", 1000)
                .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none")).put("source", "note")
            fun sealedInbox(input: JSONObject?) = context.localContentCipher().seal(JSONObject()
                .put("operation", UUID.randomUUID().toString())
                .put("input", input ?: JSONObject.NULL)
                .put("maxBytes", 16L * 1024 * 1024).put("reviewHeld", false).put("flush", false)
                .toString().toByteArray(Charsets.UTF_8))
            assertFalse("the empty generated archive caches false at this revision", collect().getBoolean("hasAnyRecords"))
            // An accepted input that fails validation on replay; the file survives for the next open.
            inbox.writeBytes(sealedInbox(JSONObject().put("event", JSONObject().put("id", "not-a-uuid")).put("image", JSONObject.NULL)))
            assertTrue("the selected location reports pending recovery", storage.stageRecoveryPending())
            assertFalse("the failed replay still publishes the committed answer", collect().getBoolean("hasAnyRecords"))
            assertTrue("the rejected input stays pending for the next cycle", storage.stageRecoveryPending())
            // A repaired accepted input commits on the next cycle's real openQueue replay.
            inbox.writeBytes(sealedInbox(JSONObject().put("event", event).put("image", JSONObject.NULL)))
            assertTrue("the retried replay commits the accepted record", collect().getBoolean("hasAnyRecords"))
            assertFalse("recovery cleared the pending stage input", storage.stageRecoveryPending())
            assertNotNull("the replayed record landed in the real queue", storage.openQueue().capture(event.getString("id")))
            assertTrue("The independent committed probe reads the replayed record", storage.committedStored())
            assertTrue("Real QueueStorage replay reports the record revision", LocalStateChanges.revisions.value.records > revision)
            // A later journal can fail before openQueue returns. The same production committed
            // readers used by Home must still retain the saved receipt and truthful inventory.
            val journal = JSONObject().put("outputs", org.json.JSONArray().put(JSONObject()
                .put("event", JSONObject().put("id", "not-a-uuid")).put("image", JSONObject.NULL)))
                .put("checkpoint", JSONObject().put("stages", org.json.JSONArray()))
            File(dir, ".capture-stages.journal").writeBytes(context.localContentCipher().seal(journal.toString().toByteArray(Charsets.UTF_8)))
            assertThrows(Exception::class.java) { storage.openQueue() }
            assertTrue(storage.stageRecoveryPending())
            assertTrue(storage.committedStored())
            assertEquals("A failed reopen cannot withdraw the committed receipt", event.getString("id"), storage.committedCapture(event.getString("id"))?.getString("id"))
            assertTrue("Home still publishes the committed inventory while retrying", collect().getBoolean("hasAnyRecords"))
        } finally {
            context.dispose()
        }
    }
    @Test fun localStateRefreshNeverHoldsQueueWhileWaitingForConfiguration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth() == 0)
        val repository = LocalStatusProducer.get(context)
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
    @Test fun attachmentAckAndCapturePageUseTheRealPrivateStoreWithoutLockInversion() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        require(app.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val root = java.nio.file.Files.createTempDirectory(app.cacheDir.toPath(), "generated-ack-page-").toFile()
        val context = GeneratedQueueContext(app, root)
        val versionEntered = CountDownLatch(1)
        val storeLocked = CountDownLatch(1)
        val acknowledged = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        var writer: Thread? = null
        try {
            val origin = "https://generated-ack.invalid"
            val store = context.recordDraftStore()
            val bytes = "Generated attachment original".toByteArray()
            val attachment = store.stage(bytes, "generated.txt", "text/plain")
            store.edit("Generated owner comment", org.json.JSONArray().put(attachment), JSONObject().put("kind", "manual"))
            val event = store.prepare(origin) { draft -> JSONObject()
                .put("id", UUID.randomUUID().toString()).put("source", "note").put("ocrText", draft.getString("text"))
                .put("capturedAt", "2026-10-25T00:00:00Z").put("platform", "android").put("durationMs", 1000)
                .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none")) }
            val id = event.getString("id")
            val beforeVersion = context.captureLibraryVersion(event, null)
            val queue = QueueStorage(context).openQueue().apply { archiveOrigin = origin }
            queue.enqueue(event, null, 16L * 1024 * 1024)
            val ack = UUID.randomUUID().toString()
            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val identity = ItemUploadIdentity("attachment", "scope", "capture", origin, "device", "target", "source", "external", "revision", "fingerprint", hash, bytes.size.toLong(), id, attachment.getString("id"))
            writer = Thread {
                try {
                    synchronized(store) {
                        storeLocked.countDown()
                        check(versionEntered.await(5, TimeUnit.SECONDS))
                        check(store.acknowledgeExact(identity, ack))
                    }
                } catch (error: Throwable) { failure.set(error) }
                finally { acknowledged.countDown() }
            }.apply { isDaemon = true; start() }
            assertTrue("The real ACK owns its store monitor before the page starts", storeLocked.await(5, TimeUnit.SECONDS))
            val page = queue.capturePage("2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z", source = "note", libraryBindings = true,
                libraryVersion = { original, blob ->
                    versionEntered.countDown()
                    assertTrue("A real attachment ACK must finish while page versioning is in progress", acknowledged.await(5, TimeUnit.SECONDS))
                    failure.get()?.let { throw AssertionError("Generated ACK failed", it) }
                    context.captureLibraryVersion(original, blob)
                })
            val expected = JSONObject(event.toString()).put("metadata", JSONObject().put("attachments", org.json.JSONArray().put(ack)))
            val version = page.getJSONObject("versions").getString(id)
            assertEquals(CaptureLibraryVersion.of(expected), version)
            assertNotEquals("The actual consumer incorporated the committed attachment ACK", beforeVersion, version)
            val row = page.getJSONArray("items").getJSONObject(0)
            assertEquals(id, row.getString("id")); assertEquals("Generated owner comment", row.getString("textPreview"))
            assertEquals(origin, page.getJSONObject("bindings").getString(id))
            assertFalse("Versioning cannot add transport metadata to the original", event.has("metadata"))
            assertEquals(ack, store.record(id)!!.getJSONObject("acks").getString(attachment.getString("id")))
            assertArrayEquals(bytes, store.bytes(attachment.getString("id")))
        } finally {
            versionEntered.countDown(); writer?.join(5000)
            try { assertFalse("The generated ACK writer must terminate before cleanup", writer?.isAlive == true) }
            finally { context.dispose() }
        }
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
