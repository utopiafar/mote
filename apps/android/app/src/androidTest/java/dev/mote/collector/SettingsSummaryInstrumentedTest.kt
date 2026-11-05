package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Generated profile only: configuration reads and the retained Settings page are real. */
@RunWith(AndroidJUnit4::class)
class SettingsSummaryInstrumentedTest {
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }

    private fun row(activity: MainActivity, label: String): View =
        views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }.also {
            assertNotNull("The visible Settings row must have its own detail", it.findViewWithTag<TextView>("row-detail"))
        }

    private fun detail(row: View) = requireNotNull(row.findViewWithTag<TextView>("row-detail")).text.toString()

    @Test fun cachedCardsFollowCommittedChangesAndUnavailableReadsWithoutReplacingThePage() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && context.localSources().sources().isEmpty())
        val prefs = context.getSharedPreferences("mote", 0)
        val original = prefs.all.toMap()
        val originalLanguage = MoteI18n.preference()
        val manager = WorkManager.getInstance(context)
        val work = listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-heartbeat", "mote-heartbeat-now", "mote-source-upload")
        fun cancel() = work.forEach { manager.cancelUniqueWork(it).result.get(10, TimeUnit.SECONDS) }
        val old = "https://old.generated.invalid"
        val oldHost = "old.generated.invalid"
        val paired = "https://paired.generated.invalid"
        val pairedHost = "paired.generated.invalid"
        val token = "generated-settings-summary-token-1234567890"
        fun waitFor(scenario: ActivityScenario<MainActivity>, label: String, value: String) {
            val until = SystemClock.elapsedRealtime() + 15_000
            var current = ""
            do {
                scenario.onActivity { activity -> current = detail(row(activity, label)) }
                if (current == value) return
                Thread.sleep(50)
            } while (SystemClock.elapsedRealtime() < until)
            fail("Expected $label to show $value, got $current")
        }
        try {
            cancel(); MoteI18n.select(context, "zh-CN")
            settings.save(settings.read().copy(server = old, token = token, syncMode = "manual", syncPaused = false), confirmCentralEndpoint = true)
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SETTINGS")).awaitMainUi().use { scenario ->
                waitFor(scenario, "连接与设备", oldHost)
                lateinit var card: View
                lateinit var scroll: ScrollView
                lateinit var originalActivity: MainActivity
                var initialScroll = 0
                scenario.onActivity { activity ->
                    originalActivity = activity
                    card = row(activity, "连接与设备")
                    var parent = card.parent
                    while (parent !is ScrollView) parent = parent.parent
                    scroll = parent
                    scroll.scrollTo(0, 120); card.isFocusableInTouchMode = true
                    assertTrue("The card can receive focus", card.requestFocus())
                }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity { initialScroll = scroll.scrollY; assertTrue(card.isFocused) }
                settings.save(settings.read().copy(server = paired), confirmCentralEndpoint = true)
                waitFor(scenario, "连接与设备", pairedHost)
                scenario.onActivity { activity ->
                    assertSame("A settings refresh keeps the same Activity", originalActivity, activity)
                    assertSame("A settings refresh does not rebuild its card", card, row(activity, "连接与设备"))
                    assertTrue(card.contentDescription.toString().startsWith("连接与设备，$pairedHost"))
                    assertEquals("Settings scroll is retained", initialScroll, scroll.scrollY)
                    assertTrue("Settings focus is retained", card.isFocused)
                }
                // Pause first so no prior status job can be mistaken for the returning read.
                scenario.moveToState(Lifecycle.State.STARTED)
                val loadingField = MainActivity::class.java.getDeclaredField("statusLoading").apply { isAccessible = true }
                val executorField = MainActivity::class.java.getDeclaredField("statusExecutor").apply { isAccessible = true }
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                val idleDeadline = SystemClock.elapsedRealtime() + 15_000
                var idle = false
                while (!idle && SystemClock.elapsedRealtime() < idleDeadline) {
                    instrumentation.runOnMainSync { idle = !loadingField.getBoolean(originalActivity) }
                    if (!idle) Thread.sleep(25)
                }
                assertTrue("The earlier status read must finish before holding the executor", idle)
                val readBlocked = CountDownLatch(1); val releaseRead = CountDownLatch(1); val blockerFinished = CountDownLatch(1)
                val afterReturn = "https://after-return.generated.invalid"
                val afterReturnHost = "after-return.generated.invalid"
                (executorField.get(originalActivity) as ExecutorService).execute {
                    readBlocked.countDown()
                    try { check(releaseRead.await(35, TimeUnit.SECONDS)) { "The returning status read was never released" } }
                    finally { blockerFinished.countDown() }
                }
                try {
                    assertTrue("The returning status read must be held", readBlocked.await(15, TimeUnit.SECONDS))
                    instrumentation.runOnMainSync { assertFalse("No status read may be in flight before resume", loadingField.getBoolean(originalActivity)) }
                    settings.save(settings.read().copy(server = afterReturn), confirmCentralEndpoint = true)
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    val submittedDeadline = SystemClock.elapsedRealtime() + 15_000
                    var submitted = false
                    while (!submitted && SystemClock.elapsedRealtime() < submittedDeadline) {
                        scenario.onActivity { submitted = loadingField.getBoolean(it) }
                        if (!submitted) Thread.sleep(25)
                    }
                    assertTrue("A new status read must be submitted after resume", submitted)
                    assertEquals("The executor must still be held", 1L, blockerFinished.count)
                    scenario.onActivity { activity ->
                        val connection = row(activity, "连接与设备")
                        assertSame("Returning retains the original Activity", originalActivity, activity)
                        assertEquals("正在读取本机设置…", detail(connection))
                        assertEquals("连接与设备，正在读取本机设置…", connection.contentDescription.toString())
                        assertFalse(connection.contentDescription.toString().contains(pairedHost))
                        assertNull("Settings no longer carries send settings", views(activity.window.decorView).firstOrNull { it.tag == "menu:同步与上传" })
                    }
                } finally { releaseRead.countDown() }
                waitFor(scenario, "连接与设备", afterReturnHost)
                settings.save(settings.read().copy(server = "", token = ""), confirmCentralEndpoint = true)
                waitFor(scenario, "连接与设备", "尚未连接")
                scenario.onActivity { activity -> assertTrue(row(activity, "连接与设备").contentDescription.toString().startsWith("连接与设备，尚未连接")) }

                // Corrupt only this generated profile's format marker to exercise a real read failure.
                val format = prefs.getInt("configurationFormat", 0)
                try {
                    check(prefs.edit().putInt("configurationFormat", -1).commit())
                    waitFor(scenario, "连接与设备", "暂不可读取")
                    scenario.onActivity { activity ->
                        assertEquals("连接与设备，暂不可读取", row(activity, "连接与设备").contentDescription.toString())
                        assertSame(card, row(activity, "连接与设备"))
                    }
                } finally { check(prefs.edit().putInt("configurationFormat", format).commit()) }
                waitFor(scenario, "连接与设备", "尚未连接")
            }
        } finally {
            cancel(); MoteI18n.select(context, originalLanguage)
            val edit = prefs.edit().clear()
            original.forEach { (key, value) -> when (value) {
                is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value)
                is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value)
            } }
            check(edit.commit())
        }
    }

    @Test fun delayedOldSnapshotCannotReloadAnAlreadyCommittedNode() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && context.localSources().sources().isEmpty())
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val originalLanguage = MoteI18n.preference()
        val manager = WorkManager.getInstance(context)
        val work = listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-heartbeat", "mote-heartbeat-now", "mote-source-upload")
        fun cancel() = work.forEach { manager.cancelUniqueWork(it).result.get(10, TimeUnit.SECONDS) }
        val releaseMain = CountDownLatch(1); val releaseLatestRead = CountDownLatch(1)
        try {
            cancel(); MoteI18n.select(context, "zh-CN")
            val old = settings.read().copy(server = "https://old.generated.invalid", token = "generated-settings-summary-token-1234567890", syncMode = "manual", syncPaused = false)
            settings.save(old, confirmCentralEndpoint = true)
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SETTINGS")).awaitMainUi().use { scenario ->
                try {
                    val loading = MainActivity::class.java.getDeclaredField("statusLoading").apply { isAccessible = true }
                    val executorField = MainActivity::class.java.getDeclaredField("statusExecutor").apply { isAccessible = true }
                    val configField = MainActivity::class.java.getDeclaredField("loadedConfig").apply { isAccessible = true }
                    val refresh = MainActivity::class.java.getDeclaredMethod("refreshStatus").apply { isAccessible = true }
                    val reload = MainActivity::class.java.getDeclaredMethod("reloadSettings", CollectorConfig::class.java).apply { isAccessible = true }
                    val commit = MainActivity::class.java.getDeclaredMethod("commitSettingsSummaries", CollectorConfig::class.java).apply { isAccessible = true }
                    val until = SystemClock.elapsedRealtime() + 15_000
                    var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < until) {
                        scenario.onActivity { ready = !loading.getBoolean(it) && !QueueStorage.recovering && !ConnectionGuard.reconfiguring() }
                        if (!ready) Thread.sleep(25)
                    }
                    assertTrue("The first status read must finish before arranging the interleaving", ready)
                    lateinit var activity: MainActivity
                    scenario.onActivity { activity = it }
                    val readStatus = MainActivity::class.java.getDeclaredMethod("readStatus").apply { isAccessible = true }
                    val baselineSnapshot = (executorField.get(activity) as ExecutorService).submit<Any> { readStatus.invoke(activity) }.get(15, TimeUnit.SECONDS)
                    val snapshotConfig = baselineSnapshot.javaClass.getDeclaredField("config").apply { isAccessible = true }.get(baselineSnapshot) as CollectorConfig?
                    assertEquals("A real status read must be able to capture the old configuration", old.server, snapshotConfig?.server)
                    val oldReadDone = CountDownLatch(1); val mainBlocked = CountDownLatch(1); val observed = CountDownLatch(1)
                    val failure = AtomicReference<Throwable?>(); val observedNode = AtomicReference<String>(); val observedCard = AtomicReference<String>()
                    scenario.onActivity { current ->
                        refresh.invoke(current)
                        assertTrue("A real status read must have been submitted", loading.getBoolean(current))
                        (executorField.get(current) as ExecutorService).execute {
                            oldReadDone.countDown()
                            check(releaseLatestRead.await(20, TimeUnit.SECONDS)) { "Latest status read was never released" }
                        }
                        Handler(Looper.getMainLooper()).postAtFrontOfQueue {
                            try {
                                mainBlocked.countDown()
                                check(releaseMain.await(20, TimeUnit.SECONDS)) { "Main-thread interleaving was never released" }
                                val committed = settings.read()
                                // The same committed-state operations used by the real settings save callback.
                                reload.invoke(current, committed); commit.invoke(current, committed)
                            } catch (error: Throwable) { failure.set(error) }
                        }
                    }
                    assertTrue(mainBlocked.await(15, TimeUnit.SECONDS))
                    assertTrue("The old status snapshot must be queued before the new save", oldReadDone.await(15, TimeUnit.SECONDS))
                    val next = old.copy(server = "https://new.generated.invalid")
                    settings.save(next, confirmCentralEndpoint = true)
                    // This is queued after the old status callback, while the newer background read stays blocked.
                    Handler(Looper.getMainLooper()).post {
                        try {
                            observedNode.set((configField.get(activity) as CollectorConfig).server)
                            val card = row(activity, "连接与设备")
                            observedCard.set(detail(card))
                        } catch (error: Throwable) { failure.set(error) } finally { observed.countDown() }
                    }
                    releaseMain.countDown()
                    assertTrue("The stale callback and observation must execute", observed.await(15, TimeUnit.SECONDS))
                    assertNull(failure.get())
                    assertEquals("A queued old snapshot must not reload the old config", next.server, observedNode.get())
                    assertEquals("A queued old snapshot must not replace the new card", "new.generated.invalid", observedCard.get())
                } finally { releaseMain.countDown(); releaseLatestRead.countDown() }
            }
        } finally {
            releaseMain.countDown(); releaseLatestRead.countDown(); cancel(); MoteI18n.select(context, originalLanguage)
            val edit = prefs.edit().clear()
            original.forEach { (key, value) -> when (value) {
                is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value)
                is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value)
            } }
            check(edit.commit())
        }
    }

}
