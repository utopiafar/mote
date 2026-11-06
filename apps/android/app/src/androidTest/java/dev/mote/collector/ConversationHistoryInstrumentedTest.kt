package dev.mote.collector

import android.content.Intent
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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** The list screen against a generated Central page: grouping, the pill
 * composer, long-press deletion and the reference screenshots all exercise
 * production views. No model and no personal data are involved. */
@RunWith(AndroidJUnit4::class)
class ConversationHistoryInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val screenshots = File(context.filesDir, "conversation-history-final")
    private lateinit var originalAppearance: AppearancePreference
    private var originalSettings: CollectorConfig? = null

    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }

    private fun views(root: View): List<View> = listOf(root) +
        if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()

    private fun globalViews(): List<View> = WindowInspector.getGlobalWindowViews().flatMap(::views).filter { it.isShown }

    private fun until(label: String, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < end) {
            if (check()) return
            Thread.sleep(40)
        }
        throw AssertionError(label)
    }

    private fun ready(scenario: ActivityScenario<CentralActivity>, label: String, check: (CentralActivity) -> Boolean) =
        until(label) { var value = false; scenario.onActivity { value = !it.isWorking && check(it) }; value }

    private fun labels(scenario: ActivityScenario<CentralActivity>): List<String> {
        val result = AtomicReference<List<String>>()
        scenario.onActivity { result.set(views(it.window.decorView).filter { view -> view.isShown }.filterIsInstance<TextView>().map(TextView::getText).map(CharSequence::toString)) }
        return result.get()
    }

    private fun capture(scenario: ActivityScenario<CentralActivity>, name: String) {
        instrumentation.waitForIdleSync()
        val frames = CountDownLatch(1)
        scenario.onActivity { activity -> activity.window.decorView.postOnAnimation { activity.window.decorView.postOnAnimation { frames.countDown() } } }
        assertTrue(frames.await(5, TimeUnit.SECONDS))
        scenario.onActivity { activity ->
            val root = activity.window.decorView
            val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            try {
                root.draw(Canvas(image))
                screenshots.mkdirs()
                File(screenshots, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { image.recycle() }
        }
    }

    private fun clickGlobal(label: String) {
        until("Visible action $label") { globalViews().any { it.isShown && it is TextView && it.text.toString() == label } }
        main {
            val text = globalViews().first { it.isShown && it is TextView && it.text.toString() == label }
            var ancestor: View? = text.parent as? View
            var list: android.widget.ListView? = null
            while (ancestor != null) {
                if (ancestor is android.widget.ListView) list = ancestor
                ancestor = ancestor.parent as? View
            }
            val listView = list
            if (listView != null) {
                val position = listView.getPositionForView(text)
                check(listView.performItemClick(text, position, listView.adapter.getItemId(position))) { "List item $label did not click" }
            } else if (!text.performClick()) {
                var target: View? = text
                while (target != null && !target.isClickable) target = target.parent as? View
                check(target != null) { "No clickable ancestor for $label" }
                target.performClick()
            }
        }
        instrumentation.waitForIdleSync()
    }

    private fun clickView(scenario: ActivityScenario<CentralActivity>, predicate: (View) -> Boolean) {
        until("Target control is visible") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).any { view -> view.isShown && view.isEnabled && predicate(view) } }; ready }
        scenario.onActivity { activity -> views(activity.window.decorView).first { it.isShown && it.isEnabled && predicate(it) }.performClick() }
        instrumentation.waitForIdleSync()
    }

    private fun open(fixture: Fixture, empty: Boolean = false, fails: Boolean = false): ActivityScenario<CentralActivity> {
        fixture.empty = empty
        fixture.deleteFails = fails
        return ActivityScenario.launch(Intent(context, CentralActivity::class.java).putExtra("page", "conversations"))
    }

    @Before fun generatedOnly() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeConversationHistoryFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a") && !Settings(context).enabled)
        originalAppearance = MoteAppearance.preference()
        originalSettings = Settings(context).read()
        MoteI18n.select(context, "zh-CN")
        main { MoteAppearance.select(context, AppearancePreference.LIGHT) }
    }

    @After fun cleanup() {
        if (!this::originalAppearance.isInitialized) return
        originalSettings?.let { Settings(context).save(it, confirmCentralEndpoint = true) }
        CentralSession.get(context).select(originalSettings?.server.orEmpty())
        main { MoteAppearance.select(context, originalAppearance) }
        MoteI18n.select(context, "zh-CN")
        CentralDraftWrites.barrier { }
    }

    @Test fun listAndEmptyStatesKeepOnlyTheBackHeadingGroupsAndComposer() {
        Fixture().use { fixture ->
            fixture.installConnection()
            open(fixture).use { scenario ->
                ready(scenario, "Rows are grouped from the generated page") { activity ->
                    views(activity.window.decorView).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true }
                }
                val text = labels(scenario)
                assertTrue("本周 caption", text.contains("本周"))
                assertTrue("更早 caption", text.contains("更早"))
                assertTrue("row title", text.contains("暖气费是怎么约定的？"))
                assertTrue("composer placeholder", viewsOf(scenario).filterIsInstance<EditText>().any { it.contentDescription == "问一问" && it.hint?.toString() == "问一问" })
                assertFalse("the list has no separate page title in the header", text.any { it == "对话历史" })
                assertFalse("the list has no new-conversation icon", text.any { it == "新对话" })
                capture(scenario, "impl-list-light")
                main { MoteAppearance.select(context, AppearancePreference.DARK) }
                instrumentation.waitForIdleSync()
                capture(scenario, "impl-list-dark")
                main { MoteAppearance.select(context, AppearancePreference.LIGHT) }
            }
            open(fixture, empty = true).use { scenario ->
                until("Empty page finished its read") { fixture.listReads.get() >= 1 }
                ready(scenario, "Empty page finished its read") { !it.isWorking }
                until("Loading copy is gone") { labels(scenario).none { it == "正在读取对话…" } }
                val text = labels(scenario)
                assertFalse("empty history has no explanatory copy", text.any { it.contains("还没有对话") })
                assertFalse("empty history has no week caption", text.contains("本周") || text.contains("更早"))
                assertTrue("composer remains", viewsOf(scenario).filterIsInstance<EditText>().any { it.contentDescription == "问一问" && it.hint?.toString() == "问一问" })
                capture(scenario, "impl-empty-light")
                main { MoteAppearance.select(context, AppearancePreference.DARK) }
                instrumentation.waitForIdleSync()
                capture(scenario, "impl-empty-dark")
                main { MoteAppearance.select(context, AppearancePreference.LIGHT) }
            }
        }
    }

    @Test fun tappingARowOpensThatConversation() {
        Fixture().use { fixture ->
            fixture.installConnection()
            open(fixture).use { scenario ->
                ready(scenario, "First row loaded") { activity -> views(activity.window.decorView).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true } }
                scenario.onActivity { activity ->
                    views(activity.window.decorView).first { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true }.performClick()
                }
                until("The selected conversation was read") { fixture.conversationReads.get() >= 1 }
                ready(scenario, "The conversation page owns the selected thread") { activity ->
                    views(activity.window.decorView).filterIsInstance<EditText>().any { it.contentDescription == "你的问题" }
                }
                instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                ready(scenario, "Back from the conversation returns to its list") { activity ->
                    views(activity.window.decorView).any { it.isShown && it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true }
                }
                instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                until("Back from standalone history returns to its caller") { scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED }
            }
        }
    }

    @Test fun composerShowsSendOnlyWithTextAndStartsANewConversation() {
        Fixture().use { fixture ->
            fixture.installConnection()
            open(fixture).use { scenario ->
                ready(scenario, "Existing rows loaded") { activity -> views(activity.window.decorView).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true } }
                assertFalse("no send button before text", viewsOf(scenario).any { it.contentDescription == "发送" })
                scenario.onActivity { activity ->
                    val input = views(activity.window.decorView).filterIsInstance<EditText>().single { it.contentDescription == "问一问" }
                    input.setText("牛肋排烤到几度出炉")
                    input.requestFocus(); input.setSelection(input.text.length)
                    activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(input.windowToken, 0)
                }
                instrumentation.waitForIdleSync()
                Thread.sleep(150)
                assertTrue("send appears with text", viewsOf(scenario).any { it.contentDescription == "发送" && it.isShown })
                capture(scenario, "impl-typing-light")
                clickView(scenario) { it.contentDescription == "发送" }
                until("The generated Central received one new question") { fixture.posted.get() != null }
                val body = requireNotNull(fixture.posted.get())
                assertEquals("牛肋排烤到几度出炉", body.getJSONObject("input").getString("question"))
                assertFalse("a list question starts a new conversation", body.getJSONObject("input").has("conversationId"))
                ready(scenario, "The new conversation page opened") { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == "问一问" }
                }
                assertEquals(1, fixture.posts.get())
            }
        }
    }

    @Test fun longPressDeletesAndAFailureAddsDetailsWithoutWeakeningTheConfirmation() {
        Fixture().use { fixture ->
            fixture.installConnection()
            open(fixture, fails = true).use { scenario ->
                ready(scenario, "First row loaded") { activity -> views(activity.window.decorView).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true } }
                longPressRow(scenario, "暖气费是怎么约定的？. ")
                until("Long-press menu") { globalViews().any { it is TextView && it.text.toString() == "删除这段对话" } }
                assertFalse("failed deletion has no details before it fails", globalViews().any { it is TextView && it.text.toString() == "查看详情" })
                clickGlobal("删除这段对话")
                until("Unchanged delete confirmation") { globalViews().any { it is TextView && it.text.toString() == "会删除这段对话的所有问答。已单独保存的记录保留。" } }
                assertTrue("confirmation title", globalViews().any { it is TextView && it.text.toString() == "删除整段对话？" })
                assertTrue("confirmation primary action", globalViews().any { it is TextView && it.text.toString() == "删除对话" })
                clickGlobal("删除对话")
                until("The generated delete failed") { fixture.deleteCalls.get() == 1 && !globalViews().any { it is TextView && it.text.toString() == "删除对话" } }
                until("The failure is recorded before the next menu") { labels(scenario).any { it.contains("未能确认删除完成") } }
                assertTrue("failed row remains", viewsOf(scenario).any { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true })
                longPressRow(scenario, "暖气费是怎么约定的？. ")
                until("Failure adds details") { globalViews().any { it is TextView && it.text.toString() == "查看详情" } }
                clickGlobal("查看详情")
                until("Details dialog opens") { globalViews().any { it is TextView && it.text.toString() == "查看详情" } }
                clickGlobal("关闭")
                fixture.deleteFails = false
                longPressRow(scenario, "暖气费是怎么约定的？. ")
                until("Delete menu after a recovered failure") { globalViews().any { it is TextView && it.text.toString() == "删除这段对话" } }
                clickGlobal("删除这段对话")
                until("Same confirmation after recovery") { globalViews().any { it is TextView && it.text.toString() == "会删除这段对话的所有问答。已单独保存的记录保留。" } }
                clickGlobal("删除对话")
                until("Deleted row disappears") { fixture.deleteCalls.get() == 2 && viewsOf(scenario).none { it.contentDescription?.toString()?.startsWith("暖气费是怎么约定的？. ") == true } }
            }
        }
    }

    private fun viewsOf(scenario: ActivityScenario<CentralActivity>): List<View> {
        val result = AtomicReference<List<View>>()
        scenario.onActivity { result.set(views(it.window.decorView).filter(View::isShown)) }
        return result.get()
    }

    private fun longPressRow(scenario: ActivityScenario<CentralActivity>, prefix: String) {
        scenario.onActivity { activity ->
            val row = views(activity.window.decorView).first { it.isShown && it.contentDescription?.toString()?.startsWith(prefix) == true }
            assertTrue(row.performLongClick())
        }
        instrumentation.waitForIdleSync()
    }

    private inner class Fixture : AutoCloseable {
        private val listener = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${listener.localPort}"
        val token = "generated-conversation-history-owner"
        private val workers = Executors.newCachedThreadPool()
        @Volatile var empty = false
        @Volatile var deleteFails = false
        val deleteCalls = AtomicInteger()
        val listReads = AtomicInteger()
        val conversationReads = AtomicInteger()
        val posts = AtomicInteger()
        val posted = AtomicReference<JSONObject?>()
        private val zone = java.time.ZoneId.systemDefault()
        private fun stamp(date: java.time.LocalDate) = date.atTime(12, 0).atZone(zone).toInstant().toString()
        private val today = java.time.LocalDate.now(zone)
        private val rows = listOf(
            UUID.randomUUID().toString() to "暖气费是怎么约定的？",
            UUID.randomUUID().toString() to "上周和陈老师聊了什么？",
            UUID.randomUUID().toString() to "牛肋排低温烤几个小时？",
            UUID.randomUUID().toString() to "合同里押金怎么退？",
            UUID.randomUUID().toString() to "九月去过的几家书店叫什么？",
            UUID.randomUUID().toString() to "我什么时候开始用快捷指令的？",
            UUID.randomUUID().toString() to "上次体检提到的注意事项",
        )
        private val stamps = listOf(
            stamp(today), stamp(today.minusDays(1)), stamp(today.with(java.time.DayOfWeek.MONDAY)),
            stamp(today.minusDays(16)), stamp(today.minusDays(28)), stamp(today.minusDays(34)), stamp(today.minusDays(37)),
        )
        private var deleted = setOf<String>()

        init {
            workers.submit {
                while (!listener.isClosed) runCatching { listener.accept() }.getOrNull()?.let { socket ->
                    workers.submit { socket.use(::serve) }
                }
            }
        }

        fun installConnection() {
            val settings = Settings(context)
            settings.save(settings.read().copy(server = origin, token = "", debugHttp = true, syncMode = "manual",
                authSignedOut = false, authExpiresAt = 0, authProcess = ""), confirmCentralEndpoint = true)
            CentralSession.get(context).select(origin)
            CentralSession.get(context).signIn(origin, token)
        }

        private fun serve(socket: java.net.Socket) {
            try {
                val input = socket.getInputStream()
                fun line(): String {
                    val out = java.io.ByteArrayOutputStream()
                    while (true) {
                        val value = input.read()
                        if (value < 0 || value == '\n'.code) break
                        if (value != '\r'.code) out.write(value)
                    }
                    return out.toString("UTF-8")
                }
                val first = line()
                val path = first.split(' ').getOrElse(1) { "" }
                val method = first.substringBefore(' ')
                val headers = mutableListOf<String>()
                while (true) { val header = line(); if (header.isEmpty()) break; headers.add(header) }
                if (headers.any { it.startsWith("Expect:", true) }) {
                    socket.getOutputStream().apply { write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray()); flush() }
                }
                val size = headers.firstOrNull { it.startsWith("Content-Length:", true) }?.substringAfter(':')?.trim()?.toInt() ?: 0
                val body = ByteArray(size)
                var read = 0
                while (read < size) { val count = input.read(body, read, size - read); if (count < 0) break; read += count }
                val request = String(body, 0, read)
                var status = "200 OK"
                val value = when {
                    path.startsWith("/api/conversations?") && method == "GET" -> JSONObject()
                        .also { listReads.incrementAndGet() }
                        .put("items", JSONArray().apply {
                            if (!empty) rows.filterNot { it.first in deleted }.forEachIndexed { index, row ->
                                put(JSONObject().put("id", row.first).put("title", row.second)
                                    .put("updatedAt", stamps[index])
                                    .put("turnCount", 2))
                            }
                        })
                        .put("nextCursor", JSONObject.NULL)
                    path.startsWith("/api/conversations/") && method == "DELETE" -> {
                        deleteCalls.incrementAndGet()
                        if (deleteFails) {
                            status = "500 Internal Server Error"
                            JSONObject().put("error", JSONObject().put("code", "internal").put("message", "generated delete failed"))
                        } else {
                            deleted = deleted + path.removePrefix("/api/conversations/")
                            JSONObject().put("deleted", 1)
                        }
                    }
                    path.startsWith("/api/conversations/") -> {
                        conversationReads.incrementAndGet()
                        JSONObject().put("id", path.removePrefix("/api/conversations/").substringBefore('?'))
                            .put("scope", JSONObject()).put("turns", JSONArray())
                    }
                    path == "/api/query-runs" && method == "POST" -> {
                        posts.incrementAndGet()
                        val parsed = JSONObject(request)
                        posted.set(parsed)
                        JSONObject().put("id", parsed.getString("id")).put("status", "completed")
                            .put("conversationId", UUID.randomUUID().toString())
                    }
                    path == "/api/query-runs" -> JSONObject().put("items", JSONArray())
                    path.startsWith("/api/query-runs/") -> JSONObject().put("id", path.removePrefix("/api/query-runs/")).put("status", "completed")
                    path.startsWith("/api/model-settings") -> JSONObject().put("profiles", JSONArray())
                    else -> JSONObject().put("items", JSONArray())
                }
                val bytes = value.toString().toByteArray()
                socket.getOutputStream().apply {
                    write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(bytes); flush()
                }
            } catch (_: Throwable) {
                runCatching { socket.close() }
            }
        }

        override fun close() {
            listener.close(); workers.shutdownNow()
        }
    }

}
