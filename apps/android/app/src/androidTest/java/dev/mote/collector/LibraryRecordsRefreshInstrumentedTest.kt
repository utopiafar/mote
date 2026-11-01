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
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 45000
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(60) }
    }
    private fun note(id: String, device: String, at: Instant, text: String) = JSONObject()
        .put("id", id).put("deviceId", device).put("deviceName", "Generated refresh phone").put("platform", "android")
        .put("source", "note").put("capturedAt", at.toString()).put("durationMs", 0).put("ocrText", text)
        .put("privacy", JSONObject().put("excluded", false))

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
        require(root.listFiles()?.none { it.name.startsWith("mote-queue-") } == true) { "Generated fixture refuses orphaned private queues" }
        require(!File(root, "queue-migration.json").exists())
        val pointer = File(root, "queue-location.json")
        val queue = if (pointer.exists()) QueueLocation.parse(JSONObject(pointer.readText())).let {
            require(it.baseId == "internal" && File(it.path).canonicalFile == File(root, "queue").canonicalFile)
            File(it.path)
        } else File(root, "queue")
        require(!java.nio.file.Files.isSymbolicLink(queue.toPath()))
        require(!queue.exists() || queue.listFiles()?.all { it.isFile && !java.nio.file.Files.isSymbolicLink(it.toPath()) && it.name in setOf(".mote-storage-id", ".mote-local-format") } == true) { "Generated fixture refuses every retained event, stage, checkpoint and unknown queue entry" }
        for (name in listOf("central-native", "file-archives", "note-draft", "record-draft", "local-sources", "capture-context")) {
            val dir = File(root, name)
            require(!java.nio.file.Files.isSymbolicLink(dir.toPath()) && (!dir.exists() || dir.isDirectory && dir.listFiles()?.isEmpty() == true)) { "Generated fixture refuses retained $name" }
        }
        val pending = File(context.filesDir, "record-pending")
        require(!pending.exists() || pending.isDirectory && pending.listFiles()?.isEmpty() == true)
        val dedupe = File(root, "bulk-dedupe")
        require(!dedupe.exists() || dedupe.listFiles()?.all { entry ->
            entry.name == "pending" && entry.isDirectory && entry.listFiles()?.all { it.isFile && it.name == ".mote-local-format" } == true
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
            waitFor("application recovery settles before the read-only preflight") { !QueueStorage.recovering && !QueueStorage.maintaining }
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
        requireEmptyGeneratedProfile()
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
        require(!Settings(context).enabled && !ProjectionService.running && CaptureAccessibilityService.instance == null)
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
        val repository = LocalStateRepository.get(context); repository.refresh()
        waitFor("paired generated inventory before opening the library") { repository.state.value.let { it.error == null && it.active?.records == 65 } }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
            scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("资料位置") }.setSelection(0) }
            fun shown(text: String): Boolean { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.contains(text) } }; return found }
            fun rows(id: String): Int { var count = 0; scenario.onActivity { activity -> count = views(activity.window.decorView).count { it.isShown && it.tag == "library-record:$id" } }; return count }
            fun click(label: String) { scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text == MoteI18n.text(label) && it.isClickable }.performClick() } }
            fun anchorRowId(): String? {
                var tag: String? = null
                scenario.onActivity { activity -> tag = views(activity.window.decorView).filter { it.tag?.toString()?.startsWith("library-record:") == true }
                    .filter { it.getGlobalVisibleRect(android.graphics.Rect()) }
                    .minByOrNull { val rect = android.graphics.Rect(); it.getGlobalVisibleRect(rect); rect.top }?.tag?.toString() }
                return tag?.removePrefix("library-record:")
            }
            waitFor("first page") { rows(locals[0]) == 1 && remotes.take(20).all { rows(it) == 1 } }
            click("加载更多"); waitFor("second page") { rows(locals[39]) == 1 && remotes.all { rows(it) == 1 } }
            click("加载更多"); waitFor("third page") { rows(locals[59]) == 1 }
            waitFor("all accepted page work has reached its production UI delivery") {
                var idle = false
                scenario.onActivity { activity ->
                    val view = MainActivity::class.java.getDeclaredField("libraryView").apply { isAccessible = true }.get(activity)
                    idle = !(LibraryCaptureView::class.java.getDeclaredField("task").apply { isAccessible = true }.get(view) as UiTask).busy
                }
                idle
            }
            // Scroll a third-page row to the top so the anchor compensation can be observed.
            scenario.onActivity { activity ->
                val row = views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" }
                var parent = row.parent; while (parent is View && parent !is android.widget.ScrollView) parent = parent.parent
                val position = IntArray(2); row.getLocationInWindow(position); (parent as android.widget.ScrollView).scrollBy(0, position[1] - 300)
            }
            val anchor = anchorRowId()
            var deepCard: View? = null
            scenario.onActivity { activity -> deepCard = views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" } }
            assertNotNull("a visible record row is required before the burst", anchor)
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
            assertEquals("other loaded Central pages remain", 1, rows(remotes[23]))
            assertEquals("loaded deeper pages are preserved", 1, rows(locals[50]))
            scenario.onActivity { activity -> assertSame("unchanged deep cards and thumbnail views are reused", deepCard, views(activity.window.decorView).single { it.tag == "library-record:${locals[50]}" }) }
            assertEquals("the anchored row keeps its viewport position", anchor, anchorRowId())
            val stats = api.get("/api/fixture/library-request-stats")
            assertEquals("an insert burst re-reads exactly the first Central page", 1, stats.getInt("deviceView"))
            assertTrue("all Central HTTP during the append burst stays bounded", stats.getInt("centralRequests") <= 2)
            assertEquals("the owner-scope check is cached per connection generation", 0, stats.getInt("connectionsSelf"))
            click("加载更多"); waitFor("pagination continues after the cursor") { rows(locals[64]) == 1 }

            val mixedAdded = mutableListOf<String>()
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
            waitFor("a net-positive mixed batch removes deep deleted content and replaces the deep preview") {
                rows(locals[50]) == 0 && rows(locals[51]) == 1 && shown("Generated replaced deep preview") &&
                    !shown("Generated library record 51") && fresh.all { rows(it) == 1 } && mixedAdded.all { rows(it) == 1 }
            }

            api.post("/api/fixture/library-denial", JSONObject().put("mode", "forbidden"))
            try {
                val probe = UUID.randomUUID().toString()
                assertEquals(probe, queue.enqueue(note(probe, device, Instant.now(), "Generated denial probe"), null, 64_000_000))
                waitFor("denial still withdraws remote rows on the incremental path") { remotes.all { rows(it) == 0 } && rows(probe) == 1 && shown("中央状态未知") }
            } finally { api.post("/api/fixture/library-denial", JSONObject().put("mode", "none")) }
        }
        }
    }
}
