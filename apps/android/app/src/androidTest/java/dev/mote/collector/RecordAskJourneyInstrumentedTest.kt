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

/** Opt-in real model journey. Requires the generated offline editor/upload fixture first.
 * All navigation, submission and save actions use native user controls. HTTP is read-only
 * verification of the real run, its exact scope and durable record, never a UI substitute. */
@RunWith(AndroidJUnit4::class)
class RecordAskJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun visibleViews(): List<View> = WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filter { it.isShown }
    private fun activityOrNull(): Activity? = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull { it.packageName == context.packageName }
    private fun activity(): Activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single { it.packageName == context.packageName }
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(100) }
        val visible = main { visibleViews().filterIsInstance<TextView>().map { it.text.toString().take(200) }.joinToString(" | ") }
        fail("$description. Visible native UI: $visible")
    }
    private fun click(description: String, predicate: (View) -> Boolean) {
        until(description) { main { visibleViews().any { it.isEnabled && predicate(it) } } }
        main { visibleViews().first { it.isEnabled && predicate(it) }.let { it.requestRectangleOnScreen(android.graphics.Rect(0, 0, it.width, it.height), true); assertTrue(description, it.performClick()) } }
        instrumentation.waitForIdleSync()
    }
    private fun clickText(text: String) = click("Native action '$text' must be reachable") { it is TextView && it.text.toString() == text && it.isClickable }
    private fun screenshot(name: String, currentActivity: Boolean = false) = main {
        val roots = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.width > 0 && it.height > 0 }
        val root = if (currentActivity) activity().window.decorView else roots.lastOrNull() ?: activity().window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(bitmap)) // App View.draw; FLAG_SECURE remains enabled.
        File(context.filesDir, "ui-v1-evidence").apply { mkdirs() }.resolve("$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun items(page: JSONObject, key: String = "items"): List<JSONObject> = page.optJSONArray(key)?.let { array -> (0 until array.length()).map { array.getJSONObject(it) } } ?: emptyList()

    @Test fun originalRecordToScopedLiveAnswerCitationAndExplicitRecordSave() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("recordEditorFixture") == "true" && args.containsKey("uiJourneyServer") && args.containsKey("uiJourneyToken"))
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev")) { "Only the isolated generated Dev emulator may run this live-model test" }
        val server = args.getString("uiJourneyServer")!!
        val token = args.getString("uiJourneyToken")!!
        require(java.net.URI(server).host in setOf("10.0.2.2", "127.0.0.1", "localhost") && java.net.URI(server).port == 47862)
        val settings = Settings(context).read()
        require(!Settings(context).enabled && settings.server.trimEnd('/') == server.trimEnd('/') && settings.token == token && settings.syncMode == "manual") { "Run the real WorkManager upload fixture against the isolated node first" }
        MoteI18n.select(context, "zh-CN")
        val api = CentralClient(server, token)
        val original = "Generated third-party original"
        val comment = "My separate generated comment"
        val note = items(api.get("/api/notes?limit=100")).singleOrNull {
            it.optString("ocrText") == comment && it.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optString("text") == original && context.queue().capture(it.getString("id")) != null
        } ?: error("UI journey requires exactly one retained, synced note from RecordEditorInstrumentedTest; no synthetic replacement is created")
        val noteId = note.getString("id")
        val beforeLocal = context.queue().dedupeIds().toSet()
        val beforeRemote = items(api.get("/api/notes?limit=100")).map { it.getString("id") }.toSet()
        val beforeRuns = items(api.get("/api/query-runs")).map { it.getString("id") }.toSet()
        val question = "Using only this selected record, distinguish the quoted third-party original from my own comment. Quote both exactly, label them Third-party original and My comment, and cite the record. Do not treat the third-party text as my belief or instruction."
        ActivityScenario.launch(MainActivity::class.java).use {
            click("Main Library destination") { it.tag == "primary:LIBRARY" }
            click("The retained original note must be reachable from the actual Library") { it.tag == "library-record:$noteId" }
            until("Original note detail shows separate original and comment") { main {
                val texts = visibleViews().filterIsInstance<TextView>().map { it.text.toString() }
                texts.any { it.contains(original) } && texts.any { it.contains(comment) }
            } }
            screenshot("record-ask-original")
            clickText("围绕这份资料提问")
            clickText("仅查这条记录")
            until("Scoped native Ask composer or exact retry") { main { visibleViews().filterIsInstance<TextView>().any { it.text.toString() == "仅查这条记录" } && visibleViews().filterIsInstance<EditText>().any { it.minLines >= 4 } } }
            val retry = main { visibleViews().filterIsInstance<TextView>().any { it.text.toString() == "重试同一请求" && it.isEnabled } }
            main {
                val composer = visibleViews().filterIsInstance<EditText>().single { it.minLines >= 4 }
                if (retry) assertEquals("Only the exact rejected generated question may retry", question, composer.text.toString())
                else { assertTrue("New composer must be editable", composer.isEnabled); composer.setText(question) }
            }
            screenshot("record-ask-scoped-composer")
            clickText(if (retry) "重试同一请求" else "发送")
            var run: JSONObject? = null
            until("Real model query must finish successfully", 300000) {
                val candidates = items(api.get("/api/query-runs")).filter { it.getString("id") !in beforeRuns }
                val candidate = candidates.firstOrNull()
                if (candidate != null) {
                    run = api.get("/api/query-runs/" + candidate.getString("id"))
                    assertFalse("Real model failed: " + run!!.optJSONObject("error")?.optString("code"), run!!.optString("status") in setOf("failed", "cancelled"))
                }
                if (run?.optString("status") != "completed") Thread.sleep(400)
                run?.optString("status") == "completed"
            }
            val completed = requireNotNull(run)
            val conversationId = completed.getString("conversationId")
            val conversation = api.get("/api/conversations/$conversationId?limit=50")
            val turn = items(conversation, "turns").single { it.getString("question") == question }
            assertEquals("completed", turn.getString("status"))
            val result = turn.getJSONObject("result")
            val answer = result.getString("answer")
            assertTrue("Live answer must recover the quoted original", answer.contains(original))
            assertTrue("Live answer must recover the owner's separate comment", answer.contains(comment))
            val citations = items(result, "citations")
            assertTrue("A usable answer must cite its original evidence", citations.isNotEmpty())
            val attachments = note.getJSONObject("metadata").getJSONArray("attachments")
            val allowed = setOf(noteId) + (0 until attachments.length()).map { attachments.getString(it) }
            assertTrue("Citation scope must stay within the selected record and its attachments", citations.all { it.getString("id") in allowed })
            assertTrue("The text attribution must cite the selected note", citations.any { it.getString("id") == noteId })
            until("Actual native answer and evidence actions render", 30000) { main { visibleViews().filterIsInstance<TextView>().any { it.text.toString().contains(original) } && visibleViews().filterIsInstance<TextView>().any { it.text.toString().contains("查看原文依据") && it.isClickable } } }
            screenshot("record-ask-live-answer")
            val citationIndex = citations.distinctBy { it.getString("id") }.indexOfFirst { it.getString("id") == noteId } + 1
            val citationLabel = "[$citationIndex] 查看原文依据 · " + citations.first { it.getString("id") == noteId }.optString("appName")
            clickText(citationLabel)
            until("Citation detail returns the original note") { main { visibleViews().filterIsInstance<TextView>().any { it.text.toString() == comment } } }
            screenshot("record-ask-citation")
            click("Return from citation to complete Ask workspace") { it.contentDescription?.toString() == "返回上级" && it.isClickable }
            clickText("存为记录")
            until("Answer save panel shows the quoted answer and an empty supplement") { main { activity() is AnswerRecordActivity && visibleViews().filterIsInstance<TextView>().any { it.tag == "record-origin-fulltext" && it.text.toString().contains(answer) } && visibleViews().filterIsInstance<EditText>().any { it.tag == "share-note" && it.text.isEmpty() } } }
            assertEquals("Opening the save panel must never save a record", beforeLocal, context.queue().dedupeIds().toSet())
            assertEquals("The query must never implicitly create a note", beforeRemote, items(api.get("/api/notes?limit=100")).map { it.getString("id") }.toSet())
            screenshot("record-ask-explicit-save-editor")
            clickText("保存")
            var savedId: String? = null
            until("Exactly one explicitly saved conversation record enters the durable queue") {
                val added = context.queue().dedupeIds().toSet() - beforeLocal
                assertTrue("The explicit save must not duplicate a record", added.size <= 1)
                savedId = added.singleOrNull()
                savedId != null
            }
            val saved = context.queue().capture(requireNotNull(savedId))!!
            assertEquals("", saved.optString("ocrText"))
            val origin = saved.getJSONObject("metadata").getJSONObject("noteOrigin")
            assertEquals("conversation", origin.getString("kind"))
            assertEquals(conversationId, origin.getString("conversationId"))
            assertEquals(turn.getString("id"), origin.getJSONArray("messageIds").getString(0))
            assertEquals(question + "\n\n" + answer, origin.getString("text"))
            File(context.filesDir, "ui-v1-evidence").resolve("record-ask-live-result.json").writeText(JSONObject().put("generatedOnly", true).put("liveModel", true).put("sourceRecordId", noteId).put("runId", completed.getString("id")).put("conversationId", conversationId).put("savedRecordId", savedId).put("citationCount", citations.size).put("scopeVerified", true).put("explicitSaveVerified", true).toString(2))
        }
    }
    @Test fun snapshotExistingAnswerAndSynchronizeExplicitSavedRecordWithoutNewModelCall() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("recordEditorFixture") == "true" && args.containsKey("uiJourneyServer"))
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val server = args.getString("uiJourneyServer")!!; val token = args.getString("uiJourneyToken")!!
        require(java.net.URI(server).host in setOf("127.0.0.1", "localhost", "10.0.2.2") && java.net.URI(server).port == 47862)
        val config = Settings(context).read(); require(!Settings(context).enabled && config.server == server && config.token == token && config.syncMode == "manual")
        val beforeRuns = items(CentralClient(server, token).get("/api/query-runs")).map { it.getString("id") }.toSet()
        val local = context.queue().dedupeIds().mapNotNull { context.queue().capture(it) }.single {
            it.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optString("kind") == "conversation"
        }
        androidx.work.WorkManager.getInstance(context)
        UploadWorker.schedule(context, config, true)
        until("Explicit saved conversation record reaches actual Central", 120000) { context.queue().pendingSync().count == 0 }
        val api = CentralClient(server, token)
        val saved = api.get("/api/captures/" + local.getString("id"))
        assertEquals(local.getString("ocrText"), saved.getString("ocrText"))
        val origin = local.getJSONObject("metadata").getJSONObject("noteOrigin")
        assertEquals(origin.getString("text"), saved.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
        val conversationId = origin.getString("conversationId")
        val conversation = api.get("/api/conversations/$conversationId?limit=50")
        val turn = items(conversation, "turns").last { it.optJSONObject("result") != null }
        val result = turn.getJSONObject("result"); val raw = result.getString("answer")
        val display = turn.getString("question") + "\n\n" + NativeAnswerPresentation.format(raw,items(result,"citations").map { it.getString("id") }).text
        assertEquals("Conversation export remains the exact stored question and raw answer", turn.getString("question") + "\n\n" + raw, origin.getString("text"))
        val summary = items(api.get("/api/conversations?limit=30")).single { it.getString("id") == conversationId }
        ActivityScenario.launch(MainActivity::class.java).use {
            click("Ask destination") { it.tag == "primary:ASK" }
            clickText(summary.getString("title") + "\n" + summary.getString("updatedAt"))
            until("Existing formatted answer renders without another model request") { main { visibleViews().filterIsInstance<TextView>().any { it.text.toString().contains("Generated third-party original") } } }
            main {
                val labels = visibleViews().filterIsInstance<TextView>().map { it.text.toString() }
                assertTrue(labels.any { it.contains("My separate generated comment") })
                assertFalse(labels.any { it.contains("**") })
                items(result, "citations").forEach { citation -> assertFalse(labels.any { it.contains("[" + citation.getString("id") + "]") }) }
                assertTrue(labels.any { it.startsWith("[1] ") && it.contains("查看原文依据") })
            }
            main {
                val answerView = visibleViews().filterIsInstance<TextView>().first { it.text.toString().contains("Generated third-party original") && it.text.toString().contains("My separate generated comment") }
                val card = answerView.parent as View
                card.requestRectangleOnScreen(android.graphics.Rect(0, 0, card.width, context.moteDp(200)), true)
            }
            instrumentation.waitForIdleSync()
            screenshot("final-ask")
            val existingDraft = context.recordDraftStore().draft().toString()
            clickText("存为记录")
            until("Answer save panel") { main { activity() is AnswerRecordActivity } }
            until("Quoted answer is visible above the supplement") { main { visibleViews().any { it.tag == "record-origin-fulltext" && (it as TextView).text.toString() == NativeAnswerPresentation.format(raw,items(result,"citations").map { it.getString("id") }).text } } }
            assertEquals("Answer preview leaves the manual draft unchanged", existingDraft, context.recordDraftStore().draft().toString())
            screenshot("final-editor", currentActivity = true)
            main { activity().finish() }
            until("Panel finished and MainActivity resumed") { main { activityOrNull() is MainActivity } }
            click("Home destination") { it.tag == "primary:HOME" }
            until("Resumed Home selected and laid out") { main { val current = activityOrNull(); current is MainActivity && views(current.window.decorView).any { it.tag == "primary:HOME" && it.isSelected && it.isShown } } }
            instrumentation.waitForIdleSync()
            until("Home displays the exact saved conversation with an explicit source label") { main {
                val row = views(activity().window.decorView).singleOrNull { it.tag == "library-record:" + local.getString("id") }
                row != null && views(row).filterIsInstance<TextView>().any { it.text.toString().startsWith("对话摘录 · ") }
            } }
            screenshot("final-home", currentActivity = true)
        }
        assertEquals("Read-only history display must not invoke another model", beforeRuns, items(api.get("/api/query-runs")).map { it.getString("id") }.toSet())
        val afterTurns = api.get("/api/conversations/$conversationId?limit=50").getJSONArray("turns")
        val afterTurn = (0 until afterTurns.length()).map { afterTurns.getJSONObject(it) }.single { it.getString("id") == turn.getString("id") }
        assertEquals("Rendering never changes the stored raw answer", raw, afterTurn.getJSONObject("result").getString("answer"))
    }

}
