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
        settings.save(original!!.copy(server = "", token = "", syncMode = "manual", diagnosticsEnabled = false))
    }

    @After fun restoreSettings() {
        original?.let { Settings(context).save(it) }
    }

    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }

    private fun navigate(activity: MainActivity, label: String) {
        fun click(text: String) = views(activity.window.decorView).filterIsInstance<TextView>()
            .single { it.isShown && it.isClickable && it.text.toString() == text }.also { assertTrue(it.performClick()) }
        when (label) {
            "来源" -> { click("本机"); views(activity.window.decorView).single { it.isShown && it.tag == "menu:本机来源" }.performClick() }
            "随手记" -> click("记录")
            "设置" -> assertTrue(click("本机").isSelected)
            "概览" -> assertTrue(click("今天").isSelected)
            else -> click(label)
        }
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
                scenario = ActivityScenario.launch(MainActivity::class.java).awaitMainUi()
                // Cold view inflation gets more budget than an input callback, but cannot wait on the 20 s lock.
                assertTrue("home must launch without waiting for queue work",
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
        val scenario = ActivityScenario.launch(MainActivity::class.java).awaitMainUi()
        lateinit var activity: MainActivity
        lateinit var executor: ExecutorService
        val updates = AtomicInteger()
        val updatesAtDestroy = AtomicInteger(-1)
        val application = context.applicationContext as android.app.Application
        val lifecycle = object : android.app.Application.ActivityLifecycleCallbacks {
            override fun onActivityDestroyed(value: android.app.Activity) { if (value === activity) updatesAtDestroy.set(updates.get()) }
            override fun onActivityCreated(value: android.app.Activity, state: android.os.Bundle?) = Unit
            override fun onActivityStarted(value: android.app.Activity) = Unit
            override fun onActivityResumed(value: android.app.Activity) = Unit
            override fun onActivityPaused(value: android.app.Activity) = Unit
            override fun onActivityStopped(value: android.app.Activity) = Unit
            override fun onActivitySaveInstanceState(value: android.app.Activity, state: android.os.Bundle) = Unit
        }
        try {
            scenario.onActivity {
                activity = it
                navigate(it, "设置")
                executor = field(it, "statusExecutor")
                field<kotlinx.coroutines.Job?>(it, "localStateJob")?.cancel()
                // Keep the Activity resumed while removing automatic requests.
                field<Handler>(it, "handler").removeCallbacks(field<Runnable>(it, "refresh"))
            }
            application.registerActivityLifecycleCallbacks(lifecycle)
            repeat(2) { executor.submit {}.get(10, TimeUnit.SECONDS); instrumentation.runOnMainSync {} }
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
                    assertTrue(field<Boolean>(activity, "statusLoading"))
                }
                assertTrue("refresh requests must not wait for the queue", SystemClock.elapsedRealtime() - started < 1000)
                assertEquals(0, updates.get())
            }
            // One in-flight read and one merged follow-up; drain both without waiting on main.
            repeat(2) { executor.submit {}.get(10, TimeUnit.SECONDS); instrumentation.runOnMainSync {} }
            instrumentation.runOnMainSync {
                assertEquals("busy refreshes must merge into one follow-up, without a backlog", 2, updates.get())
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
            instrumentation.runOnMainSync {
                // Cached status can arrive before close; only updates after destruction are forbidden.
                assertTrue(updatesAtDestroy.get() >= 2)
                assertEquals("a destroyed Activity must not receive the late snapshot", updatesAtDestroy.get(), updates.get())
            }
        } finally { scenario.close(); application.unregisterActivityLifecycleCallbacks(lifecycle) }
    }

    @Test fun savingANoteAndNavigatingStayResponsiveWhileTheQueueIsLocked() {
        val scenario = ActivityScenario.launch(MainActivity::class.java).awaitMainUi()
        var id: String? = null
        try {
            scenario.onActivity { activity -> navigate(activity, "随手记") }
            val deadline = SystemClock.elapsedRealtime() + 10000; var editorReady = false
            while (!editorReady && SystemClock.elapsedRealtime() < deadline) { scenario.onActivity { activity -> editorReady = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.hint?.toString() == "记下此刻的想法…" }.isEnabled }; if (!editorReady) Thread.sleep(25) }
            assertTrue(editorReady)
            scenario.onActivity { activity ->
                views(activity.window.decorView).filterIsInstance<android.widget.EditText>()
                    .single { it.hint?.toString() == "记下此刻的想法…" }.setText("GENERATED ASYNC NOTE 🧑🏽‍💻")
            }
            QuickNotes.io.submit {}.get(5, TimeUnit.SECONDS)
            HeldQueue().use {
                val started = SystemClock.elapsedRealtime()
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>()
                        .single { it.isShown && it.text.toString() == "保存随手记" }.performClick()
                    navigate(activity, "来源"); navigate(activity, "设置")
                }
                assertTrue("saving a note cannot join the locked queue on the UI thread", SystemClock.elapsedRealtime() - started < 1000)
            }
            QuickNotes.io.submit {}.get(10, TimeUnit.SECONDS)
            val saved = context.queue().peek()!!; id = saved.getString("id")
            assertEquals("GENERATED ASYNC NOTE 🧑🏽‍💻", saved.getString("ocrText"))
            assertEquals("", QuickNotes.draft(context).read().text)
            assertFalse(Settings(context).enabled)
        } finally {
            scenario.close(); id?.let { context.queue().acknowledge(it) }
            QuickNotes.io.submit {}.get(10, TimeUnit.SECONDS); QuickNotes.draft(context).clear()
        }
    }

    @Test fun acceptedSettingsSaveSurvivesRotationWhilePreflightIsBlocked() {
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            val interval = if (Settings(context).read().intervalSeconds == 60) 61 else 60
            scenario.onActivity { activity ->
                navigate(activity, "设置")
                views(activity.window.decorView).single { it.tag == "menu:采集与存储" }.performClick()
                views(activity.window.decorView).filterIsInstance<android.widget.EditText>()
                    .single { it.hint?.toString() == "30" }.setText(interval.toString())
            }
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val holder = Thread {
                synchronized(Settings::class.java) { entered.countDown(); release.await(20, TimeUnit.SECONDS) }
            }.apply { start() }
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val started = SystemClock.elapsedRealtime()
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>()
                        .single { it.isShown && it.text.toString() == "保存设置" }.performClick()
                }
                scenario.recreate()
                assertTrue("save and rotation must not join the settings lock", SystemClock.elapsedRealtime() - started < 2000)
            } finally { release.countDown(); holder.join(5000) }
            scenario.awaitMainUi()
            val deadline = SystemClock.elapsedRealtime() + 15_000
            var delivered = false
            while (!delivered && SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity { activity ->
                    delivered = field<CollectorConfig>(activity, "loadedConfig").intervalSeconds == interval &&
                        !field<View>(activity, "saveBar").isShown
                }
                if (!delivered) Thread.sleep(25)
            }
            assertTrue("accepted save must commit and refresh the replacement Activity", delivered)
            assertEquals(interval, Settings(context).read().intervalSeconds)
            assertFalse(Settings(context).enabled)
        }
    }

    private fun <T : android.app.Activity> launchWhileSettingsAreLocked(activity: Class<T>) {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val holder = Thread {
            synchronized(Settings::class.java) { entered.countDown(); release.await(20, TimeUnit.SECONDS) }
        }.apply { start() }
        var scenario: ActivityScenario<T>? = null
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val started = SystemClock.elapsedRealtime()
            scenario = ActivityScenario.launch(activity)
            assertTrue("${activity.simpleName} launch must not wait on a settings writer", SystemClock.elapsedRealtime() - started < 4000)
        } finally {
            release.countDown(); holder.join(5000)
            scenario?.close()
        }
    }

    @Test fun sourceAndStorageLaunchDoNotJoinAnActiveSettingsWriter() {
        launchWhileSettingsAreLocked(SourcesActivity::class.java)
        launchWhileSettingsAreLocked(StorageActivity::class.java)
    }

    @Test fun compressionPreviewLaunchDoesNotJoinAnActiveSettingsWriter() {
        launchWhileSettingsAreLocked(CompressionPreviewActivity::class.java)
    }

    @Test fun calendarSuggestionsLaunchDoesNotJoinAnActiveSettingsWriter() {
        launchWhileSettingsAreLocked(CalendarActionsActivity::class.java)
    }

    @Test fun stoppingCaptureDoesNotJoinAnActiveSettingsWriter() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val finished = CountDownLatch(1)
        val holder = Thread {
            synchronized(Settings::class.java) { entered.countDown(); release.await(20, TimeUnit.SECONDS) }
        }.apply { start() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val started = SystemClock.elapsedRealtime()
            instrumentation.runOnMainSync { RuntimeSettings.stop(context) { assertTrue(it.isSuccess); finished.countDown() } }
            assertTrue("Stop must suspend producers without joining the settings writer", SystemClock.elapsedRealtime() - started < 1000)
        } finally { release.countDown(); holder.join(5000) }
        assertTrue(finished.await(10, TimeUnit.SECONDS))
        assertFalse(Settings(context).enabled)
        assertFalse(RuntimeSettings.stopping)
        assertFalse(ConnectionGuard.reconfiguring())
    }


}
