package dev.mote.collector

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Actual local record -> production upload -> native Ask -> evidence, with generated model output. */
@RunWith(AndroidJUnit4::class)
class ContextAskJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown() = WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filter { it.isShown }
    private fun <T> main(block: () -> T): T {
        val value = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { value.set(runCatching(block)) }; return value.get().getOrThrow()
    }
    private fun until(description: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 30000
        while (SystemClock.elapsedRealtime() < end) { if (runCatching(check).getOrDefault(false)) return; Thread.sleep(80) }
        fail(description + ": " + main { shown().filterIsInstance<TextView>().joinToString(" | ") { it.text.toString().take(160) } })
    }
    private fun click(description: String, predicate: (View) -> Boolean) {
        until(description) { main { shown().any { it.isEnabled && it.isClickable && predicate(it) } } }
        main { shown().first { it.isEnabled && it.isClickable && predicate(it) }.performClick() }; instrumentation.waitForIdleSync()
    }
    private fun clickText(text: String) = click("Reachable action $text") { it is TextView && it.text.toString() == text }
    private fun activity(): Activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single { it.packageName == context.packageName }
    private fun capture(name: String) = main {
        val root = activity().window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        try {
            root.draw(Canvas(bitmap))
            File(context.getExternalFilesDir(null), "context-journeys").apply { mkdirs() }.resolve("$name.png")
                .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun items(value: JSONObject, key: String = "items"): List<JSONObject> = value.optJSONArray(key)?.let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) } } ?: emptyList()

    @Test fun savedRecordIsAnAnchorWithRelatedContextAndExactEvidenceAfterRecreation() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeCentralFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        require(!settings.enabled && settings.read().server.trimEnd('/') == "http://127.0.0.1:47883")
        val api = CentralClient(settings.read().server, settings.read().token)
        val notes = context.queue().capturePage("1970-01-01T00:00:00Z", java.time.Instant.now().plusSeconds(1).toString(), limit = 60, source = "note")
        val note = items(notes).mapNotNull { context.queue().capture(it.getString("id")) }.single {
            it.optString("ocrText") == "My separate generated comment" && it.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optString("text") == "Generated third-party original"
        }
        val noteId = note.getString("id")
        assertEquals("Real record must already be acknowledged by the generated Central", note.getString("ocrText"), api.get("/api/captures/$noteId").getString("ocrText"))
        val beforeRuns = items(api.get("/api/query-runs")).map { it.getString("id") }.toSet()
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use {
            click("Actual Library destination") { it.tag == "primary:LIBRARY" }
            click("Retained saved record") { it.tag == "library-record:$noteId" }
            until("Original record shows the separate owner comment and source") { main {
                val text = shown().filterIsInstance<TextView>().joinToString("\n") { it.text.toString() }
                text.contains("My separate generated comment") && text.contains("Generated third-party original")
            } }
            capture("record-original")
            clickText("围绕这份资料提问")
            until("Default record Ask is an anchor, with no context-selection decision") { main {
                shown().filterIsInstance<TextView>().any { it.text.toString() == "My separate generated comment" } && shown().filterIsInstance<EditText>().any { it.contentDescription == "你的问题" && it.isEnabled }
            } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated journey: explain this record with related context") }
            capture("ask-anchor")
            clickText("发送")
            var completed: JSONObject? = null
            until("Actual query run completes through the generated provider") {
                val run = items(api.get("/api/query-runs")).firstOrNull { it.getString("id") !in beforeRuns }
                if (run != null) completed = api.get("/api/query-runs/" + run.getString("id"))
                completed?.optString("status") == "completed"
            }
            val conversation = api.get("/api/conversations/" + completed!!.getString("conversationId"))
            val scope = conversation.getJSONObject("scope")
            assertEquals(listOf(noteId), scope.getJSONArray("anchorEvidenceIds").let { ids -> (0 until ids.length()).map { index -> ids.getString(index) } })
            assertTrue("Default anchor must not restrict retrieval to selected evidence", scope.isNull("evidenceIds") || scope.optJSONArray("evidenceIds")?.length() == 0)
            val result = items(conversation, "turns").single().getJSONObject("result")
            val citationIds = items(result, "citations").map { row -> row.getString("id") }
            assertEquals("Provider reads original anchor and the actual related fixture record", 2, citationIds.size)
            assertTrue(citationIds.contains(noteId))
            until("Native answer and two evidence actions become readable") { main {
                shown().filterIsInstance<TextView>().count { it.isClickable && it.text.contains("查看原文依据") } == 2
            } }
            capture("ask-answer")
            val old = main { activity() }
            main { old.recreate() }
            until("Recreated Ask restores its anchor and the original answer") { main {
                activity() !== old && shown().filterIsInstance<TextView>().any { it.text.toString() == "My separate generated comment" } && shown().filterIsInstance<TextView>().count { it.isClickable && it.text.contains("查看原文依据") } == 2
            } }
            click("Open the first exact evidence citation") { it is TextView && it.text.toString().startsWith("[1] ") && it.text.contains("查看原文依据") }
            until("Evidence action reads the saved original owner comment") { main { shown().filterIsInstance<TextView>().any { it.text.toString() == "My separate generated comment" } } }
            capture("answer-evidence")
            click("Open the original's More sheet") { it.tag == "capture-reader-more" }
            clickText("删除记录")
            until("Deletion confirmation names its actual Central scope") { main { shown().filterIsInstance<TextView>().any { it.text.contains("不会删除本机副本或来源原件") } } }
            capture("central-delete-scope")
            clickText("取消")
            assertEquals("Cancelling deletion preserves the actual Central original", "My separate generated comment", api.get("/api/captures/$noteId").getString("ocrText"))
            assertNotNull(context.queue().capture(noteId))
            assertFalse(settings.enabled)
            main { activity().finish() }
        }
    }
}
