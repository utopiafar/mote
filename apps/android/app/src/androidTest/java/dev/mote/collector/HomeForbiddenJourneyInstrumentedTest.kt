package dev.mote.collector

import dev.mote.collector.plugins.NativeRecordReceipt
import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.lifecycle.Lifecycle
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Home 403 lifecycle on the production views, against a generated loopback Central: a revoked
 * read withdraws its rows, the retry affordance survives leaving and returning, a callback that
 * lands after a pause cannot strand the section, a same-generation resolution failure keeps the
 * denied affordance ready, and an explicit retry recovers the same session.
 * Cadence is selected separately with `journeyCadenceFixture=true` and the instrumentation-only
 * `--no-hidden-api-checks` flag for the platform's exact streaming trace entry.
 */
@RunWith(AndroidJUnit4::class)
class HomeForbiddenJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val conversation = "6c1a8d2f-4e5b-4c7a-9d3e-1f2a3b4c5d6e"
    private val action = "2f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun inStage(vararg stages: Stage): List<Activity> {
        val found = mutableListOf<Activity>()
        instrumentation.runOnMainSync { stages.forEach { found += ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) } }
        return found
    }
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(100) }
        val labels = inStage(Stage.RESUMED).firstOrNull()?.let { top -> var value = ""; instrumentation.runOnMainSync { value = top.javaClass.simpleName + ": " + shown(top).filterIsInstance<TextView>().map { it.text.toString() }.joinToString(" | ") }; value }
        fail("$description — $labels")
    }
    private fun onTop(description: String, check: (Activity) -> Boolean): Activity {
        var top: Activity? = null
        until(description) { inStage(Stage.RESUMED).firstOrNull()?.let { activity -> var ok = false; instrumentation.runOnMainSync { ok = check(activity) }; if (ok) top = activity; ok } ?: false }
        return top!!
    }
    /** A view inside one home section (whose root carries [sectionTag]); null when absent. */
    private fun inside(activity: Activity, sectionTag: String, find: (View) -> Boolean): View? {
        val section = shown(activity).firstOrNull { it.tag == sectionTag } ?: return null
        return views(section).filter { it.isShown }.firstOrNull(find)
    }
    private fun clickInside(activity: Activity, sectionTag: String, find: (View) -> Boolean) =
        instrumentation.runOnMainSync { requireNotNull(inside(activity, sectionTag, find)).performClick() }
    private fun retry(activity: Activity, sectionTag: String) = inside(activity, sectionTag) { it is TextView && it.text == MoteI18n.text("重试") && it.isClickable }
    private fun tagged(activity: Activity, tag: String) = shown(activity).any { it.tag == tag }
    private fun hasText(activity: Activity, value: String) = shown(activity).any { it is TextView && it.text.toString() == value }
    private fun emptyConversationLabel(activity: Activity) = inside(activity, "home-recent-conversations") { it is TextView && it.text.toString().startsWith("还没有对话") }

    private fun connect(fixture: Fixture) {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = fixture.origin, token = "generated-journey-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
    }
    private fun disconnect() {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = "", token = "", authSignedOut = true))
    }
    /**
     * Makes the next [CentralAccess.resolve] throw through the real endpoint validation while the
     * session generation stays untouched: `debugHttp` is not part of the generation hash, so the
     * same session either keeps or regains its denied retry, never a silent re-read.
     */
    private fun blockResolve() {
        check(context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().putBoolean("debugHttp", false).commit())
    }
    private fun unblockResolve() {
        check(context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().putBoolean("debugHttp", true).commit())
    }
    private fun sessionGeneration() = CentralSession.get(context).generation
    private fun conversationRead(home: Activity): Pair<UiTask, HomeReadGate> {
        var value: Pair<UiTask, HomeReadGate>? = null
        instrumentation.runOnMainSync {
            val section = shown(home).single { it.tag == "home-recent-conversations" }
            fun field(name: String) = HomeConversationView::class.java.getDeclaredField(name).apply { isAccessible = true }.get(section)
            value = (field("task") as UiTask) to (field("gate") as HomeReadGate)
        }
        return requireNotNull(value)
    }
    /** Holds only this production task's publication, then observes its actual UI runnable. */
    private class DeliveryBarrier(private val task: UiTask) : UiTask.ResultDeliveryObserver, AutoCloseable {
        private val previous = task.resultDeliveryObserver
        private val held = AtomicBoolean()
        val ready = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val outcome = AtomicReference<Result<*>?>()
        @Volatile var delivered = true
        @Volatile var releasedInTime = false
        init { check(previous == null); task.resultDeliveryObserver = this }
        override fun resultReady(outcome: Result<*>) {
            if (!held.compareAndSet(false, true)) return
            this.outcome.set(outcome)
            ready.countDown()
            releasedInTime = release.await(15, TimeUnit.SECONDS)
        }
        override fun deliveryFinished(outcome: Result<*>, delivered: Boolean) {
            this.delivered = delivered
            finished.countDown()
        }
        override fun close() { release.countDown(); task.resultDeliveryObserver = previous }
    }
    private fun navigate(home: Activity, name: String, requireHomeIdle: Boolean = false): Boolean {
        var navigated = false
        instrumentation.runOnMainSync {
            if (requireHomeIdle) {
                val sections = views(home.window.decorView).filter { it.tag in setOf("home-recent-conversations", "home-calendar-needs", "home-existing-discovery") }
                assertEquals("all three production sections participate in the boundary", 3, sections.size)
                if (sections.any { section -> (section.javaClass.getDeclaredField("task").apply { isAccessible = true }.get(section) as UiTask).busy }) return@runOnMainSync
            }
            val method = MainActivity::class.java.declaredMethods.single { it.name == "showPage" }
            method.isAccessible = true
            val page = method.parameterTypes[0].enumConstants!!.first { (it as Enum<*>).name == name }
            method.invoke(home, page, false, null)
            val current = MainActivity::class.java.getDeclaredField("currentPage").apply { isAccessible = true }.get(home) as Enum<*>
            assertEquals("the production navigation reaches $name", name, current.name)
            navigated = true
        }
        return navigated
    }

    /** Exact streaming ART entries; a final summary and tail control reject truncated traces. */
    private fun capturePageEntries(trace: File): Int {
        java.io.DataInputStream(trace.inputStream().buffered(256 * 1024)).use { input ->
            fun u16() = input.readUnsignedByte() or (input.readUnsignedByte() shl 8)
            fun u32() = Integer.reverseBytes(input.readInt()).toLong() and 0xffffffffL
            fun text(size: Int): String {
                require(size in 0..1_000_000)
                return ByteArray(size).also(input::readFully).toString(Charsets.UTF_8)
            }
            fun skip(size: Int) { assertEquals("complete trace record", size, input.skipBytes(size)) }
            val header = ByteArray(32).also(input::readFully)
            val data = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
            assertEquals("ART magic", 0x574f4c53, data.int)
            val version = data.short.toInt() and 0xffff
            assertEquals("streaming ART trace", 0xf0, version and 0xf0)
            assertEquals("dual-clock exact trace", 3, version and 0xf)
            assertEquals("complete header", 32, data.short.toInt())
            val recordSize = data.getShort(16).toInt() and 0xffff
            assertEquals("complete dual-clock record", 14, recordSize)
            val captures = mutableSetOf<Long>()
            val tail = mutableSetOf<Long>()
            var calls = 0; var tailCalls = 0; var tailSeen = false; var records = 0L
            while (true) {
                val thread = u16() // EOF before the summary fails rather than accepting a prefix.
                if (thread == 0) {
                    when (val operation = input.readUnsignedByte()) {
                        1 -> {
                            val method = text(u16()).trimEnd().split('\t')
                            require(method.size > 2)
                            val id = method[0].removePrefix("0x").toLong(16)
                            if (method[1].replace('.', '/') == "dev/mote/collector/DurableQueue" && method[2] == "capturePage") captures.add(id)
                            if (method[1].replace('.', '/') == "dev/mote/collector/HomeForbiddenJourneyInstrumentedTest" && method[2] == "traceTailControl") tail.add(id)
                        }
                        2 -> { u16(); skip(u16()) }
                        3 -> {
                            val summary = text(u32().toInt())
                            assertTrue("ART must finish without overflow: $summary", summary.lineSequence().any { it == "data-file-overflow=false" })
                            assertTrue("the summary is complete", summary.endsWith("*end\n"))
                            assertEquals("no records follow the final summary", -1, input.read())
                            assertTrue("the end-of-journey control executed", tailSeen)
                            assertEquals("the tail control's real capturePage was recorded", 1, tailCalls)
                            assertTrue("head and tail positive controls executed", calls >= 2)
                            android.util.Log.i("MoteAcceptance", "ART streaming bytes=${trace.length()} records=$records overflow=false head/tail controls present")
                            return calls - 2
                        }
                        else -> error("Unknown ART stream operation $operation")
                    }
                } else {
                    val method = u32()
                    skip(recordSize - 6)
                    records++
                    if (method and 3L == 0L) {
                        val id = method and 0xfffffffcL
                        if (id in tail) tailSeen = true
                        if (id in captures) { calls++; if (tailSeen) tailCalls++ }
                    }
                }
            }
        }
    }
    private fun startTrace(trace: File) {
        // The SDK source exposes this FD streaming entry to platform tools. Reflection keeps
        // this diagnostic-only call out of production and avoids a finite-buffer prefix.
        java.io.FileOutputStream(trace).use { output ->
            android.os.Debug::class.java.getDeclaredMethod("startMethodTracing", String::class.java,
                java.io.FileDescriptor::class.java, Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType, Boolean::class.javaPrimitiveType)
                .invoke(null, trace.absolutePath, output.fd, 8 * 1024 * 1024, 0, true)
        }
    }
    private fun requireWorkingTraceTransport() {
        val trace = File.createTempFile("generated-art-control-", ".trace", context.cacheDir)
        try {
            startTrace(trace)
            try {
                context.queue().capturePage("1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z", source = "note")
                traceTailControl()
            } finally { android.os.Debug.stopMethodTracing() }
            assertEquals("short real transport control has exactly its two explicit calls", 0, capturePageEntries(trace))
        } finally { trace.delete() }
    }
    private fun traceTailControl() { context.queue().capturePage("1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z", source = "note") }
    /**
     * The index a test run may leave behind for the loopback origin; teardown removes it so the
     * profile returns to the proven-clean state the guard requires before any mutation.
     */
    private val generatedNativeIndex get() = File(context.noBackupFilesDir, "central-native/" + SourceRules.hash("http://127.0.0.1:47913"))
    /**
     * An emulator fingerprint does not prove the profile is task-owned and generated; the journey
     * refuses to mutate a profile that could hold real records, credentials, synced sources or a
     * running capture. A fixed port cannot prove ownership either, so any pre-existing
     * central-native state (which may hold a disconnected localhost Central's ask/note drafts)
     * rejects the run before a single mutation. `enabled == false` also means teardown has no
     * capture scheduling to restart.
     */
    private fun requireGeneratedProfile() {
        val natives = File(context.noBackupFilesDir, "central-native")
        require(!natives.exists() || (natives.isDirectory && natives.listFiles()?.isEmpty() == true)) { "generated fixture needs a profile without any prior central-native state" }
        val archives = File(context.noBackupFilesDir, "file-archives")
        require(!archives.exists() || (archives.isDirectory && archives.listFiles()?.isEmpty() == true)) { "generated fixture needs a profile without retained file archives" }
        val settings = Settings(context)
        val config = settings.read()
        require(config.token.isEmpty() && config.server in setOf("", BuildConfig.DEFAULT_SERVER)) { "generated fixture needs an unconfigured profile" }
        require(!settings.enabled && settings.lastCapture() == null) { "generated fixture needs a task-owned profile: capture must not be enabled or have captured" }
        require(runCatching { settings.dataOrigin() }.getOrDefault("unreadable").isBlank()) { "generated fixture needs a profile without a retained origin" }
        val queueDirectory = File(QueueStorage(context).selected().path)
        require(listOf(".capture-stages.inbox", ".capture-stages.journal").none { File(queueDirectory, it).exists() }) { "generated fixture needs a profile without pending stage recovery" }
        require(!settings.hasPendingData()) { "generated fixture needs a profile without pending records, drafts or uploads" }
        val note = QuickNotes.draft(context).read()
        require(note.text.isEmpty() && note.mood.isEmpty() && note.prepared == null) { "generated fixture needs a profile without a note draft" }
        val records = context.recordDraftStore()
        val draft = records.draft()
        require(draft.optString("text").isEmpty() && draft.optString("description").isEmpty() && draft.optJSONObject("origin")?.optString("text").orEmpty().isEmpty() && draft.optJSONArray("attachments")?.length() == 0 &&
            !draft.has("prepared") && records.pendingMedia().length() == 0) { "generated fixture needs a profile without a record draft or pending import" }
        require(context.queue().inventory().records == 0) { "generated fixture needs a profile without stored records" }
        require(context.localSources().sources().isEmpty()) { "generated fixture needs a profile without synced local sources" }
        require(context.localFileContents(8).isEmpty()) { "generated fixture needs a profile without synced file contents" }
    }
    private fun reset() {
        val settings = Settings(context)
        settings.enabled = false
        settings.save(settings.read().copy(server = "", token = "", debugHttp = false, screenCollectionEnabled = true, notificationCollectionEnabled = false, syncPaused = false))
        settings.screenPaused(null); settings.status("paused", "生成的初始状态")
        context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().remove("capturePreviewSeen").remove("lastCapture").commit()
        NativeRecordReceipt.recordId = null
        NativeRecordReceipt.fromFirstUse = false
    }

    private var armed = false
    private var savedMotePrefs: Map<String, Any?> = emptyMap()
    private var savedAppearance = "auto"
    private var savedLanguage = "system"
    private var savedReceipt: String? = null
    private var savedReceiptFromFirstUse = false

    /** Restore the exact pre-test profile: preference snapshot, appearance, language and receipt. */
    private fun restoreProfile() {
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
        val edit = prefs.edit()
        prefs.all.keys.forEach { if (it !in savedMotePrefs) edit.remove(it) }
        savedMotePrefs.forEach { (key, value) ->
            when (value) {
                is String -> edit.putString(key, value)
                is Int -> edit.putInt(key, value)
                is Long -> edit.putLong(key, value)
                is Boolean -> edit.putBoolean(key, value)
                is Float -> edit.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") edit.putStringSet(key, value as Set<String>)
            }
        }
        check(edit.commit())
        MoteI18n.select(context, savedLanguage)
        MoteAppearance.select(context, AppearancePreference.parse(savedAppearance))
        NativeRecordReceipt.recordId = savedReceipt
        NativeRecordReceipt.fromFirstUse = savedReceiptFromFirstUse
        // The guard proved the directory was absent before this run; anything now present is ours.
        generatedNativeIndex.deleteRecursively()
    }

    @Before fun generatedOnly() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("journeyHomeFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev") { "Run only in the isolated development package" }
        require(Build.FINGERPRINT.contains("emu64a")) { "Run only on a task-owned emulator" }
        requireGeneratedProfile()
        savedMotePrefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        savedAppearance = context.getSharedPreferences("mote.appearance", Context.MODE_PRIVATE).getString("appearance", "auto") ?: "auto"
        savedLanguage = context.getSharedPreferences("mote.language", Context.MODE_PRIVATE).getString("language", "system") ?: "system"
        savedReceipt = NativeRecordReceipt.recordId
        savedReceiptFromFirstUse = NativeRecordReceipt.fromFirstUse
        armed = true
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        reset()
    }
    /** Skipped tests never ran: an unarmed teardown leaves the task-owned profile untouched. */
    @After fun restore() {
        if (!armed) return
        armed = false
        restoreProfile()
    }

    @Test fun aPreexistingNativeDraftRejectsBeforeMutationAndUnarmedTeardown() {
        // This outer fixture already proved the directory absent. The new fixture instance must
        // treat this generated sentinel exactly like an unknown owner's retained draft.
        val directory = generatedNativeIndex
        check(directory.mkdir() || directory.parentFile!!.mkdirs() && directory.mkdir())
        val sentinel = File(directory, "generated-retained-ask-draft.enc").apply { writeText("generated retained draft") }
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        val language = MoteI18n.preference()
        val appearance = context.getSharedPreferences("mote.appearance", Context.MODE_PRIVATE).all.toMap()
        val receipt = NativeRecordReceipt.recordId to NativeRecordReceipt.fromFirstUse
        try {
            val rejected = HomeForbiddenJourneyInstrumentedTest()
            assertThrows(IllegalArgumentException::class.java) { rejected.generatedOnly() }
            rejected.restore()
            assertEquals("an unarmed teardown never rewrites profile preferences", prefs, context.getSharedPreferences("mote", Context.MODE_PRIVATE).all)
            assertEquals(language, MoteI18n.preference())
            assertEquals(appearance, context.getSharedPreferences("mote.appearance", Context.MODE_PRIVATE).all)
            assertEquals(receipt, NativeRecordReceipt.recordId to NativeRecordReceipt.fromFirstUse)
            assertEquals("the pre-existing draft survives preflight rejection and teardown", "generated retained draft", sentinel.readText())
        } finally { check(directory.deleteRecursively()) }
    }

    @Test fun aPendingStageRejectsBeforeReplayAndUnarmedTeardown() {
        val inbox = File(QueueStorage(context).selected().path, ".capture-stages.inbox")
        check(!inbox.exists())
        val bytes = "generated pending stage must never be opened by preflight".toByteArray()
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        try {
            inbox.writeBytes(bytes)
            val rejected = HomeForbiddenJourneyInstrumentedTest()
            val failure = assertThrows(IllegalArgumentException::class.java) { rejected.generatedOnly() }
            assertTrue("preflight rejects the stage before queue replay", failure.message.orEmpty().contains("without pending stage recovery"))
            rejected.restore()
            assertArrayEquals("the rejected stage is preserved", bytes, inbox.readBytes())
            assertEquals("an unarmed teardown leaves the profile intact", prefs, context.getSharedPreferences("mote", Context.MODE_PRIVATE).all)
        } finally { check(inbox.delete()) }
    }

    @Test fun oneMinuteHomeCadencePreservesFivePageFanoutAndLocalPageLifecycle() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("journeyCadenceFixture") == "true")
        Fixture().use { fixture ->
            requireWorkingTraceTransport()
            fixture.calendarFivePages = true
            connect(fixture)
            val trace = File.createTempFile("generated-home-cadence-", ".trace", context.cacheDir)
            try {
                startTrace(trace)
                try {
                    context.queue().capturePage("1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z", source = "note")
                    ActivityScenario.launch(MainActivity::class.java).use {
                        val home = onTop("the fifth calendar page and real conversations render") { activity ->
                            tagged(activity, "home-conversation:$conversation") && tagged(activity, "home-calendar-need:$action") && tagged(activity, "home-discovery-history")
                        }
                        Thread.sleep(60_000)
                        instrumentation.runOnMainSync {
                            assertEquals("only two suggestions are shown", 2, shown(home).count { it.tag?.toString()?.startsWith("home-calendar-need:") == true })
                        }
                        // The last steady read may already have started at the minute boundary.
                        // Drain it and leave atomically on main, so later HTTP is genuinely new
                        // hidden-page work rather than the completion of a pre-pause request.
                        until("accepted home reads finish before the atomic leave") { navigate(home, "MANAGE", requireHomeIdle = true) }
                        val idle = fixture.requests.toList()
                        val conversations = idle.count { it.startsWith("/api/conversations?") }
                        val discovery = idle.count { it.startsWith("/api/insights?") }
                        val calendar = idle.count { it == "/api/actions?cursor=0" }
                        val pages = idle.count { it.startsWith("/api/actions?") }
                        assertTrue("conversations: $conversations", conversations in 1..2)
                        assertTrue("discovery: $discovery", discovery in 1..2)
                        assertTrue("calendar logical reads: $calendar", calendar in 1..2)
                        assertEquals("every calendar read retains the complete five-page scan", calendar * 5, pages)
                        android.util.Log.i("MoteAcceptance", "Home 60s logical=$conversations/$discovery/$calendar httpHome=${conversations + discovery + pages} httpAll=${idle.size} calendarPages=$pages")
                        val offHome = fixture.requests.size
                        Thread.sleep(2_500)
                        navigate(home, "SOURCES")
                        Thread.sleep(2_500)
                        assertEquals("the hidden home does not read Central on MANAGE or SOURCES", offHome, fixture.requests.size)
                        navigate(home, "OVERVIEW")
                        until("returning home immediately reads all three sections") {
                            val returned = fixture.requests.toList().drop(offHome)
                            returned.any { it.startsWith("/api/conversations?") } && returned.any { it.startsWith("/api/insights?") } && returned.any { it == "/api/actions?cursor=4" }
                        }
                    }
                    traceTailControl()
                } finally { android.os.Debug.stopMethodTracing() }
                val calls = capturePageEntries(trace)
                android.util.Log.i("MoteAcceptance", "Home initial+60s+MANAGE/SOURCES/OVERVIEW production capturePage=$calls; head/tail positive controls excluded, no trace overflow")
                assertTrue("home lifecycle performs at most its initial page read: $calls", calls <= 1)
            } finally { trace.delete() }
        }
    }

    @Test fun aRevokedHomeReadWithdrawsRowsAndKeepsAUsableRetryAcrossPauses() {
        Fixture().use { fixture ->
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The generated rows come from the production home sections") { activity ->
                    tagged(activity, "home-conversation:$conversation") && tagged(activity, "home-calendar-need:$action") && tagged(activity, "home-discovery-history")
                }
                // The first resolve selects the origin and bumps the lazy generation; the
                // same-session baseline only exists once the rows proved that resolve happened.
                val generation = sessionGeneration()
                // Revoke while a held conversations read lets the owner pause before its callback.
                fixture.holdConversations = true
                fixture.forbidden = true
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                assertTrue("the denied conversations read is in flight", fixture.conversationsEntered.await(15, TimeUnit.SECONDS))
                scenario.moveToState(Lifecycle.State.STARTED) // pause between the probe and the callback
                fixture.releaseConversations.countDown()
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("A 403 withdraws the rows and every denied section offers a retry") {
                    !tagged(home, "home-conversation:$conversation") && !tagged(home, "home-calendar-need:$action") && !tagged(home, "home-discovery-history") &&
                        retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("The denied affordances survive leaving and returning home") {
                    !tagged(home, "home-conversation:$conversation") &&
                        retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                // A same-generation resolution failure hides the affordances; the denied state survives
                // without a session change and re-renders once resolution recovers.
                blockResolve()
                until("A resolve failure clears the sections without reviving reads or retries") {
                    !tagged(home, "home-conversation:$conversation") && retry(home, "home-recent-conversations") == null &&
                        retry(home, "home-calendar-needs") == null && retry(home, "home-existing-discovery") == null
                }
                unblockResolve()
                until("The denied retry returns once access resolves again on the same session") {
                    retry(home, "home-recent-conversations") != null && retry(home, "home-calendar-needs") != null && retry(home, "home-existing-discovery") != null
                }
                assertEquals("the transient failure must not change the session generation", generation, sessionGeneration())
                fixture.forbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The conversations retry issues a fresh read and restores the row") { tagged(home, "home-conversation:$conversation") }
                clickInside(home, "home-calendar-needs") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The calendar retry restores its row") { tagged(home, "home-calendar-need:$action") }
                clickInside(home, "home-existing-discovery") { it is TextView && it.text == MoteI18n.text("重试") }
                until("The discovery retry restores its card") { tagged(home, "home-discovery-history") }
                assertEquals("the explicit retry recovers on the same session", generation, sessionGeneration())
            }
        }
    }

    @Test fun aDeniedArchiveProbeShowsRetryNotAFalseEmptyHome() {
        Fixture().use { fixture ->
            fixture.conversationsEmpty = true
            fixture.probeForbidden = true
            fixture.holdProbe = true
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The home opens with a resumable conversations section") { it is MainActivity }
                // Hold the real archive probe, then let its 403 complete while the stamp is still
                // current — but drop its UI callback across a pause: the denied affordance must
                // come from a real re-read, never a fake empty home.
                assertTrue("the empty-conversations read reached the archive probe", fixture.probeEntered.await(15, TimeUnit.SECONDS))
                val (task, gate) = conversationRead(home)
                val stamp = HomeReadGate::class.java.getDeclaredField("epoch").apply { isAccessible = true }.getLong(gate)
                val generation = sessionGeneration()
                DeliveryBarrier(task).use { delivery ->
                    fixture.releaseProbe.countDown()
                    assertTrue("the real worker completed the probe", delivery.ready.await(15, TimeUnit.SECONDS))
                    assertEquals("the real HTTP probe failed with 403", 403, (delivery.outcome.get()?.exceptionOrNull() as? CentralFailure)?.status)
                    assertTrue("the completed probe still belongs to the current gate stamp", gate.current(stamp))
                    assertEquals("the worker completed on the current session", generation, sessionGeneration())
                    scenario.moveToState(Lifecycle.State.STARTED)
                    assertFalse("the real pause invalidates the completed read stamp", gate.current(stamp))
                    delivery.release.countDown()
                    assertTrue("the actual worker-posted UI delivery runnable executed", delivery.finished.await(10, TimeUnit.SECONDS))
                    assertTrue("publication was released within the original hold timeout", delivery.releasedInTime)
                    assertFalse("the actual UI delivery was dropped while paused", delivery.delivered)
                    instrumentation.runOnMainSync {
                        assertNull("the paused failure cannot render a retry", retry(home, "home-recent-conversations"))
                    }
                }
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("A denied probe fails the read instead of claiming an empty archive") {
                    retry(home, "home-recent-conversations") != null && emptyConversationLabel(home) == null &&
                        !tagged(home, "home-notice-connect")
                }
                assertTrue("the dropped probe answer did not mark the archive; the read probes again", fixture.probeRequests.get() >= 2)
                fixture.probeForbidden = false
                clickInside(home, "home-recent-conversations") { it is TextView && it.text == MoteI18n.text("重试") }
                until("A recovered probe confirms the empty archive and the first-use home shows") {
                    !tagged(home, "home-recent-conversations") && !tagged(home, "home-notice-connect")
                }
                instrumentation.runOnMainSync {
                    assertFalse("the confirmed empty archive hides the section rather than faking rows", tagged(home, "home-conversation:$conversation"))
                }
            }
        }
    }

    @Test fun anInconclusiveProbeKeepsAnHonestEmptyUntilTheNextSessionRechecks() {
        Fixture().use { fixture ->
            fixture.conversationsEmpty = true
            fixture.malformedCaptures = true
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val home = onTop("The home opens with a resumable conversations section") { it is MainActivity }
                until("A malformed storage.captures probe is inconclusive: truthful empty label, no first-use hide") {
                    emptyConversationLabel(home) != null && !tagged(home, "home-notice-connect")
                }
                // A session change re-arms the probe; a held answer released while paused still
                // cannot mark the new generation done, so the next read probes for real. The
                // disconnected stamp must be observed by a real refresh first, or the instant
                // reconnect leaves the generation — and the old probe schedule — untouched.
                fixture.malformedCaptures = false
                fixture.holdProbe = true
                val previous = sessionGeneration()
                disconnect()
                until("the disconnected session is observed before reconnecting") { sessionGeneration() != previous }
                connect(fixture)
                assertTrue("the new session reached the archive probe", fixture.probeEntered.await(15, TimeUnit.SECONDS))
                val (task, _) = conversationRead(home)
                DeliveryBarrier(task).use { delivery ->
                    scenario.moveToState(Lifecycle.State.STARTED)
                    fixture.releaseProbe.countDown()
                    assertTrue("the real worker completed the held probe while paused", delivery.ready.await(15, TimeUnit.SECONDS))
                    assertTrue("the held probe completed successfully", delivery.outcome.get()?.isSuccess == true)
                    delivery.release.countDown()
                    assertTrue("the actual held-result delivery runnable executed", delivery.finished.await(10, TimeUnit.SECONDS))
                    assertTrue("publication was released within the original hold timeout", delivery.releasedInTime)
                    assertFalse("the held answer was actually dropped while paused", delivery.delivered)
                }
                scenario.moveToState(Lifecycle.State.RESUMED)
                until("The rechecked probe confirms the empty archive and the first-use home shows") {
                    !tagged(home, "home-recent-conversations") && !tagged(home, "home-notice-connect")
                }
                assertTrue("the malformed and held answers never stood in for a real probe", fixture.probeRequests.get() >= 3)
            }
        }
    }

    /** Loopback Central with switchable 403s, malformed storage counts and holdable reads. */
    private inner class Fixture : AutoCloseable {
        private val listener = ServerSocket().apply { reuseAddress = true; bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), 47913), 16) }
        val origin = "http://127.0.0.1:${listener.localPort}"
        @Volatile var forbidden = false
        @Volatile var probeForbidden = false
        @Volatile var conversationsEmpty = false
        @Volatile var malformedCaptures = false
        @Volatile var holdConversations = false
        @Volatile var holdProbe = false
        @Volatile var calendarFivePages = false
        val requests = ConcurrentLinkedQueue<String>()
        val probeRequests = AtomicInteger()
        val conversationsEntered = CountDownLatch(1)
        val releaseConversations = CountDownLatch(1)
        val probeEntered = CountDownLatch(1)
        val releaseProbe = CountDownLatch(1)
        private val executor = Executors.newCachedThreadPool()
        init {
            executor.submit {
                while (!listener.isClosed) runCatching { listener.accept() }.getOrNull()?.let { socket -> executor.submit { runCatching { serve(socket) } } }
            }
        }
        private fun serve(socket: java.net.Socket) {
            socket.use {
                val input = it.getInputStream().bufferedReader()
                val path = input.readLine().orEmpty().split(' ').getOrElse(1) { "" }
                requests.add(path)
                while (!input.readLine().isNullOrBlank()) Unit
                val probe = path == "/api/status" || path.startsWith("/api/library/catalog") || path.startsWith("/api/files")
                if (probe) probeRequests.incrementAndGet()
                val heldProbe = probe && holdProbe
                if (heldProbe) { probeEntered.countDown(); releaseProbe.await(30, TimeUnit.SECONDS) }
                if (path.startsWith("/api/conversations?") && holdConversations) { conversationsEntered.countDown(); releaseConversations.await(30, TimeUnit.SECONDS) }
                val status: Int; val payload: JSONObject
                when {
                    forbidden || (probeForbidden && probe) -> { status = 403; payload = JSONObject().put("error", JSONObject().put("code", "forbidden")) }
                    path.startsWith("/api/conversations?") -> {
                        status = 200; payload = JSONObject().put("items", if (conversationsEmpty) JSONArray() else JSONArray().put(JSONObject()
                            .put("id", conversation).put("title", "生成的跨设备对话").put("updatedAt", "2026-10-30T10:00:00Z").put("turnCount", 2)))
                    }
                    path.startsWith("/api/actions?") -> {
                        status = 200; payload = JSONObject().put("nextCursor", JSONObject.NULL).put("targets", JSONArray()).put("items", JSONArray().put(JSONObject()
                            .put("id", action).put("version", 1).put("kind", "calendar.create").put("status", "proposed").put("evidence", JSONArray())
                            .put("event", JSONObject().put("title", "生成的设计评审").put("start", JSONObject.NULL).put("end", JSONObject.NULL).put("timeZone", "Asia/Shanghai").put("allDay", false).put("location", "").put("description", ""))))
                    }
                    path.startsWith("/api/insights?") -> {
                        status = 200; payload = JSONObject().put("items", JSONArray().put(JSONObject()
                            .put("runId", "generated-insight-1").put("answer", "生成的回顾结论").put("status", "completed")
                            .put("citations", JSONArray().put(JSONObject().put("id", "c1")))
                            .put("artifact", JSONObject().put("id", "generated-artifact-1").put("title", "生成的周回顾"))))
                    }
                    path == "/api/status" -> { status = 200; payload = JSONObject().put("storage", JSONObject().put("captures", if (malformedCaptures) "zero" else 0)) }
                    path.startsWith("/api/library/catalog") || path.startsWith("/api/files") -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                    path.startsWith("/api/model-settings") -> { status = 200; payload = JSONObject().put("profiles", JSONArray()) }
                    else -> { status = 200; payload = JSONObject().put("items", JSONArray()) }
                }
                if (calendarFivePages && path.startsWith("/api/actions?") && status == 200) {
                    val cursor = path.substringAfter("cursor=").substringBefore('&').toInt()
                    payload.put("nextCursor", if (cursor < 4) cursor + 1 else JSONObject.NULL)
                    if (cursor < 4) payload.put("items", JSONArray()) else {
                        val first = payload.getJSONArray("items").getJSONObject(0)
                        payload.getJSONArray("items").put(JSONObject(first.toString()).put("id", "3f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"))
                            .put(JSONObject(first.toString()).put("id", "4f4b6d8a-1c3e-4a5b-8c7d-9e0f1a2b3c4d"))
                    }
                }
                val body = payload.toString().toByteArray()
                it.getOutputStream().apply { write("HTTP/1.1 $status ${if (status == 200) "OK" else "Forbidden"}\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(body); flush() }
            }
        }
        override fun close() { listener.close(); executor.shutdownNow() }
    }
}
