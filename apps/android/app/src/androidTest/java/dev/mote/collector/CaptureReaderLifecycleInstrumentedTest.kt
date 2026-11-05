package dev.mote.collector

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Real Home reader entry and Activity recreation, using only an explicitly owned generated fixture. */
@RunWith(AndroidJUnit4::class)
class CaptureReaderLifecycleInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun visible(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun click(activity: Activity, key: String) {
        assertTrue(visible(activity).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == MoteI18n.text(key) }.performClick())
    }
    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (!condition()) { assertTrue(message, SystemClock.elapsedRealtime() < deadline); Thread.sleep(25) }
        instrumentation.waitForIdleSync()
    }
    private fun awaitReader(reader: CaptureRecordsActivity, message: String, predicate: (CaptureRecordsActivity) -> Boolean) {
        waitFor(message) {
            var ready = false
            instrumentation.runOnMainSync { ready = !reader.isDestroyed && predicate(reader) }
            ready
        }
    }
    private fun dialogRoots() = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { root ->
        listOf(android.R.id.button1, android.R.id.button2, android.R.id.button3).any { root.findViewById<View>(it)?.isShown == true }
    }
    private fun originalShown(text: String) = dialogRoots().any { root ->
        val labels = views(root).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
        labels.contains(MoteI18n.text("原文")) && labels.contains(text) && GeneratedWindowRendering.hasNoPendingLabels(root)
    }
    private fun closeOriginal() {
        instrumentation.runOnMainSync {
            val root = dialogRoots().single { root -> views(root).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("原文") } }
            val close = root.findViewById<TextView>(android.R.id.button1)
            assertEquals(MoteI18n.text("关闭详情"), close.text.toString())
            assertTrue("Close must dismiss the actual original reader", close.performClick())
        }
    }
    private fun sourceAndDate(reader: CaptureRecordsActivity, date: LocalDate): Boolean {
        val rows = visible(reader)
        val scope = rows.filterIsInstance<Spinner>().singleOrNull { it.adapter.count == 2 && it.getItemAtPosition(0).toString() == MoteI18n.text("本机记录") }
        val kind = rows.filterIsInstance<Spinner>().singleOrNull { it.adapter.count == 7 }
        return scope?.selectedItemPosition == 0 && kind?.selectedItem?.toString() == MoteI18n.text("记录") &&
            rows.filterIsInstance<TextView>().any { it.text.toString() == date.toString() } &&
            rows.filterIsInstance<TextView>().any { it.tag == "detail-title" && it.text.toString() == MoteI18n.text("记录") }
    }
    private fun matchingList(reader: CaptureRecordsActivity, date: LocalDate, id: String) = dialogRoots().isEmpty() &&
        sourceAndDate(reader, date) && GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) &&
        visible(reader).any { it.tag == "capture:$id" }
    private fun emptyNoteDay(reader: CaptureRecordsActivity, date: LocalDate) = dialogRoots().isEmpty() &&
        sourceAndDate(reader, date) && GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) &&
        visible(reader).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("当天没有记录。选择其他日期，或添加一条记录。") }

    private fun recreateReader(reader: CaptureRecordsActivity): Pair<CaptureRecordsActivity, Bundle> {
        val application = context.applicationContext as Application
        var saved: Bundle? = null
        val callback = object : Application.ActivityLifecycleCallbacks {
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) { if (activity === reader) saved = Bundle(state) }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }
        var recreated: CaptureRecordsActivity? = null
        var originalTask = -1
        application.registerActivityLifecycleCallbacks(callback)
        try {
            instrumentation.runOnMainSync { originalTask = reader.taskId; reader.recreate() }
            waitFor("The actual reader Activity must be recreated and resume in the original task") {
                instrumentation.runOnMainSync {
                    recreated = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<CaptureRecordsActivity>().singleOrNull { it !== reader && it.taskId == originalTask }
                }
                recreated != null && saved != null
            }
            assertTrue("Recreation must destroy the previous instance", reader.isDestroyed)
            return requireNotNull(recreated) to requireNotNull(saved)
        } finally { application.unregisterActivityLifecycleCallbacks(callback) }
    }

    private fun journey(closedBeforeRecreation: Boolean) {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("uiIterationFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.VERSION.SDK_INT == 37 && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val avd = instrumentation.uiAutomation.executeShellCommand("getprop ro.boot.qemu.avd_name").use {
            ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
        require(avd == "mote_ui_focus_5330_api37")
        val settings = Settings(context); val previous = settings.read(); val previousLanguage = MoteI18n.preference()
        require(!settings.enabled && !CaptureAccessibilityService.connected && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        require(previous.token.isBlank() && (previous.server.isBlank() || previous.server == BuildConfig.DEFAULT_SERVER))
        require(context.queue().depth() == 0 && QuickNotes.draft(context).read() == NoteDraft() && context.localSources().sources().isEmpty())
        val variant = args.getString("uiIterationVariant", "default")
        require(variant in setOf("default", "compact", "english", "compact-english"))
        val savedConfig = previous.copy(server = "", token = "")
        var generatedId: String? = null
        var activeReader: CaptureRecordsActivity? = null
        val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
        try {
            settings.save(savedConfig, confirmCentralEndpoint = true)
            MoteI18n.select(context, if (variant in setOf("english", "compact-english")) "en" else "zh-CN")
            val original = "Generated reader lifecycle ${if (closedBeforeRecreation) "closed" else "open"}\n原文保留 🐾"
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { main ->
                main.onActivity { it.openGeneratedAdd(MoteAddAction.NOTE) }
                waitFor("The real note draft must finish loading") {
                    var ready = false
                    main.onActivity { ready = visible(it).filterIsInstance<TextView>().any { view -> view.text.toString() == MoteI18n.text("草稿已载入") } }
                    ready
                }
                main.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single().setText(original); click(activity, "保存记录") }
                waitFor("The actual note action must save the generated original") {
                    var ready = false
                    main.onActivity { ready = visible(it).filterIsInstance<TextView>().any { view -> view.text.toString() == MoteI18n.text("记录已保存；同步按你的设置运行") } }
                    ready
                }
                val items = context.queue().capturePage("1970-01-01T00:00:00Z", Instant.now().plusSeconds(1).toString(), source = "note").getJSONArray("items")
                assertEquals(1, items.length())
                val record = items.getJSONObject(0)
                val id = record.getString("id"); generatedId = id
                val date = Instant.parse(record.getString("capturedAt")).atZone(ZoneId.systemDefault()).toLocalDate()
                main.onActivity { activity -> activity.openGeneratedHome() }
                waitFor("The actual Home must expose the same saved note in a fully visible row") {
                    var opened = false
                    main.onActivity { activity ->
                        val row = visible(activity).singleOrNull { it.tag == "library-record:$id" }
                        if (row != null && row.width > 0 && row.height > 0) {
                            row.requestRectangleOnScreen(android.graphics.Rect(0, 0, row.width, row.height), true)
                            val bounds = android.graphics.Rect()
                            if (row.getGlobalVisibleRect(bounds) && bounds.width() == row.width && bounds.height() == row.height) {
                                assertTrue(views(row).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == original })
                                opened = row.performClick()
                            }
                        }
                    }
                    opened
                }
                var reader = instrumentation.waitForMonitorWithTimeout(monitor, 10_000) as? CaptureRecordsActivity ?: error("The Home row did not launch its actual reader")
                activeReader = reader
                awaitReader(reader, "The actual Home reader must load the exact saved original") { originalShown(original) && sourceAndDate(it, date) }
                instrumentation.runOnMainSync {
                    assertEquals(id, reader.intent.getStringExtra("recordId")); assertEquals("note", reader.intent.getStringExtra("recordSource"))
                    assertEquals(date.toString(), reader.intent.getStringExtra("recordDate"))
                    assertTrue(reader.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                }
                if (closedBeforeRecreation) {
                    closeOriginal()
                    awaitReader(reader, "Close must return to the same record list before recreation") { matchingList(it, date, id) }
                    instrumentation.runOnMainSync { click(reader, "前一天") }
                    awaitReader(reader, "The previous note day must actually finish loading") { emptyNoteDay(it, date.minusDays(1)) }
                }
                val (restored, state) = recreateReader(reader)
                reader = restored; activeReader = restored
                assertFalse("Original body is not serialized as top-level routing state", state.keySet().any { state.get(it) == original })
                if (closedBeforeRecreation) {
                    assertNull("A closed reader must not persist an open reader ID", state.getString("readerId"))
                    assertFalse("A closed reader must not persist a remote reader", state.getBoolean("readerRemote"))
                    awaitReader(reader, "Recreation of the closed previous-day list must not replay the launch original") { emptyNoteDay(it, date.minusDays(1)) }
                    instrumentation.runOnMainSync { assertTrue(dialogRoots().isEmpty()); click(reader, "后一天") }
                    awaitReader(reader, "Returning to the saved day must recover the same ID without reopening details") { matchingList(it, date, id) }
                } else {
                    assertEquals("Only the actual open reader ID is restored", id, state.getString("readerId"))
                    assertFalse("The open reader retains its local source", state.getBoolean("readerRemote"))
                    awaitReader(reader, "Recreation must restore the same actual original and local note context") { originalShown(original) && sourceAndDate(it, date) }
                    closeOriginal()
                    awaitReader(reader, "Closing the restored original must return to the same actual list") { matchingList(it, date, id) }
                }
                instrumentation.runOnMainSync {
                    assertEquals(id, reader.intent.getStringExtra("recordId"))
                    assertTrue(reader.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                    assertTrue(visible(reader).single { it.contentDescription == MoteI18n.text("返回上一页") }.performClick())
                }
                waitFor("Real header Back must resume the original Home with the same saved record") {
                    var returned = false
                    main.onActivity { activity -> returned = visible(activity).any { it.tag == "primary:LIBRARY" && it.isSelected } && visible(activity).any { it.tag == "library-record:$id" } }
                    returned
                }
            }
            assertEquals(savedConfig, settings.read()); assertFalse(settings.enabled)
            assertEquals(NoteDraft(), QuickNotes.draft(context).read())
        } finally {
            instrumentation.removeMonitor(monitor)
            // Failure cleanup only; all success checks above use the real Close and header Back actions.
            instrumentation.runOnMainSync { activeReader?.takeUnless { it.isDestroyed }?.finish() }
            generatedId?.let { context.queue().acknowledge(it) }
            try { settings.save(previous, confirmCentralEndpoint = true) }
            finally { MoteI18n.select(context, previousLanguage) }
        }
    }

    @Test fun closedOriginalRemainsClosedAndKeepsTheChangedDateAfterRecreation() = journey(closedBeforeRecreation = true)
    @Test fun openOriginalRestoresItsExactRecordAndReturnsToTheSameListAfterRecreation() = journey(closedBeforeRecreation = false)
}
