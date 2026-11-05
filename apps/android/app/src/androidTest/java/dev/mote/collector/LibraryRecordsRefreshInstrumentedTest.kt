package dev.mote.collector

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Spinner
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * Generated-only library records journey: a pure-insert burst merges into already-loaded pages
 * while deletes, same-count rewrites and denials still take the safe path. Requires the
 * library-capture fixture server (uiJourneyServer/uiJourneyToken) on a loopback host.
 */
@RunWith(AndroidJUnit4::class)
class LibraryRecordsRefreshInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun waitFor(label: String, timeout: Long = 45000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(60) }
    }
    private fun awaitApplicationRecovery() {
        waitFor("application recovery and its final record invalidation settle") {
            // The host preflight proves this dedicated package has no records/stages.
            // Its first records invalidation is Application's final notification.
            // Waiting for that as well closes the flags-false -> records+1 boundary.
            !QueueStorage.recovering && !QueueStorage.maintaining && LocalStateChanges.revisions.value.records > 0
        }
    }
    private fun note(id: String, device: String, at: Instant, text: String) = JSONObject()
        .put("id", id).put("deviceId", device).put("deviceName", "Generated refresh phone").put("platform", "android")
        .put("source", "note").put("capturedAt", at.toString()).put("durationMs", 0).put("ocrText", text)
        .put("privacy", JSONObject().put("excluded", false))

    // Exact current RecordDraftStore default serialization (95 bytes). Retention
    // may write this empty state even when the generated profile has never edited.
    private val emptyRecordState = """{"draft":{"text":"","description":"","attachments":[],"origin":{"kind":"manual"}},"records":{}}""".toByteArray(Charsets.UTF_8)
    private fun requireEmptyRecordDraft(dir: File) {
        require(!java.nio.file.Files.isSymbolicLink(dir.toPath()))
        require(!dir.exists() || dir.isDirectory && dir.listFiles()?.all { entry ->
            entry.name == "record.enc" && entry.isFile && !java.nio.file.Files.isSymbolicLink(entry.toPath()) &&
                entry.length() == emptyRecordState.size.toLong() && entry.readBytes().contentEquals(emptyRecordState)
        } == true) { "Generated fixture accepts only the exact default empty record draft" }
    }

    /** Raw preflight never opens/replays the selected queue or deletes a prior origin. */
    private fun emptyStoredCredential(value: String?): Boolean {
        if (value.isNullOrEmpty()) return true
        // Read the existing TEST-profile key only. SecretBox's key factory may create
        // a missing key, which is inappropriate before the profile is proven empty.
        val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = requireNotNull(store.getKey("mote.private.v1", null)) as javax.crypto.SecretKey
        val readOnlyCipher = object : ByteCipher {
            override fun seal(bytes: ByteArray): ByteArray = error("preflight cannot write credentials")
            override fun open(bytes: ByteArray): ByteArray {
                require(bytes.isNotEmpty())
                val size = bytes[0].toInt(); require(size in 12..16 && bytes.size > size + 1)
                return javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, bytes.copyOfRange(1, size + 1)))
                    doFinal(bytes.copyOfRange(size + 1, bytes.size))
                }
            }
        }
        return CredentialValue(RuntimeProfile.TEST, readOnlyCipher).decode(value).isEmpty()
    }
    private fun requireEmptyGeneratedProfile() {
        require(context.packageName == "dev.mote.collector.filefixture" && Build.FINGERPRINT.contains("emu64a"))
        require(!ProjectionService.running && !CaptureAccessibilityService.connected)
        require(!QueueStorage.recovering && !QueueStorage.maintaining && QueueStorage.recoveryFailure == null)
        val root = context.noBackupFilesDir
        require(!java.nio.file.Files.isSymbolicLink(root.toPath()))
        require(root.listFiles()?.none { java.nio.file.Files.isSymbolicLink(it.toPath()) } == true)
        require(root.listFiles()?.none { it.name.startsWith("mote-queue-") } == true) { "Generated fixture refuses orphaned private queues" }
        require(!File(root, "queue-migration.json").exists())
        val pointer = File(root, "queue-location.json")
        require(!java.nio.file.Files.isSymbolicLink(pointer.toPath()))
        val queue = if (pointer.exists()) QueueLocation.parse(JSONObject(pointer.readText())).let {
            require(it.baseId == "internal" && File(it.path).canonicalFile == File(root, "queue").canonicalFile)
            File(it.path)
        } else File(root, "queue")
        require(!java.nio.file.Files.isSymbolicLink(queue.toPath()))
        require(!queue.exists() || queue.listFiles()?.all { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) && it.name in setOf(".mote-storage-id", ".mote-local-format") } == true) { "Generated fixture refuses every retained event, stage, checkpoint and unknown queue entry" }
        for (name in listOf("central-native", "file-archives", "note-draft", "local-sources", "capture-context")) {
            val dir = File(root, name)
            require(!java.nio.file.Files.isSymbolicLink(dir.toPath()) && (!dir.exists() || dir.isDirectory && dir.listFiles()?.isEmpty() == true)) { "Generated fixture refuses retained $name" }
        }
        requireEmptyRecordDraft(File(root, "record-draft"))
        val pending = File(context.filesDir, "record-pending")
        require(!java.nio.file.Files.isSymbolicLink(pending.toPath()) && (!pending.exists() || pending.isDirectory && pending.listFiles()?.isEmpty() == true))
        val dedupe = File(root, "bulk-dedupe")
        require(!java.nio.file.Files.isSymbolicLink(dedupe.toPath()))
        require(!dedupe.exists() || dedupe.listFiles()?.all { entry ->
            entry.name == "pending" && !java.nio.file.Files.isSymbolicLink(entry.toPath()) && entry.isDirectory && entry.listFiles()?.all { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) && it.name == ".mote-local-format" } == true
        } == true) { "Generated fixture refuses retained dedupe plans and quarantine" }
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all
        require(listOf("server", "token", "dataOrigin").all { prefs[it] == null || prefs[it] is String })
        require(prefs["enabled"] != true && prefs["lastCapture"] == null)
        require((prefs["server"] as? String).orEmpty() in setOf("", BuildConfig.DEFAULT_SERVER))
        require((prefs["dataOrigin"] as? String).orEmpty().isBlank())
        require(emptyStoredCredential(prefs["token"] as? String))
    }
    private inner class GeneratedProfile : AutoCloseable {
        private var armed = false
        private var directory: File? = null
        private var pointerBytes: ByteArray? = null
        private var pointerChanged = false
        private var prefs: Map<String, Any?> = emptyMap()
        private var language = "system"
        private var appearance = AppearancePreference.AUTO
        private val pointer get() = File(context.noBackupFilesDir, "queue-location.json")
        private fun writePointer(bytes: ByteArray) {
            val temp = File.createTempFile("generated-library-pointer-", ".tmp", context.noBackupFilesDir)
            try {
                java.io.FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }
                check(temp.renameTo(pointer))
            } finally { check(!temp.exists() || temp.delete()) }
        }
        fun open(server: String, token: String): DurableQueue {
            awaitApplicationRecovery()
            requireEmptyGeneratedProfile()
            prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
            pointerBytes = pointer.takeIf { it.exists() }?.readBytes()
            language = MoteI18n.preference()
            appearance = MoteAppearance.preference()
            val id = UUID.randomUUID().toString()
            val privateQueue = File(context.noBackupFilesDir, "mote-queue-$id")
            check(privateQueue.mkdir()); directory = privateQueue; armed = true
            LocalDataFormat.requireCurrent(privateQueue)
            File(privateQueue, ".mote-storage-id").writeText(id)
            DurableQueue.exclusive {
                writePointer(QueueLocation(id, "internal", privateQueue.absolutePath).json().toString().toByteArray())
                pointerChanged = true
            }
            MoteI18n.select(context, "zh-CN")
            MoteAppearance.select(context, AppearancePreference.LIGHT)
            val settings = Settings(context)
            settings.save(settings.read().copy(server = server, token = token, debugHttp = true, authSignedOut = false, authExpiresAt = 0, authProcess = "", syncMode = "manual", syncPaused = true), confirmCentralEndpoint = true)
            return context.queue().also { assertEquals(privateQueue.canonicalFile, File(QueueStorage(context).selected().path).canonicalFile) }
        }
        override fun close() {
            if (!armed) return
            armed = false
            DurableQueue.exclusive {
                if (pointerChanged) { pointerBytes?.let(::writePointer) ?: check(!pointer.exists() || pointer.delete()) }
                check(requireNotNull(directory).deleteRecursively())
            }
            val originalPrefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
            val edit = originalPrefs.edit()
            originalPrefs.all.keys.filter { it !in prefs }.forEach(edit::remove)
            prefs.forEach { (key, value) -> when (value) {
                is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value)
                is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") edit.putStringSet(key, value as Set<String>)
            } }
            check(edit.commit()); MoteI18n.select(context, language); MoteAppearance.select(context, appearance)
            // Preflight proved there were no origin children; only this fixture's origin may be removed.
            val server = java.net.URI(requireNotNull(InstrumentationRegistry.getArguments().getString("uiJourneyServer"))).toString().trimEnd('/')
            File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(server)).takeIf { it.exists() }?.let { check(it.deleteRecursively()) }
            LocalStateChanges.changed(records = true, immediate = true)
        }
    }

    private class PrivateQueueContext(base: Context, private val root: File) : ContextWrapper(base) {
        private val names = mutableSetOf<String>()
        private val prefix = "generated-library-${root.name}-"
        private val backup = File(root, "no-backup").apply { check(mkdir()) }
        private val files = File(root, "files").apply { check(mkdir()) }
        override fun getApplicationContext(): Context = this
        override fun getNoBackupFilesDir() = backup
        override fun getFilesDir() = files
        override fun getExternalFilesDirs(type: String?): Array<File> = emptyArray()
        override fun getExternalFilesDir(type: String?): File? = null
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val generated = prefix + name; names += generated
            return baseContext.getSharedPreferences(generated, mode)
        }
        fun dispose() { names.forEach { check(baseContext.deleteSharedPreferences(it)) }; check(root.deleteRecursively()) }
    }
    @Test fun realQueueStorageBatchReplayRetentionAndConstructorWritesNeverHideDestructiveChanges() {
        require(context.packageName == "dev.mote.collector.filefixture" && Build.FINGERPRINT.contains("emu64a"))
        awaitApplicationRecovery()
        val root = java.nio.file.Files.createTempDirectory(context.cacheDir.toPath(), "generated-library-signals-").toFile()
        val generated = PrivateQueueContext(context, root)
        try {
            val storage = QueueStorage(generated); val queue = storage.openQueue()
            val device = "generated-signal-device"; val at = Instant.parse("2026-01-01T00:00:00Z")
            val seed = (0 until 3).map { UUID.randomUUID().toString().also { queue.enqueue(note(it, device, at, "Generated baseline"), null, 16_000_000) } }
            val policy = LibraryRefreshPolicy(LocalStateChanges.revisions.value.records, queue.inventory().records)
            val before = LocalStateChanges.revisions.value.records
            queue.withDeferredIndexWrites {
                repeat(3) { queue.enqueue(note(UUID.randomUUID().toString(), device, at.plusSeconds(1), "Generated batch insert"), null, 16_000_000) }
                queue.acknowledge(seed[0]); queue.archiveMissing(seed[1])
            }
            val after = LocalStateChanges.revisions.value.records
            assertEquals("deferred index writes still report 3 physical inserts, 1 deletion and 1 rewrite", 5L, after - before)
            assertEquals(5, queue.inventory().records)
            assertEquals(LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(after, queue.inventory().records))
            val retained = LocalStateChanges.revisions.value.records
            queue.acknowledge(seed[2], retentionDays = 1, now = 1)
            assertEquals(1, queue.pruneUploaded(now = 86_400_002))
            assertEquals("retention rewrite and prune each report their own event mutation", 2L, LocalStateChanges.revisions.value.records - retained)
            assertEquals(LibraryRefreshPolicy.Action.FULL, policy.recordsChanged(LocalStateChanges.revisions.value.records, queue.inventory().records))
            val dir = File(storage.selected().path)
            val replayIds = (0 until 2).map { UUID.randomUUID().toString() }
            val outputs = org.json.JSONArray()
            replayIds.forEach { outputs.put(JSONObject().put("event", note(it, device, at.plusSeconds(2), "Generated constructor replay")).put("image", JSONObject.NULL)) }
            outputs.put(JSONObject().put("event", JSONObject().put("id", "invalid-generated-id")).put("image", JSONObject.NULL))
            val journal = JSONObject().put("outputs", outputs).put("checkpoint", JSONObject().put("stages", org.json.JSONArray()))
            val journalFile = File(dir, ".capture-stages.journal")
            journalFile.writeBytes(generated.localContentCipher().seal(journal.toString().toByteArray()))
            val replayStart = LocalStateChanges.revisions.value.records
            assertThrows(Exception::class.java) { storage.openQueue() }
            assertEquals("successful physical commits report even when constructor later fails", 2L, LocalStateChanges.revisions.value.records - replayStart)
            replayIds.forEach { assertNotNull(storage.committedCapture(it)) }
            outputs.remove(outputs.length() - 1)
            journalFile.writeBytes(generated.localContentCipher().seal(journal.toString().toByteArray()))
            val recovered = storage.openQueue()
            assertEquals("idempotent replay does not manufacture row mutations", 2L, LocalStateChanges.revisions.value.records - replayStart)
            assertEquals(6, recovered.inventory().records)
        } finally { generated.dispose() }
    }
    @Test fun retainedQueueSentinelRejectsBeforeReplayAndUnarmedCleanup() {
        awaitApplicationRecovery()
        requireEmptyGeneratedProfile()
        val generated = java.nio.file.Files.createTempDirectory(context.cacheDir.toPath(), "generated-empty-record-guard-").toFile()
        try {
            val draft = File(generated, "draft").apply { check(mkdir()) }
            val record = File(draft, "record.enc")
            requireEmptyRecordDraft(draft)
            record.writeBytes(emptyRecordState); requireEmptyRecordDraft(draft)
            val retained = listOf(
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).apply { getJSONObject("draft").put("text", "Generated retained text") },
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).apply { getJSONObject("draft").put("description", "Generated retained description") },
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).apply { getJSONObject("draft").getJSONArray("attachments").put(JSONObject().put("id", "generated")) },
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).apply { getJSONObject("draft").put("prepared", JSONObject()) },
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).put("pendingMedia", org.json.JSONArray()),
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).apply { getJSONObject("records").put("generated", JSONObject()) },
                JSONObject(String(emptyRecordState, Charsets.UTF_8)).put("unknown", true)
            )
            retained.forEach { value ->
                val bytes = value.toString().toByteArray(); record.writeBytes(bytes)
                assertThrows(IllegalArgumentException::class.java) { requireEmptyRecordDraft(draft) }
                assertArrayEquals("rejection preserves every retained byte", bytes, record.readBytes())
            }
            record.writeBytes(emptyRecordState)
            val unknown = File(draft, "unknown").apply { writeText("Generated retained entry") }
            assertThrows(IllegalArgumentException::class.java) { requireEmptyRecordDraft(draft) }; check(unknown.delete())
            check(record.delete())
            val target = File(generated, "link-target").apply { writeBytes(emptyRecordState) }
            java.nio.file.Files.createSymbolicLink(record.toPath(), target.toPath())
            assertThrows(IllegalArgumentException::class.java) { requireEmptyRecordDraft(draft) }
            assertArrayEquals(emptyRecordState, target.readBytes())
        } finally { check(generated.deleteRecursively()) }
        val dir = File(context.noBackupFilesDir, "queue"); check(dir.isDirectory)
        val sentinel = File(dir, ".capture-stages.inbox"); check(!sentinel.exists())
        val bytes = "Generated accepted input must survive rejection".toByteArray()
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        val pointer = File(context.noBackupFilesDir, "queue-location.json").readBytes()
        sentinel.writeBytes(bytes)
        try {
            GeneratedProfile().use { profile -> assertThrows(IllegalArgumentException::class.java) { profile.open("http://127.0.0.1:1", "generated-only-token") } }
            assertArrayEquals(bytes, sentinel.readBytes())
            assertArrayEquals(pointer, File(context.noBackupFilesDir, "queue-location.json").readBytes())
            assertEquals(prefs, context.getSharedPreferences("mote", Context.MODE_PRIVATE).all)
        } finally { check(sentinel.delete()) }
    }

    @Test fun insertBurstMergesFirstPageWhileDeletesRewritesAndDenialStaySafe() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("libraryRecordsRefreshFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName == "dev.mote.collector.filefixture")
        require(!ProjectionService.running && CaptureAccessibilityService.instance == null)
        val server = requireNotNull(args.getString("uiJourneyServer")); val token = requireNotNull(args.getString("uiJourneyToken"))
        require(java.net.URI(server).host in setOf("10.0.2.2", "127.0.0.1", "localhost"))
        GeneratedProfile().use { profile ->
        val queue = profile.open(server, token)
        val settings = Settings(context); val api = CentralClient(server, token)
        val device = settings.deviceId
        val base = Instant.now().minusSeconds(4000)
        val locals = (0 until 65).map { index ->
            val id = UUID.randomUUID().toString()
            assertEquals(id, queue.enqueue(note(id, device, base.minusSeconds(index.toLong()), "Generated library record $index"), null, 64_000_000))
            id
        }
        val remotes = (0 until 25).map { index ->
            val id = UUID.randomUUID().toString()
            api.post("/api/captures", note(id, "generated-remote-device", base.minusSeconds(index.toLong()), "Generated remote-only record $index"))
            id
        }
        // Keep all 65 locals and 25 remote-only records. This additional exact
        // overlap gives the deep-card identity check an already verified status;
        // an unprobed third-page local would legitimately change UNKNOWN to
        // UNAVAILABLE when the first append supplies its missing match.
        api.post("/api/captures", note(locals[50], device, base.minusSeconds(50), "Generated library record 50"))
        val repository = LocalStatusProducer.get(context); repository.refresh()
        waitFor("paired generated inventory before opening the library") { repository.state.value.let { it.error == null && it.active?.records == 65 } }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.isShown && it.contentDescription == MoteI18n.text("资料位置") }.setSelection(0) }
            fun shown(text: String): Boolean { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.contains(text) } }; return found }
            fun rows(id: String): Int { var count = 0; scenario.onActivity { activity -> count = views(activity.window.decorView).count { it.isShown && it.tag == "library-record:$id" } }; return count }
            fun click(label: String) { scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text == MoteI18n.text(label) && it.isClickable }.performClick() } }
            fun readIdle(): Boolean {
                var idle = false
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    idle = !(LibraryCaptureView::class.java.getDeclaredField("task").apply { isAccessible = true }.get(view) as UiTask).busy
                }
                return idle
            }
            fun awaitLibraryFrame() {
                val drawn = java.util.concurrent.CountDownLatch(1)
                scenario.onActivity { activity ->
                    val root = activity.window.decorView
                    val observer = root.viewTreeObserver
                    observer.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
                        override fun onPreDraw(): Boolean {
                            if (observer.isAlive) observer.removeOnPreDrawListener(this)
                            root.post { drawn.countDown() }
                            return true
                        }
                    })
                    root.postInvalidateOnAnimation()
                }
                check(drawn.await(45, java.util.concurrent.TimeUnit.SECONDS)) { "the actual Library layout reaches pre-draw" }
                instrumentation.waitForIdleSync()
            }
            fun rowState(id: String): Triple<String, String?, LibraryCaptureProjection.Remote> {
                var value: Triple<String, String?, LibraryCaptureProjection.Remote>? = null
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    val projection = LibraryCaptureView::class.java.getDeclaredField("projection").apply { isAccessible = true }.get(view) as LibraryCaptureProjection
                    val row = projection.visible("").single { it.identity.id == id }
                    value = Triple(SourceRules.canonical(row.item), row.central?.let(SourceRules::canonical), row.remote)
                }
                return requireNotNull(value)
            }
            fun scheduled(): Boolean {
                var value = false
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    value = LibraryCaptureView::class.java.getDeclaredField("incrementalScheduled").apply { isAccessible = true }.getBoolean(view)
                }
                return value
            }
            fun paginationState(): List<Any?> {
                var value = emptyList<Any?>()
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    value = listOf("pages", "localCursor", "remoteCursor", "remoteBoundary", "localMore", "remoteMore").map {
                        LibraryCaptureView::class.java.getDeclaredField(it).apply { isAccessible = true }.get(view)
                    }
                }
                return value
            }
            fun busyDeadlinePending(): Boolean {
                var value = false
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    value = LibraryCaptureView::class.java.getDeclaredField("incrementalPending").apply { isAccessible = true }.getBoolean(view)
                }
                return value
            }
            var stoppedActivity: MainActivity? = null
            var stoppedTaskId = -1
            var stoppedIdentity: Pair<String, Long>? = null
            fun stopPastRecordDeadline() {
                waitFor("the real records change has scheduled its debounce") { scheduled() }
                scenario.onActivity { stoppedActivity = it; stoppedTaskId = it.taskId }
                stoppedIdentity = CentralAccess.resolve(context).let { it.server to it.generation }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                waitFor("the actual Activity window is hidden") {
                    var hidden = false
                    scenario.onActivity { hidden = it.window.decorView.windowVisibility != View.VISIBLE }
                    hidden
                }
                waitFor("the production debounce deadline is consumed while hidden") { !scheduled() }
                assertTrue("no Library read begins while its Activity is stopped", readIdle())
            }
            fun resumeStoppedTask() {
                // The platform invoker's cover Activity alone does not bring the
                // original task forward. Use the same real task, not recreation.
                context.getSystemService(android.app.ActivityManager::class.java).appTasks.single { it.taskInfo.taskId == stoppedTaskId }.moveToFront()
                waitFor("the OS resumes the original Library task", timeout = 10_000) {
                    runCatching { scenario.state }.getOrNull() == androidx.lifecycle.Lifecycle.State.RESUMED
                }
                scenario.onActivity { assertSame(stoppedActivity, it); assertEquals(stoppedTaskId, it.taskId) }
                assertEquals("return does not change the authorization generation", stoppedIdentity, CentralAccess.resolve(context).let { it.server to it.generation })
            }
            fun anchorRowId(): String? {
                var tag: String? = null
                scenario.onActivity { activity -> tag = views(activity.window.decorView).filter { it.tag?.toString()?.startsWith("library-record:") == true }
                    .filter { it.getGlobalVisibleRect(android.graphics.Rect()) }
                    .minByOrNull { val rect = android.graphics.Rect(); it.getGlobalVisibleRect(rect); rect.top }?.tag?.toString() }
                return tag?.removePrefix("library-record:")
            }
            fun rowY(id: String): Int {
                var y = 0
                scenario.onActivity { activity ->
                    val row = views(activity.window.decorView).single { it.tag == "library-record:$id" }
                    val point = IntArray(2); row.getLocationInWindow(point); y = point[1]
                }
                return y
            }
            fun firstPageDiagnostic(): String {
                var detail = ""
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    val projection = LibraryCaptureView::class.java.getDeclaredField("projection").apply { isAccessible = true }.get(view) as LibraryCaptureProjection
                    val selected = LibraryCaptureView::class.java.getDeclaredField("location").apply { isAccessible = true }.get(view)
                    val status = LibraryCaptureView::class.java.getDeclaredField("status").apply { isAccessible = true }.get(view) as TextView
                    val page = MainActivity::class.java.getDeclaredField("currentPage").apply { isAccessible = true }.get(activity)
                    detail = "page=$page location=$selected local=${projection.localIdentities().size} remote=${projection.remoteVersions(server).size} window=${activity.window.decorView.windowVisibility} status=${status.text.take(500)}"
                }
                return detail
            }
            try { waitFor("first page") { rows(locals[0]) == 1 && remotes.take(20).all { rows(it) == 1 } } }
            catch (failure: IllegalStateException) { throw AssertionError("first page: ${runCatching(::firstPageDiagnostic).getOrDefault("diagnostic unavailable")}", failure) }
            click("加载更多"); waitFor("second page") { rows(locals[39]) == 1 && remotes.all { rows(it) == 1 } }
            click("加载更多"); waitFor("third page") { rows(locals[59]) == 1 }
            waitFor("all accepted page work has reached its production UI delivery") { readIdle() }
            awaitLibraryFrame()
            // Scroll a third-page row to the top so the anchor compensation can be observed.
            scenario.onActivity { activity ->
                val row = views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" }
                var parent = row.parent; while (parent is View && parent !is android.widget.ScrollView) parent = parent.parent
                val position = IntArray(2); row.getLocationInWindow(position); (parent as android.widget.ScrollView).scrollBy(0, position[1] - 300)
            }
            awaitLibraryFrame()
            val anchor = anchorRowId()
            val deepBaseline = rowState(locals[50])
            assertEquals("the unchanged deep card already has a real authorized exact-version baseline", LibraryCaptureProjection.Remote.READABLE, deepBaseline.third)
            var deepCard: View? = null
            scenario.onActivity { activity -> deepCard = views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" } }
            assertNotNull("a visible record row is required before the burst", anchor)
            val anchorY = rowY(requireNotNull(anchor))
            scenario.onActivity { activity ->
                val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity) as LibraryCaptureView
                val snapshot = repository.state.value
                // Deterministically replay the opening snapshot already consumed
                // by refresh(), immediately before the actual five-write burst.
                view.recordsChanged(snapshot.revision.records, snapshot.active?.records)
                assertFalse("a consumed snapshot must not start an early full-refresh timer", LibraryCaptureView::class.java.getDeclaredField("incrementalScheduled").apply { isAccessible = true }.getBoolean(view))
            }
            api.delete("/api/captures/${remotes.last()}")
            api.post("/api/fixture/library-request-stats", JSONObject())
            val burstStarted = SystemClock.elapsedRealtime()
            val fresh = (0 until 5).map { index ->
                val id = UUID.randomUUID().toString()
                assertEquals(id, queue.enqueue(note(id, device, Instant.now().plusSeconds(index.toLong()), "Generated inserted record $index"), null, 64_000_000))
                id
            }
            waitFor("insert burst merges into the first page and withdraws a deleted Central deep row") { fresh.all { rows(it) == 1 } && rows(remotes.last()) == 0 }
            assertTrue("record refresh is coalesced for at least five seconds", SystemClock.elapsedRealtime() - burstStarted >= 5_000)
            waitFor("the burst has completed production UI delivery") { readIdle() }
            awaitLibraryFrame()
            assertEquals("other loaded Central pages remain", 1, rows(remotes[23]))
            assertEquals("loaded deeper pages are preserved", 1, rows(locals[50]))
            assertEquals("the deep card's original facts, Central version and availability really remain unchanged", deepBaseline, rowState(locals[50]))
            scenario.onActivity { activity -> assertSame("unchanged deep cards and thumbnail views are reused", deepCard, views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" }) }
            assertEquals("the anchored row keeps its viewport position", anchor, anchorRowId())
            assertTrue("the same deep row retains its actual, unclipped window y within one pixel", kotlin.math.abs(rowY(requireNotNull(anchor)) - anchorY) <= 1)
            val stats = api.get("/api/fixture/library-request-stats")
            assertEquals("an insert burst reads one bounded Central prefix", 1, stats.getInt("deviceView"))
            assertTrue("all Central HTTP during the append burst stays bounded", stats.getInt("centralRequests") <= 2)
            assertEquals("the owner-scope check is cached per connection generation", 0, stats.getInt("connectionsSelf"))

            waitFor("the successful append is idle before the controlled offline transition") { readIdle() }
            val beforeOffline = paginationState()
            assertNotNull("this transition retains an actual local continuation cursor", beforeOffline[1])
            val offlineIds = (0 until 2).map { UUID.randomUUID().toString() }
            api.post("/api/fixture/library-denial", JSONObject().put("mode", "offline"))
            api.post("/api/fixture/library-device-hold", JSONObject().put("action", "hold"))
            try {
                queue.enqueue(note(offlineIds[0], device, Instant.now(), "Generated offline append"), null, 64_000_000)
                waitFor("the real 503 request is held after local-first publication") { api.get("/api/fixture/library-device-hold").getInt("entered") == 1 && rows(offlineIds[0]) == 1 }
                assertFalse(readIdle())
                assertTrue("the previously authorized Central rows remain until the held response", remotes.dropLast(1).all { rows(it) == 1 })
                api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release"))
                waitFor("a delivered transient failure withdraws stale Central claims while keeping local originals") {
                    readIdle() && remotes.all { rows(it) == 0 } && rows(offlineIds[0]) == 1 && rows(locals[50]) == 1 && shown("中央状态未知")
                }
                assertEquals("offline append preserves every pagination continuation", beforeOffline, paginationState())
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.isShown && it.contentDescription == MoteI18n.text("资料位置") }.setSelection(2) }
                waitFor("stale remote availability cannot appear in the Central-readable filter") { rows(locals[50]) == 0 && rows(offlineIds[0]) == 0 && remotes.all { rows(it) == 0 } }
            } finally {
                api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release"))
                api.post("/api/fixture/library-denial", JSONObject().put("mode", "none"))
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.isShown && it.contentDescription == MoteI18n.text("资料位置") }.setSelection(0) }
            }
            waitFor("returning from the Central filter still keeps the local original") { rows(locals[50]) == 1 && rows(offlineIds[0]) == 1 }
            queue.enqueue(note(offlineIds[1], device, Instant.now(), "Generated recovered append"), null, 64_000_000)
            waitFor("a later successful incremental read restores the generated Central rows exactly once") { readIdle() && remotes.dropLast(1).all { rows(it) == 1 } && rows(offlineIds[0]) == 1 && rows(offlineIds[1]) == 1 }
            assertEquals("recovery keeps the same pagination continuations", beforeOffline, paginationState())
            queue.withDeferredIndexWrites { offlineIds.forEach { queue.acknowledge(it) } }
            waitFor("only the two generated offline probes are removed before continuing") { readIdle() && offlineIds.all { rows(it) == 0 } && rows(locals[50]) == 1 && remotes.dropLast(1).all { rows(it) == 1 } }
            click("加载更多"); waitFor("pagination continues after the cursor") { rows(locals[64]) == 1 }

            waitFor("pagination is idle before holding the in-flight insertion read") { readIdle() }
            var busyDeepCard: View? = null
            scenario.onActivity { activity -> busyDeepCard = views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" } }
            val busyIds = (0 until 3).map { UUID.randomUUID().toString() }
            api.post("/api/fixture/library-device-hold", JSONObject().put("action", "hold"))
            var newerDeadline = 0L
            try {
                queue.enqueue(note(busyIds[0], device, Instant.now(), "Generated in-flight insert"), null, 64_000_000)
                waitFor("the real incremental HTTP read is held") { api.get("/api/fixture/library-device-hold").getInt("entered") == 1 && rows(busyIds[0]) == 1 }
                queue.enqueue(note(busyIds[1], device, Instant.now(), "Generated busy-deadline insert"), null, 64_000_000)
                waitFor("the first production debounce expires against the busy read") { busyDeadlinePending() && !scheduled() }
                queue.enqueue(note(busyIds[2], device, Instant.now(), "Generated younger-deadline insert"), null, 64_000_000)
                waitFor("the second insertion has queued its real younger timer") { scheduled() }
                newerDeadline = SystemClock.uptimeMillis() + LibraryRefreshPolicy.DEBOUNCE_MILLIS
            } finally { api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release")) }
            waitFor("busy completion drains both pending insertions before the younger timer", timeout = LibraryRefreshPolicy.DEBOUNCE_MILLIS) { busyIds.all { rows(it) == 1 } && readIdle() }
            assertTrue("the controlled drain precedes the younger deadline", SystemClock.uptimeMillis() < newerDeadline)
            assertFalse("draining the burst retires its younger queued timer", scheduled())
            val drainedHttp = api.get("/api/fixture/library-request-stats").getInt("centralRequests")
            waitFor("the retired younger timer's original deadline passes") { SystemClock.uptimeMillis() > newerDeadline }
            instrumentation.waitForIdleSync()
            assertTrue("an empty retired tick cannot start another read", readIdle())
            assertEquals("no extra HTTP/full reload after consuming the busy burst", drainedHttp, api.get("/api/fixture/library-request-stats").getInt("centralRequests"))
            scenario.onActivity { activity -> assertSame("the deep card survives past the younger deadline", busyDeepCard, views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" }) }
            queue.withDeferredIndexWrites { busyIds.forEach { queue.acknowledge(it) } }
            waitFor("remove only the three generated timing records before the later bounded cases") { busyIds.all { rows(it) == 0 } && rows(locals[64]) == 1 && readIdle() }

            waitFor("all page reads finish before the stopped insert") { readIdle() }
            val stoppedInsert = UUID.randomUUID().toString()
            val beforeStop = api.get("/api/fixture/library-request-stats").getInt("centralRequests")
            queue.enqueue(note(stoppedInsert, device, Instant.now(), "Generated stopped insert"), null, 64_000_000)
            stopPastRecordDeadline()
            assertEquals("the hidden insert tick starts no HTTP", beforeStop, api.get("/api/fixture/library-request-stats").getInt("centralRequests"))
            resumeStoppedTask()
            waitFor("same connection resumes the pending insert with no additional writes") { rows(stoppedInsert) == 1 && rows(locals[50]) == 1 && readIdle() }

            val mixedAdded = mutableListOf<String>()
            // The exact-overlap setup is fixture-only; remove its Central copy
            // too so the existing mixed deletion still requires no remaining row.
            api.delete("/api/captures/${locals[50]}")
            val beforeMixedStop = api.get("/api/fixture/library-request-stats").getInt("centralRequests")
            queue.withDeferredIndexWrites {
                repeat(3) { index ->
                    val id = UUID.randomUUID().toString(); mixedAdded += id
                    queue.enqueue(note(id, device, Instant.now(), "Generated mixed record $index"), null, 64_000_000)
                }
                queue.acknowledge(locals[50])
                queue.acknowledge(locals[51])
                queue.enqueue(note(locals[51], device, base.minusSeconds(51), "Generated replaced deep preview"), null, 64_000_000)
                queue.archiveMissing(locals[52])
            }
            stopPastRecordDeadline()
            assertEquals("the hidden destructive tick starts no HTTP", beforeMixedStop, api.get("/api/fixture/library-request-stats").getInt("centralRequests"))
            resumeStoppedTask()
            waitFor("a net-positive mixed batch removes deep deleted content and replaces the deep preview") {
                rows(locals[50]) == 0 && rows(locals[51]) == 1 && shown("Generated replaced deep preview") &&
                    !shown("Generated library record 51") && fresh.all { rows(it) == 1 } && mixedAdded.all { rows(it) == 1 }
            }

            waitFor("mixed refresh is idle before the bounded denial probe") { readIdle() }
            api.post("/api/fixture/library-denial", JSONObject().put("mode", "forbidden"))
            api.post("/api/fixture/library-device-hold", JSONObject().put("action", "hold"))
            try {
                val probe = UUID.randomUUID().toString()
                assertEquals(probe, queue.enqueue(note(probe, device, Instant.now(), "Generated denial probe"), null, 64_000_000))
                waitFor("denied device-view is held before replying") { api.get("/api/fixture/library-device-hold").getInt("entered") == 1 }
                waitFor("local publication does not wait for the pending denial", timeout = 5_000) { rows(probe) == 1 }
                assertFalse(readIdle())
                assertTrue("retained Central rows remain until the held denial is delivered", remotes.dropLast(1).all { rows(it) == 1 })
                api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release"))
                waitFor("fresh denial after local publication withdraws every Central reference") { remotes.all { rows(it) == 0 } && readIdle() && rows(probe) == 1 && shown("中央状态未知") }
            } finally {
                api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release"))
                api.post("/api/fixture/library-denial", JSONObject().put("mode", "none"))
            }

            click("刷新")
            waitFor("fresh authorization restores the loaded generated Central range") { remotes.dropLast(1).all { rows(it) == 1 } && rows(locals[64]) == 1 && readIdle() }

            waitFor("mixed refresh has delivered before holding the next real request") { readIdle() }
            val concurrent = mutableListOf<String>()
            api.post("/api/fixture/library-device-hold", JSONObject().put("action", "hold"))
            try {
                val localFirst = UUID.randomUUID().toString()
                assertEquals(localFirst, queue.enqueue(note(localFirst, device, Instant.now(), "Generated local-first probe"), null, 64_000_000))
                waitFor("production device-view request is inside the server barrier") { api.get("/api/fixture/library-device-hold").getInt("entered") == 1 }
                waitFor("committed local capture appears while Central is still blocked", timeout = 5_000) { rows(localFirst) == 1 }
                assertTrue(api.get("/api/fixture/library-device-hold").getBoolean("held"))
                assertFalse("the production read still awaits the actual HTTP response", readIdle())
                // Twenty-four new heads plus one late backfill exceed page one.
                // An overlap with the old head alone cannot prove this range complete.
                repeat(25) { index ->
                    val id = UUID.randomUUID().toString(); concurrent += id
                    val at = if (index == 24) base.minusSeconds(22).plusMillis(500) else Instant.now().minusSeconds(10)
                    api.post("/api/captures", note(id, "generated-remote-device", at, "Generated concurrent remote record $index"))
                }
            } finally { api.post("/api/fixture/library-device-hold", JSONObject().put("action", "release")) }
            waitFor("every concurrent head and deep backfill is present exactly once") { concurrent.all { rows(it) == 1 } && rows(remotes[23]) == 1 && readIdle() }


        }
        }
    }

    @Test fun successiveTruncatedAppendsAndOverlappingPagesDoNotSkipADeepBackfill() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("libraryRecordsRefreshFixture") == "true" && Build.FINGERPRINT.contains("emu64a") && context.packageName == "dev.mote.collector.filefixture")
        require(!ProjectionService.running && CaptureAccessibilityService.instance == null)
        val server = requireNotNull(args.getString("uiJourneyServer")); val token = requireNotNull(args.getString("uiJourneyToken"))
        require(java.net.URI(server).host in setOf("10.0.2.2", "127.0.0.1", "localhost"))
        GeneratedProfile().use { profile ->
            val queue = profile.open(server, token)
            val device = Settings(context).deviceId; val api = CentralClient(server, token)
            val base = Instant.now().minusSeconds(4000)
            val locals = (0 until 20).map { index -> UUID.randomUUID().toString().also {
                assertEquals(it, queue.enqueue(note(it, device, base.minusSeconds(index.toLong()), "Generated frontier local $index"), null, 64_000_000))
            } }
            val remotes = (0 until 70).map { index -> UUID.randomUUID().toString().also {
                api.post("/api/captures", note(it, "generated-frontier-remote", base.minusSeconds(index.toLong()), "Generated frontier R${index + 1}"))
            } }
            val repository = LocalStatusProducer.get(context); repository.refresh()
            waitFor("the frontier fixture has exactly twenty local originals") { repository.state.value.let { it.error == null && it.active?.records == 20 } }
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.isShown && it.contentDescription == MoteI18n.text("资料位置") }.setSelection(0) }
                fun rows(id: String): Int {
                    var count = 0
                    scenario.onActivity { activity -> count = views(activity.window.decorView).count { it.isShown && it.tag == "library-record:$id" } }
                    return count
                }
                fun readIdle(): Boolean {
                    var idle = false
                    scenario.onActivity { activity ->
                        val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                        idle = !(LibraryCaptureView::class.java.getDeclaredField("task").apply { isAccessible = true }.get(view) as UiTask).busy
                    }
                    return idle
                }
                fun loadMore() {
                    val before = api.get("/api/fixture/library-request-stats").getInt("deviceView")
                    scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isEnabled && it.isClickable && it.text == MoteI18n.text("加载更多") }.performClick() }
                    waitFor("an actual continuation page is delivered") { readIdle() && api.get("/api/fixture/library-request-stats").getInt("deviceView") > before }
                }
                waitFor("the first ordinary page contains R1 through R20") { readIdle() && locals.all { rows(it) == 1 } && remotes.take(20).all { rows(it) == 1 } }
                assertEquals("R21 has not been paged yet", 0, rows(remotes[20]))
                api.post("/api/fixture/library-request-stats", JSONObject())
                val firstInsert = UUID.randomUUID().toString()
                val firstStarted = SystemClock.elapsedRealtime()
                queue.enqueue(note(firstInsert, device, Instant.now(), "Generated first frontier append"), null, 64_000_000)
                waitFor("the first truncated append actually merges R1 through R60") { readIdle() && rows(firstInsert) == 1 && remotes.take(60).all { rows(it) == 1 } }
                assertTrue(SystemClock.elapsedRealtime() - firstStarted >= LibraryRefreshPolicy.DEBOUNCE_MILLIS)
                assertEquals("R61 remains behind the ordinary continuation", 0, rows(remotes[60]))
                val firstStats = api.get("/api/fixture/library-request-stats")
                assertEquals(1, firstStats.getInt("deviceView")); assertEquals(0, firstStats.getInt("connectionsSelf"))
                assertTrue("the proved first append preserves the ordinary HTTP budget", firstStats.getInt("centralRequests") <= 2)
                loadMore() // The retained cursor reads R21–R40, overlapping the merged prefix.
                assertTrue("the overlapping ordinary page keeps all sixty already displayed identities", remotes.take(60).all { rows(it) == 1 })
                assertEquals(0, rows(remotes[60]))

                val heads = (0 until 5).map { index -> UUID.randomUUID().toString().also {
                    api.post("/api/captures", note(it, "generated-frontier-remote", Instant.now().minusSeconds(10), "Generated new frontier head $index"))
                } }
                val backfill = UUID.randomUUID().toString()
                api.post("/api/captures", note(backfill, "generated-frontier-remote", base.minusSeconds(56).minusMillis(500), "Generated backfill between R57 and R58"))
                val secondInsert = UUID.randomUUID().toString()
                val secondStarted = SystemClock.elapsedRealtime()
                queue.enqueue(note(secondInsert, device, Instant.now(), "Generated second frontier append"), null, 64_000_000)
                waitFor("the second insertion and its successful remote read finish") { readIdle() && rows(secondInsert) == 1 && heads.all { rows(it) == 1 } }
                assertTrue(SystemClock.elapsedRealtime() - secondStarted >= LibraryRefreshPolicy.DEBOUNCE_MILLIS)
                if (rows(remotes[59]) == 1) assertEquals("a successful refresh cannot retain R60 across an undisplayed R57/R58 backfill gap", 1, rows(backfill))
                // Unproved coverage may safely restart the ordinary loaded range.
                // Its extra HTTP is allowed; the original five-insert budget is unchanged.
                repeat(4) { if (remotes.any { rows(it) == 0 } || rows(backfill) == 0) loadMore() }
                assertTrue("ordinary continuation reaches every original remote exactly once", remotes.all { rows(it) == 1 })
                assertTrue("all five new heads occur exactly once", heads.all { rows(it) == 1 })
                assertEquals("the deep backfill is neither skipped nor duplicated", 1, rows(backfill))
                assertTrue("all local originals remain usable after the fallback and pagination", locals.all { rows(it) == 1 })
                assertEquals(1, rows(firstInsert)); assertEquals(1, rows(secondInsert))
            }
        }
    }
}
