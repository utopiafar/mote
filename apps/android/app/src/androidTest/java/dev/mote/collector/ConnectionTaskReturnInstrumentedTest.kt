package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Actual connection entry/return journeys on the explicitly owned generated-only emulator. */
@RunWith(AndroidJUnit4::class)
class ConnectionTaskReturnInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }

    private fun visible(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun name(activity: Activity) = visible(activity).filterIsInstance<EditText>()
        .single { it.tag == MoteI18n.text("设备名称") }

    private fun click(activity: Activity, label: String) {
        if (label == "首页") { activity.openGeneratedHome(); return }
        assertTrue(visible(activity).filterIsInstance<TextView>()
            .single { it.isClickable && it.text.toString() == MoteI18n.text(label) }.performClick())
    }

    private fun headerBack(activity: Activity) {
        assertTrue(visible(activity).single { it.tag == "local-back:CONNECTION" }.performClick())
    }

    private fun connectionShown(activity: Activity) = visible(activity).any { it.tag == "local-back:CONNECTION" } &&
        visible(activity).filterIsInstance<EditText>().any { it.tag == MoteI18n.text("设备名称") }

    private fun askShown(activity: Activity) = visible(activity).any { it.tag == "primary:ASK" && it.isSelected } &&
        visible(activity).filterIsInstance<TextView>().any { it.tag == "central-title" && it.text.toString() == MoteI18n.text("对话") } &&
        visible(activity).filterIsInstance<TextView>().any { it.isClickable && it.text.toString() == MoteI18n.text("连接设置") }

    private fun settingsShown(activity: Activity) = visible(activity).any { it.tag == "menu:${MoteI18n.text("连接与同步")}" } &&
        !connectionShown(activity) && visible(activity).none { it.tag == "central-title" }

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (!condition()) {
            assertTrue(message, SystemClock.elapsedRealtime() < deadline)
            Thread.sleep(25)
        }
        instrumentation.waitForIdleSync()
    }

    private fun <T : Activity> await(scenario: ActivityScenario<T>, message: String, predicate: (T) -> Boolean) {
        waitFor(message) {
            var ready = false
            scenario.onActivity { ready = predicate(it) }
            ready
        }
    }

    private fun awaitActivity(activity: Activity, message: String, predicate: (Activity) -> Boolean) {
        waitFor(message) {
            var ready = false
            instrumentation.runOnMainSync { ready = !activity.isDestroyed && predicate(activity) }
            ready
        }
    }

    private fun dialogRoot(): View? = android.view.inspector.WindowInspector.getGlobalWindowViews().singleOrNull { root ->
        views(root).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("有未保存的更改") } &&
            root.findViewById<View>(android.R.id.button1)?.isShown == true
    }

    private fun awaitDiscardDecision() = waitFor("Real Back must ask before discarding the connection draft") {
        var ready = false
        instrumentation.runOnMainSync { ready = dialogRoot() != null }
        ready
    }

    private fun decide(label: String) {
        instrumentation.runOnMainSync {
            val root = requireNotNull(dialogRoot()) { "No connection draft decision is visible" }
            assertTrue(views(root).filterIsInstance<TextView>()
                .single { it.isShown && it.isClickable && it.text.toString() == MoteI18n.text(label) }.performClick())
        }
        waitFor("The draft decision must actually close") {
            var closed = false
            instrumentation.runOnMainSync { closed = dialogRoot() == null }
            closed
        }
    }

    /** Inject the OS Back event, including the API 33+ registered back callback. */
    private fun systemBack(activity: Activity) {
        instrumentation.runOnMainSync {
            activity.currentFocus?.clearFocus()
            activity.getSystemService(InputMethodManager::class.java)
                .hideSoftInputFromWindow(activity.window.decorView.windowToken, 0)
        }
        awaitActivity(activity, "Resume the actual connection window and hide IME before testing page Back") {
            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).contains(it) &&
                it.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) != true
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        instrumentation.waitForIdleSync()
    }

    private fun fixture(action: (CollectorConfig) -> Unit) {
        assumeTrue("Explicit generated-only iteration fixture required",
            InstrumentationRegistry.getArguments().getString("uiIterationFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" &&
            Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:") && Build.VERSION.SDK_INT == 37)
        val avd = instrumentation.uiAutomation.executeShellCommand("getprop ro.boot.qemu.avd_name").use {
            ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
        require(avd == "mote_ui_focus_5330_api37")
        val settings = Settings(context)
        val previous = settings.read()
        require(!settings.enabled && !CaptureAccessibilityService.connected && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        require(previous.token.isBlank() && (previous.server.isBlank() || previous.server == BuildConfig.DEFAULT_SERVER))
        require(context.queue().depth() == 0 && context.localSources().sources().isEmpty() && QuickNotes.draft(context).read() == NoteDraft())
        val variant = InstrumentationRegistry.getArguments().getString("uiIterationVariant", "default")
        require(variant in setOf("default", "english", "compact", "compact-english"))
        val previousLanguage = MoteI18n.preference()
        val fixtureLanguage = when (variant) {
            "default", "compact" -> "zh-CN"
            else -> "en"
        }
        // Only the verified generated profile is adjusted; no existing records, sources or drafts are cleared.
        val saved = previous.copy(server = "", token = "")
        settings.save(saved, confirmCentralEndpoint = true)
        try {
            MoteI18n.select(context, fixtureLanguage)
            assertEquals("The connection journey must run in its requested fixture language", fixtureLanguage, MoteI18n.preference())
            action(saved)
        } finally {
            try {
                assertEquals("Returning must leave committed configuration unchanged", saved, settings.read())
                assertFalse("These navigation journeys must not start capture", settings.enabled)
                assertEquals(0, context.queue().depth())
                assertEquals(NoteDraft(), QuickNotes.draft(context).read())
                assertTrue(context.localSources().sources().isEmpty())
            } finally {
                try { settings.save(previous, confirmCentralEndpoint = true) }
                finally { MoteI18n.select(context, previousLanguage) }
            }
        }
    }

    @Test fun embeddedAskKeepsItsReturnOriginAndDraftAcrossRecreationAndBackDecisions() = fixture { saved ->
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { click(it, "问一问") }
            await(scenario, "Ask must expose its real connection CTA", ::askShown)
            scenario.onActivity { click(it, "连接设置") }
            await(scenario, "The Ask CTA must open the actual connection page", ::connectionShown)
            val draft = "Generated R2 Ask return device"
            scenario.onActivity { name(it).setText(draft) }
            scenario.recreate()
            scenario.awaitMainUi()
            await(scenario, "Rotation must retain the actual unsaved device name") { connectionShown(it) && name(it).text.toString() == draft }
            lateinit var activity: MainActivity
            scenario.onActivity { activity = it }
            systemBack(activity)
            awaitDiscardDecision()
            decide("继续编辑")
            scenario.onActivity {
                assertTrue(connectionShown(it))
                assertEquals(draft, name(it).text.toString())
                assertEquals(saved, Settings(it).read())
                assertFalse(it.isFinishing)
                headerBack(it)
            }
            awaitDiscardDecision()
            decide("丢弃修改")
            await(scenario, "Discard must return to the original embedded Ask, not the settings hub", ::askShown)
            scenario.onActivity {
                assertFalse(it.isFinishing)
                assertFalse(settingsShown(it))
                assertEquals(saved, Settings(it).read())
                click(it, "连接设置")
            }
            await(scenario, "Reopening connection must expose the committed name") { connectionShown(it) && name(it).text.toString() == saved.deviceName }
            scenario.onActivity { headerBack(it) }
            await(scenario, "A clean connection Back must also return to Ask", ::askShown)
        }
    }

    @Test fun settingsConnectionsReturnToTheHubAfterLeavingAnEarlierAskConnection() = fixture { saved ->
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { click(it, "设置") }
            await(scenario, "Settings hub must open", ::settingsShown)
            scenario.onActivity { clickSettingsConnection(it) }
            await(scenario, "Settings entry must open connection", ::connectionShown)
            scenario.onActivity { headerBack(it) }
            await(scenario, "Direct Settings connection header Back must return to the hub", ::settingsShown)
            scenario.onActivity { click(it, "问一问") }
            await(scenario, "Ask CTA must finish loading", ::askShown)
            scenario.onActivity { click(it, "连接设置") }
            await(scenario, "Ask entry must open connection", ::connectionShown)
            // Leaving through another actual destination must clear the earlier Ask return origin.
            scenario.onActivity { click(it, "设置") }
            await(scenario, "The user can leave connection for Settings", ::settingsShown)
            scenario.onActivity { clickSettingsConnection(it) }
            await(scenario, "A new Settings connection must open", ::connectionShown)
            lateinit var activity: MainActivity
            scenario.onActivity { activity = it }
            systemBack(activity)
            await(scenario, "Settings system Back must not reuse the old Ask origin", ::settingsShown)
            scenario.onActivity {
                assertEquals(saved, Settings(it).read())
                assertTrue(visible(it).single { view -> view.tag == "primary:LIBRARY" }.isSelected)
                clickSettingsConnection(it)
            }
            await(scenario, "Settings can reopen connection again", ::connectionShown)
            scenario.onActivity { click(it, "首页") }
            await(scenario, "Leaving for Home must complete") { visible(it).any { view -> view.tag == "add:NOTE" } }
            scenario.onActivity { click(it, "设置"); clickSettingsConnection(it) }
            await(scenario, "Settings connection after Home must open", ::connectionShown)
            scenario.onActivity { headerBack(it) }
            await(scenario, "Repeated Settings entry retains the Settings return destination", ::settingsShown)
        }
    }

    private fun clickSettingsConnection(activity: Activity) {
        assertTrue(visible(activity).single { it.tag == "menu:${MoteI18n.text("连接与同步")}" }.performClick())
    }

    private fun centralCallerJourney(dirty: Boolean) = fixture { saved ->
        val monitor = instrumentation.addMonitor(MainActivity::class.java.name, null, false)
        var connection: MainActivity? = null
        try {
            ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "ask")).use { scenario ->
                await(scenario, "The independent central Ask must expose the real CTA", ::askShown)
                lateinit var caller: CentralActivity
                var originalTask = -1
                scenario.onActivity { caller = it; originalTask = it.taskId; click(it, "连接设置") }
                val opened = instrumentation.waitForMonitorWithTimeout(monitor, 10_000) as? MainActivity
                    ?: error("The central CTA did not start the actual local connection Activity")
                connection = opened
                awaitActivity(opened, "Main connection must finish loading for the central caller", ::connectionShown)
                instrumentation.runOnMainSync {
                    assertTrue(opened.intent.getBooleanExtra("returnToCentral", false))
                    assertEquals(originalTask, opened.taskId)
                    assertTrue(opened.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                }
                if (dirty) {
                    val draft = "Generated R2 Central caller device"
                    instrumentation.runOnMainSync { name(opened).setText(draft) }
                    systemBack(opened)
                    awaitDiscardDecision()
                    decide("继续编辑")
                    instrumentation.runOnMainSync {
                        assertFalse(opened.isFinishing)
                        assertTrue(connectionShown(opened))
                        assertEquals(draft, name(opened).text.toString())
                        assertEquals(saved, Settings(opened).read())
                        headerBack(opened)
                    }
                    awaitDiscardDecision()
                    decide("丢弃修改")
                } else {
                    systemBack(opened)
                }
                waitFor("The actual Back action must finish Main and resume the original central Ask") {
                    var returned = false
                    instrumentation.runOnMainSync {
                        returned = opened.isDestroyed && ActivityLifecycleMonitorRegistry.getInstance()
                            .getActivitiesInStage(Stage.RESUMED).contains(caller)
                    }
                    returned
                }
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
                await(scenario, "The returned central caller must remain on Ask", ::askShown)
                scenario.onActivity {
                    assertSame("Return must resume the original caller, not manufacture another Activity", caller, it)
                    assertEquals(originalTask, it.taskId)
                    assertFalse(it.isFinishing)
                    assertEquals(saved, Settings(it).read())
                }
            }
        } finally {
            instrumentation.removeMonitor(monitor)
            // Failure cleanup only. Successful return is proved above before any test-owned cleanup.
            instrumentation.runOnMainSync { connection?.takeUnless { it.isDestroyed }?.finish() }
        }
    }

    @Test fun standaloneCentralAskDiscardReturnsByHeaderBackToTheActualCaller() = centralCallerJourney(dirty = true)
    @Test fun standaloneCentralAskCleanSystemBackReturnsToTheActualCaller() = centralCallerJourney(dirty = false)
}
