package dev.mote.collector

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ConversationRecordOriginInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val store get() = context.recordDraftStore()
    private fun until(label: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(80) }
        fail(label)
    }
    private fun prepareConnection(): CollectorConfig {
        val settings = Settings(context); val old = settings.read()
        val origin = settings.dataOrigin().ifBlank { "http://127.0.0.1:54783" }
        ConnectionGuard.change(context, origin, bindLocal = true) {
            settings.save(old.copy(server = origin, token = "generated-quote-fixture-token-1234567890", debugHttp = true, authSignedOut = false, syncMode = "manual", syncPaused = true), confirmCentralEndpoint = true)
        }
        return old
    }
    private fun fixture(body: () -> Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("generatedQuoteFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!store.hasPrepared())
        MoteI18n.select(context, "zh-CN")
        val old = store.draft(); val before = context.queue().dedupeIds().toSet(); val oldSettings = prepareConnection()
        try { body(); assertEquals("No preview or cancelled import saves a record", before, context.queue().dedupeIds().toSet()) }
        finally {
            QuickNotes.io.submit {}.get(); store.edit(old.getString("text"), old.getJSONArray("attachments"), old.getJSONObject("origin"), old.optString("description"), old.optJSONObject("originPresentation"))
            Settings(context).save(oldSettings, confirmCentralEndpoint = true)
        }
    }
    private fun empty() { store.edit("", JSONArray(), JSONObject().put("kind", "manual")) }
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
    private fun answerIntent(text: String, conversation: String, turn: String, question: String = "Question", origin: String = "http://127.0.0.1:54783", citations: List<String> = emptyList()) =
        Intent(context, AnswerRecordActivity::class.java).putExtra("recordText", text)
            .putExtra("conversationId", conversation).putExtra("turnId", turn).putExtra("quoteQuestion", question).putExtra("quoteOrigin", origin)
            .putStringArrayListExtra("quoteCitations", ArrayList(citations))

    @Test fun exportedShareCannotPretendToBeAnInternalConversation() = fixture {
        val pm = context.packageManager
        @Suppress("DEPRECATION") val exported = pm.getActivityInfo(ComponentName(context, ShareRecordActivity::class.java), 0).exported
        @Suppress("DEPRECATION") val internal = pm.getActivityInfo(ComponentName(context, AnswerRecordActivity::class.java), 0).exported
        assertTrue(exported); assertFalse(internal); empty()
        shell("am start -n ${context.packageName}/dev.mote.collector.AnswerRecordActivity")
        Thread.sleep(500)
        instrumentation.runOnMainSync { assertFalse("External shell cannot launch the internal answer panel", ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any { it is AnswerRecordActivity }) }
        val output = shell("am start -n ${context.packageName}/dev.mote.collector.ShareRecordActivity -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT Generated_external_shared_text --es recordText Forged_question --es conversationId forged-conversation --es turnId forged-turn --es quoteQuestion Forged_question --esal quoteCitations forged-evidence")
        assertTrue("External sharing must remain available: $output", output.contains("Starting:"))
        until("External share shows only the actual shared input") {
            var shown = false; instrumentation.runOnMainSync { shown = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<ShareRecordActivity>().any { activity -> views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "share-link-preview" || it.text.toString() == "Generated_external_shared_text" } || views(activity.window.decorView).any { it.tag == "share-panel" } } }; shown
        }
        assertEquals("", store.draft().getJSONObject("origin").optString("text"))
        instrumentation.runOnMainSync { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<ShareRecordActivity>().forEach { it.finish() } }
    }

    @Test fun incomingShareNeverOffersReplacementAndPreservesAnExistingDraft() = fixture {
        val priorText = "Generated prior private text"; val priorDescription = "Generated prior private description"
        store.edit(priorText, JSONArray(), JSONObject().put("kind", "manual"), priorDescription)
        val before = store.draft().toString()
        ActivityScenario.launch<ShareRecordActivity>(Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Generated incoming quoted original")).use { scenario ->
            until("Compact share panel is ready") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "share-title" && it.text.toString() == "保存到 Mote" } }; found }
            scenario.onActivity { activity ->
                val all = views(activity.window.decorView)
                assertFalse(all.filterIsInstance<TextView>().any { it.text.toString() == "替换草稿" || it.text.toString() == "已有未保存草稿" })
                assertTrue(all.filterIsInstance<EditText>().single { it.tag == "share-note" }.text.isEmpty())
                assertFalse(all.any { it.contentDescription?.toString() in setOf("拍照", "录音") })
            }
            assertEquals(before, store.draft().toString())
            scenario.recreate()
            assertEquals(before, store.draft().toString())
        }
    }

    @Test fun internalQuoteKeepsExactIdentityAndRejectsOverlengthWithoutTouchingDraft() = fixture {
        val conversation = UUID.randomUUID().toString(); val turn = UUID.randomUUID().toString(); val citation = UUID.randomUUID().toString()
        val question = "Generated question"; val raw = question + "\n\n> **Answer** [$citation]"; empty()
        val before = store.draft().toString()
        ActivityScenario.launch<AnswerRecordActivity>(answerIntent(raw, conversation, turn, question, citations = listOf(citation))).use { scenario ->
            until("Formatted answer is quoted in the shared panel") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "record-origin-fulltext" && it.text.toString() == "Answer [1]" } }; found }
            scenario.onActivity { activity -> assertEquals("保存为记录", views(activity.window.decorView).filterIsInstance<TextView>().single { it.tag == "share-title" }.text.toString()) }
            assertEquals(before, store.draft().toString())
            scenario.recreate()
            until("Readable answer survives recreation") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "record-origin-fulltext" && it.text.toString() == "Answer [1]" } }; found }
            assertEquals(before, store.draft().toString())
        }
        ActivityScenario.launch<AnswerRecordActivity>(Intent(context, AnswerRecordActivity::class.java).putExtra("recordText", "x".repeat(100001)).putExtra("conversationId", conversation).putExtra("turnId", turn)).use { scenario ->
            until("Overlength input shows an explicit limit") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("文字目前最多 100000 字符。") } }; found }
            assertEquals(before, store.draft().toString())
        }
        val boundaryText = "q\n\n" + "y".repeat(99997)
        ActivityScenario.launch<AnswerRecordActivity>(answerIntent(boundaryText, conversation, turn, "q")).use { scenario ->
            until("Maximum permitted answer remains complete") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "record-origin-fulltext" && it.text.toString().length == 99997 } }; found }
            assertEquals(before, store.draft().toString())
        }
    }

    @Test fun switchingNodesCannotSendAnAnswerToAnotherArchive() = fixture {
        val settings = Settings(context); val original = settings.read(); val source = settings.dataOrigin()
        require(source.isNotBlank() && !settings.hasPendingData())
        val other = "http://127.0.0.1:54784"; require(source != other)
        val conversation = UUID.randomUUID().toString(); val turn = UUID.randomUUID().toString(); val text = "Question\n\nGenerated source answer"; empty()
        val before = store.draft().toString()
        try {
            ActivityScenario.launch<AnswerRecordActivity>(answerIntent(text, conversation, turn, origin = source)).use { scenario ->
                until("Answer panel ready") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.tag == "share-save" && it.isEnabled } }; found }
                ConnectionGuard.change(context, other, bindLocal = true) { settings.save(original.copy(server = other), confirmCentralEndpoint = true) }
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "share-save" }.performClick() }
                until("Node change is visible") { var shown = false; scenario.onActivity { activity -> shown = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("访问凭据已失效，请重新连接。") } }; shown }
                assertEquals(before, store.draft().toString())
            }
        } finally { ConnectionGuard.change(context, source, bindLocal = true) { settings.save(original, confirmCentralEndpoint = true) } }
    }

    @Test fun sameNodeSignedOutStillSavesTheAnswerLocallyWithoutChangingDraft() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("generatedQuoteFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val oldSettings = prepareConnection(); val source = settings.dataOrigin(); require(source.isNotBlank() && settings.read().syncPaused && !settings.hasPendingData())
        val journal = java.io.File(context.noBackupFilesDir, "record-draft/record.enc"); val oldJournal = if (journal.exists()) journal.readBytes() else null
        val queue = context.queue(); val before = queue.dedupeIds().toSet(); val turn = UUID.randomUUID().toString(); val conversation = UUID.randomUUID().toString(); val original = "Question\n\nGenerated offline answer"
        try {
            empty(); val draft = store.draft().toString()
            ActivityScenario.launch<AnswerRecordActivity>(answerIntent(original, conversation, turn, origin = source)).use { scenario ->
                until("Answer panel ready") { var found = false; scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.tag == "share-save" && it.isEnabled } }; found }
                settings.signOut(); assertEquals(source, settings.dataOrigin()); assertFalse(settings.read().hasSyncConnection())
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "share-save" }.performClick() }
                until("One offline record is saved locally") { (queue.dedupeIds().toSet() - before).size == 1 }
                val id = (queue.dedupeIds().toSet() - before).single(); val saved = requireNotNull(queue.capture(id)); assertFalse(saved.optBoolean("uploaded"))
                assertEquals(original, saved.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
                assertEquals(turn, saved.getJSONObject("metadata").getJSONObject("noteOrigin").getJSONArray("messageIds").getString(0))
                assertEquals(draft, store.draft().toString())
            }
        } finally {
            QuickNotes.io.submit {}.get()
            for (id in queue.dedupeIds().toSet() - before) { val saved = requireNotNull(queue.capture(id)); check(saved.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optJSONArray("messageIds")?.optString(0) == turn); check(queue.resolveDedupe(id, "", null, null, null)) }
            assertEquals(before, queue.dedupeIds().toSet())
            if (oldJournal == null) journal.delete() else journal.writeBytes(oldJournal)
            settings.save(oldSettings, confirmCentralEndpoint = true)
        }
    }
}
