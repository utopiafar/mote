package dev.mote.collector

import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Captures the UA08 Ask light/dark/streaming/offline/anchored states on the
 * generated Discovery fixture. Evidence reads, conversation persistence and
 * cancellation are real; the model is a controlled fixture. */
@RunWith(AndroidJUnit4::class)
class Ua08AcceptanceCaptureInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val origin = "http://127.0.0.1:" + (InstrumentationRegistry.getArguments().getString("ua08Port") ?: "47890")
    private val api get() = CentralClient(origin, "generated-native-discovery-owner-token")
    private val directory get() = File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(origin))
    private fun state() = api.get("/api/__fixture/")
    private fun control(name: String) = api.post("/api/__fixture/" + name, JSONObject())
    private fun saved() = CentralDraftWrites.barrier { CentralStateFile(directory, "ask", context.secretBox()).read() }
    private fun draft(conversation: String) = CentralDraftWrites.barrier {
        CentralStateFile(directory, "ask", context.secretBox()).write(
            JSONObject().put("conversationId", conversation).put("question", "").put("attachments", JSONArray()),
        )
    }
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(a: CentralActivity): List<View> = views(a.window.decorView).filter { it.isShown }
    private fun windowViews(): List<View> = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filter { it.isShown }
    private fun <T> main(block: () -> T): T {
        val result = java.util.concurrent.atomic.AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun seen(check: (View) -> Boolean) = main { windowViews().any(check) }
    private fun until(label: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 30_000
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(60) }
        throw AssertionError(label)
    }
    private fun ready(s: ActivityScenario<CentralActivity>, label: String, check: (CentralActivity) -> Boolean) {
        until(label) { var value = false; s.onActivity { value = check(it) }; value }
    }
    private fun click(s: ActivityScenario<CentralActivity>, label: String, predicate: (View) -> Boolean) {
        ready(s, label) { a -> !a.isWorking && shown(a).any { it.isEnabled && it.isClickable && predicate(it) } }
        s.onActivity { a -> shown(a).first { it.isEnabled && it.isClickable && predicate(it) }.apply { requestRectangleOnScreen(android.graphics.Rect(0, 0, width, height), true); assertTrue(performClick()) } }
    }
    private fun question(s: ActivityScenario<CentralActivity>, value: String) {
        ready(s, "Composer accepts the generated question") { a -> !a.isWorking && shown(a).filterIsInstance<EditText>().any { it.contentDescription == "你的问题" && it.isEnabled } }
        s.onActivity { a -> shown(a).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText(value) }
    }
    private fun save(root: View, name: String) {
        GeneratedVisualScreencap.save(context, File(context.getExternalFilesDir(null), "ua08"), name)
        val image = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            root.draw(android.graphics.Canvas(image))
            val target = File(context.getExternalFilesDir(null), "ua08").apply { mkdirs() }.resolve("$name.png")
            target.outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            println("UA08_CAPTURE $name ${target.length()}")
        } finally { image.recycle() }
    }
    private fun shot(s: ActivityScenario<CentralActivity>, name: String) {
        instrumentation.waitForIdleSync()
        GeneratedVisualScreencap.capture(context, s, File(context.getExternalFilesDir(null), "ua08"), name)
    }
    /** The original reader is its own Activity window; capture the window that
     * currently renders the highlighted original text. */
    private fun shotWindow(name: String, marker: String) {
        instrumentation.waitForIdleSync()
        main {
            val root = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }
                .first { window -> views(window).any { it is TextView && it.text.contains(marker) } }
            save(root, name)
        }
    }
    private fun clearScope(s: ActivityScenario<CentralActivity>) {
        click(s, "Clear the saved scope for the unscoped state") { it.contentDescription?.toString() == "清除范围" }
        until("Material scope chip is gone") { !seen { it.contentDescription?.toString()?.startsWith("material:") == true } }
    }

    private fun connect() {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = origin, token = "", debugHttp = true, authSignedOut = false, syncMode = "manual"), confirmCentralEndpoint = true)
        CentralSession.get(context).select(origin)
        CentralSession.get(context).signIn(origin, "generated-native-discovery-owner-token")
    }

    private fun perTheme(unscoped: Boolean = false, block: (ActivityScenario<CentralActivity>, String) -> Unit) {
        val before = MoteAppearance.preference()
        control("reset")
        try {
            connect()
            for (theme in listOf(AppearancePreference.LIGHT, AppearancePreference.DARK)) {
                main { MoteAppearance.select(context, theme) }
                draft(state().getString("askConversationId"))
                control("online")
                ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "ask")).use { s ->
                    ready(s, "Conversation and citation cards loaded") { a ->
                        !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } &&
                            shown(a).any { it.contentDescription?.toString()?.startsWith("查看引用 2") == true }
                    }
                    if (unscoped) clearScope(s)
                    block(s, if (theme == AppearancePreference.DARK) "dark" else "light")
                }
            }
        } finally {
            main { MoteAppearance.select(context, before) }
            control("online")
            runCatching { control("release-query") }
            until("Fixture settled") { runCatching { state().optInt("activeQueries") == 0 }.getOrDefault(true) }
        }
    }
    private fun verifyAnswered(s: ActivityScenario<CentralActivity>) {
        s.onActivity { a ->
            val visible = shown(a)
            assertFalse("history action removed", visible.any { it.contentDescription?.toString() == "对话历史" })
            assertFalse("new conversation action removed", visible.any { it.contentDescription?.toString() == "新对话" })
            assertTrue("numbered citation markers", visible.filterIsInstance<TextView>().any { it.text.contains("按实际用量分摊") })
            assertTrue("citation card position", visible.any { it.contentDescription?.toString() == "查看引用 2 · 租房合同 2026.pdf" })
            assertTrue("citation card location", visible.filterIsInstance<TextView>().any { it.text.toString() == "第 4 页" })
            assertTrue("each completed answer remains individually saveable", visible.filterIsInstance<TextView>().count { it.text.toString() == "保存为记录" } == 2)
            assertTrue("each completed answer remains individually copyable", visible.count { it.contentDescription?.toString() == "复制" } == 2)
            assertTrue("each completed answer keeps its details action", visible.count { it.contentDescription?.toString() == "更多" } == 2)
            val minimumTouchTarget = (48 * a.resources.displayMetrics.density).toInt()
            for (label in listOf("复制", "更多", "添加图片")) {
                val controls = visible.filter { it.contentDescription?.toString() == label }
                assertTrue("$label remains available", controls.isNotEmpty())
                assertTrue("$label has a 48dp touch target", controls.all { it.width >= minimumTouchTarget && it.height >= minimumTouchTarget })
            }
        }
    }

    @Test fun a06AnsweredCitationsOpenTheStoredPosition() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua08Fixture") == "true")
        perTheme(unscoped = true) { s, theme ->
            shot(s, "answered-$theme")
            verifyAnswered(s)
            click(s, "Open the stored file citation") { it.contentDescription?.toString() == "查看引用 2 · 租房合同 2026.pdf" }
            until("Original reader opens at the stored file position") {
                seen { it is TextView && it.text.contains("第四条 押金为两个月租金") }
            }
            val citation = main { windowViews().filterIsInstance<TextView>().first { it.text.contains("第四条 押金为两个月租金") } }
            val spans = (citation.text as? android.text.Spanned)?.getSpans(0, citation.text.length, android.text.style.BackgroundColorSpan::class.java) ?: emptyArray()
            assertTrue("The cited excerpt is highlighted in the original", spans.isNotEmpty())
            if (theme == "light") shotWindow("citation-light", "第四条 押金为两个月租金")
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            ready(s, "Reader closes back to the conversation") { a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } }
        }
    }

    @Test fun a09AnchoredScopeChipIsVisible() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua08Fixture") == "true")
        perTheme { s, theme ->
            ready(s, "Saved Material scope chip is shown") { a -> shown(a).any { it.contentDescription?.toString()?.startsWith("material:") == true } }
            assertTrue("Scope name", seen { it is TextView && it.text.toString() == "租房合同 2026.pdf" })
            shot(s, "anchored-$theme")
            var point = intArrayOf()
            s.onActivity { activity ->
                val clear = shown(activity).single { it.contentDescription?.toString() == "清除范围" }
                val rect = android.graphics.Rect(); assertTrue(clear.getGlobalVisibleRect(rect))
                point = intArrayOf(rect.right + activity.moteDp(16), rect.centerY())
            }
            val at = SystemClock.uptimeMillis()
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(at, at, android.view.MotionEvent.ACTION_DOWN, point[0].toFloat(), point[1].toFloat(), 0))
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(at, at + 50, android.view.MotionEvent.ACTION_UP, point[0].toFloat(), point[1].toFloat(), 0))
            until("The expanded clear target removes the selected scope") { !seen { it.contentDescription?.toString()?.startsWith("material:") == true } }
        }
    }

    @Test fun a05BackReturnsToTheConversationList() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua08Fixture") == "true")
        perTheme { s, theme ->
            click(s, "Back to the conversation list") { it.contentDescription?.toString() == "返回上级" }
            ready(s, "Conversation list rows are loaded") { a ->
                !a.isWorking && shown(a).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？") == true } &&
                    shown(a).none { it is TextView && it.text.contains("正在读取对话") }
            }
            instrumentation.waitForIdleSync()
            shot(s, "list-$theme")
            assertTrue("No history action on the thread", seen { it.contentDescription?.toString() == "对话历史" }.not())
            assertTrue("No new conversation action on the thread", seen { it.contentDescription?.toString() == "新对话" }.not())
            click(s, "Reopen the generated conversation") { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？") == true }
            ready(s, "Conversation reopened") { a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } }
        }
    }

    @Test fun a08AnsweringShowsOnlyStop() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua08Fixture") == "true")
        perTheme(unscoped = true) { s, theme ->
            control("hold-query")
            question(s, "押金什么时候退？")
            s.onActivity { activity ->
                val send = shown(activity).single { it.contentDescription?.toString() == "发送" }
                val target = activity.moteDp(48)
                assertTrue("Send has a 48dp touch target", send.width >= target && send.height >= target)
            }
            click(s, "Send the generated follow-up") { it.contentDescription?.toString() == "发送" }
            ready(s, "The running answer offers only stop") { a ->
                !a.isWorking && shown(a).any { it.isShown && it.tag == "ask-stop" } &&
                    shown(a).none {
                        it.isShown && (it.contentDescription?.toString() == "发送" ||
                            it is TextView && it.text.toString() in setOf("检查结果", "重试同一请求"))
                    }
            }
            instrumentation.waitForIdleSync()
            shot(s, "streaming-$theme")
            click(s, "Stop the generated answer") { it.tag == "ask-stop" }
            until("The actual server cancellation is stored") { saved().optString("runStatus") == "cancelled" }
            ready(s, "Stopped answer keeps the conversation") { a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } }
            control("release-query")
            until("Fixture model returns after cancellation") { state().optInt("activeQueries") == 0 }
        }
    }

    @Test fun a08OfflineShowsRetryAndRecovers() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("ua08Fixture") == "true")
        perTheme(unscoped = true) { s, theme ->
            control("offline")
            click(s, "Open a citation while Central is unreachable") { it.contentDescription?.toString() == "查看引用 2 · 租房合同 2026.pdf" }
            until("Offline banner appears") { seen { it is TextView && it.text.toString() == "没有连上中央" } && seen { it is TextView && it.text.toString() == "重试" } }
            ready(s, "Composer is replaced by the offline notice") { a -> shown(a).none { it.isShown && it.contentDescription?.toString() == "发送" } }
            assertTrue("No raw transport text", !seen { it is TextView && (it.text.contains("okhttp") || it.text.contains("unexpected end of stream")) })
            instrumentation.waitForIdleSync()
            shot(s, "offline-$theme")
            control("online")
            click(s, "Retry the unreachable conversation") { it is TextView && it.text.toString() == "重试" }
            until("Offline notice clears after retry") { !seen { it is TextView && it.text.toString() == "没有连上中央" } }
            ready(s, "Retry restores the readable conversation") { a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } }
        }
    }
}
