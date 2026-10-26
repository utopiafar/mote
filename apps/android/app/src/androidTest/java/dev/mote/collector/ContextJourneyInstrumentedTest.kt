package dev.mote.collector

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.TextView
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Generated owner journeys through actual Home/Sources/Sync and Library entrypoints. */
@RunWith(AndroidJUnit4::class)
class ContextJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown() = WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filter { it.isShown }
    private fun <T> main(block: () -> T): T {
        val value = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { value.set(runCatching(block)) }; return value.get().getOrThrow()
    }
    private fun until(description: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < end) { if (runCatching(check).getOrDefault(false)) return; Thread.sleep(40) }
        fail(description + ": " + main { shown().filterIsInstance<TextView>().joinToString(" | ") { it.text.toString().take(100) } })
    }
    private fun clickTag(tag: String) {
        until("Reachable native action $tag") { main { shown().any { it.tag == tag && it.isEnabled } } }
        main { shown().first { it.tag == tag && it.isEnabled }.performClick() }; instrumentation.waitForIdleSync()
    }
    private fun activity(): Activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single { it.packageName == context.packageName }
    private fun capture(name: String) = main {
        val root = activity().window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        try {
            root.draw(Canvas(bitmap)) // Only generated app content; product FLAG_SECURE remains active.
            File(context.getExternalFilesDir(null), "context-journeys").apply { mkdirs() }.resolve("$name.png")
                .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun guard() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        MoteI18n.select(context, "zh-CN")
    }

    @Test fun homeStatusUsesOneSyncWorkspaceAndRealHistorySurvivesRecreation() {
        guard()
        val ledger = File(context.noBackupFilesDir, "operation-ledger.json")
        val originalLedger = ledger.takeIf { it.exists() }?.readBytes()
        val settings = Settings(context); val original = settings.read()
        val pending = context.queue().depth()
        try {
            settings.save(original.copy(server = "", token = "", syncMode = "manual"), confirmCentralEndpoint = true)
            Operations.ledger(context).reset()
            repeat(12) { Operations.ledger(context).record(OperationKind.NOTE_ACK, bytes = 2048, elapsedMs = 25) }
            Operations.ledger(context).record(OperationKind.CAPTURE_REQUESTED)
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use {
                until("Home must show two actual status links") { main { shown().count { it.tag in setOf("home-capture-status", "home-sync-status") } == 2 } }
                capture("home")
                clickTag("home-capture-status")
                main {
                    assertTrue(shown().single { it.tag == "primary:SOURCES" }.isSelected)
                    assertFalse(shown().any { it.tag == "home-sync-status" })
                }
                clickTag("menu:同步与上传")
                until("Unified sync page has actual current queue") { main { activity() is SyncQueueActivity && shown().any { it.tag == "sync-current-tab" && it.isSelected } } }
                capture("sync-current")
                clickTag("sync-history-tab")
                until("History is paged from recorded upload events only") { main { shown().count { it.tag == "sync-history-result" } == 10 } }
                capture("sync-history")
                main { shown().filterIsInstance<TextView>().single { it.text.toString() == "下一页" }.performClick() }
                until("Second history page retains the remaining events") { main { shown().count { it.tag == "sync-history-result" } == 2 } }
                val oldActivity = main { activity() }
                main { oldActivity.recreate() }
                until("History selection and exact page survive Activity recreation") { main {
                    activity() !== oldActivity && shown().any { it.tag == "sync-history-tab" && it.isSelected } && shown().count { it.tag == "sync-history-result" } == 2
                } }
                clickTag("sync-history-result")
                until("Upload details expose recorded size and elapsed time") { main {
                    shown().filterIsInstance<TextView>().any { it.text.contains("2048") && it.text.contains("25 ms") }
                } }
                main { shown().filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == "关闭" }.performClick(); activity().finish() }
                clickTag("primary:HOME")
                clickTag("home-sync-status")
                until("Home opens the same workspace with current tasks") { main { activity() is SyncQueueActivity && shown().any { it.tag == "sync-current-tab" && it.isSelected } } }
                main { activity().finish() }
            }
            assertFalse("Inspecting status/history must not start capture", settings.enabled)
            assertEquals("Inspecting history must not change pending originals", pending, context.queue().depth())
        } finally {
            settings.save(original, confirmCentralEndpoint = true)
            if (originalLedger == null) ledger.delete() else ledger.writeBytes(originalLedger)
        }
    }

    @Test fun materialsMemoryAndDiscoveriesKeepTheirRealCentralEntrypoints() {
        guard()
        val settings = Settings(context); val original = settings.read()
        try {
            settings.save(original.copy(server = "", token = ""), confirmCentralEndpoint = true)
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use {
                clickTag("primary:LIBRARY")
                until("Materials and memories are primary Library views") { main {
                    val tabs = shown().singleOrNull { it.tag == "library-primary-views" }
                    tabs != null && views(tabs).filterIsInstance<TextView>().map { it.text.toString() }.containsAll(listOf("我的资料", "我的记忆"))
                } }
                capture("materials")
                main { shown().filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == "我的记忆" }.performClick() }
                until("Memory view resolves to the existing Central memory page") { main { activity() is CentralActivity && activity().intent.getStringExtra("page") == "memories" } }
                capture("memory-connection-required")
                main { activity().finish() }
                clickTag("primary:HOME")
                main { shown().filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == "发现历史" }.performClick() }
                until("Discovery resolves to the existing Central insights page") { main { activity() is CentralActivity && activity().intent.getStringExtra("page") == "insights" } }
                main { activity().finish() }
            }
            assertFalse(settings.enabled)
        } finally { settings.save(original, confirmCentralEndpoint = true) }
    }

    @Test fun sourceFileAndFolderEntriesWaitForSelectionAndKeepDraftsAfterCancelAndRecreation() {
        guard()
        val sourceIds = context.localSources().sources().map { it.id }
        val files = listOf("FILE", "FOLDER").map { File(context.noBackupFilesDir, "file-task-${SourceRules.hash(it)}.enc") }
        val originals = files.associateWith { it.takeIf(File::exists)?.readBytes() }
        try {
            files.forEach(File::delete)
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use {
                clickTag("primary:SOURCES")
                for ((mode, label) in listOf("FILE" to "导入文件", "FOLDER" to "同步文件夹")) {
                    clickTag("menu:$label")
                    until("Source action opens a native file task without the system picker") { main {
                        activity() is FileTaskActivity && shown().any { it.tag == "file-task:description" && it.isEnabled }
                    } }
                    assertFalse(instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.endsWith(".documentsui") == true)
                    main { (shown().single { it.tag == "file-task:description" } as EditText).setText("Generated $mode source draft") }
                    capture("source-${mode.lowercase()}-task")
                    clickTag("file-task:pick")
                    until("Only explicit selection opens Android DocumentsUI") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.endsWith(".documentsui") == true }
                    instrumentation.uiAutomation.executeShellCommand("input keyevent 4").close()
                    until("Cancellation returns to the same unsaved task") { main { activity() is FileTaskActivity && shown().any { it.tag == "file-task:description" } } }
                    val previous = main { activity() }
                    main { previous.recreate() }
                    until("Task recreation retains the description and does not reopen the picker") { main {
                        activity() !== previous && shown().filterIsInstance<EditText>().any { it.tag == "file-task:description" && it.text.toString() == "Generated $mode source draft" }
                    } }
                    main { assertFalse(shown().single { it.tag == "file-task:confirm" }.isEnabled); activity().finish() }
                }
            }
            assertEquals("Cancelling import must not create a source", sourceIds, context.localSources().sources().map { it.id })
        } finally {
            originals.forEach { (file, bytes) -> if (bytes == null) file.delete() else file.writeBytes(bytes) }
        }
    }
}
