package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Main wire-1 owner service only; generated fixture, no capture or live model. */
@RunWith(AndroidJUnit4::class)
class HistoricalConversationInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private lateinit var fixture: JSONObject
    private val stale get() = MoteI18n.text("这是历史版本，当前资料已更新。")
    private val deleted get() = MoteI18n.text("引用原文已删除，历史问答仍保留。")
    private val erased get() = MoteI18n.text("相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。")
    @Before fun prepare() {
        val args = InstrumentationRegistry.getArguments()
        require(args.getString("historyFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        fixture = JSONObject(File(requireNotNull(args.getString("fixture"))).readText())
        require(fixture.getString("address").startsWith("http://127.0.0.1:"))
        require(fixture.getString("controlAddress").startsWith("http://127.0.0.1:"))
        require(!Settings(context).enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        MoteI18n.select(context, args.getString("language", "zh-CN")!!)
        MoteAppearance.select(context, AppearancePreference.parse(args.getString("appearance", "light")))
    }
    private fun control(action: String): JSONObject {
        val (status, value) = HttpJson.post(fixture.getString("controlAddress") + "/" + action, JSONObject(), fixture.getString("token"))
        assertEquals("Generated $action control", 200, status)
        return requireNotNull(value)
    }
    private fun reset() {
        val value = control("reset")
        for (key in value.keys()) fixture.put(key, value.get(key))
        File(context.noBackupFilesDir, "central-native").deleteRecursively()
        CentralSession.get(context).select("")
        val settings = Settings(context)
        settings.save(settings.read().copy(server = fixture.getString("address"), token = "", debugHttp = true,
            authSignedOut = false, authExpiresAt = 0, authProcess = "", syncMode = "manual"), confirmCentralEndpoint = true)
        val self = CentralClient(fixture.getString("address"), fixture.getString("token")).get("/api/connections/self")
        assertEquals("owner", self.getJSONObject("credential").getString("scope"))
        assertEquals(ProtocolRange(1, 1), ProtocolCompatibility.requireCompatible(self.getJSONObject("node").get("protocol")))
    }
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun shown(activity: MainActivity) = views(activity.window.decorView).filter { it.isShown }
    private fun labels(activity: MainActivity) = shown(activity).filterIsInstance<TextView>().map { it.text.toString() }
    private fun waitFor(scenario: ActivityScenario<MainActivity>, reason: String, predicate: (MainActivity) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) {
            var ready = false; scenario.onActivity { ready = predicate(it) }
            if (ready) { instrumentation.waitForIdleSync(); return }
            Thread.sleep(40)
        }
        fail(reason)
    }
    private fun click(scenario: ActivityScenario<MainActivity>, label: String, prefix: Boolean = false) {
        waitFor(scenario, "Original native action $label") { activity -> shown(activity).filterIsInstance<TextView>().any {
            it.isEnabled && it.isClickable && if (prefix) it.text.toString().startsWith(label) else it.text.toString() == label
        } }
        scenario.onActivity { activity -> assertTrue(shown(activity).filterIsInstance<TextView>().first {
            it.isEnabled && it.isClickable && if (prefix) it.text.toString().startsWith(label) else it.text.toString() == label
        }.performClick()) }
    }
    private fun login(scenario: ActivityScenario<MainActivity>) {
        waitFor(scenario, "Original owner login") { activity -> shown(activity).any { it.contentDescription == MoteI18n.text("中央管理令牌") } }
        scenario.onActivity { activity -> shown(activity).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text("中央管理令牌") }.setText(fixture.getString("token")) }
        click(scenario, MoteI18n.text("登录并继续"))
        waitFor(scenario, "Owner session ready") { activity -> labels(activity).none { it == MoteI18n.text("登录并继续") } }
    }
    private fun open(work: Boolean) = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)
        .putExtra("page", if (work) "ACTIVITY" else "ASK").apply { if (!work) putExtra("conversationId",fixture.getString("conversationId")) }).awaitMainUi()
    private fun conversation(scenario: ActivityScenario<MainActivity>, work: Boolean) {
        if (work) {
            click(scenario, MoteI18n.text("最近完成"))
            val title = fixture.optString("workTitle", fixture.getString("title"))
            waitFor(scenario, "Original work list") { activity -> shown(activity).any { it.isClickable && it.contentDescription?.startsWith(title + ". ") == true } }
            scenario.onActivity { activity -> assertTrue(shown(activity).single { it.isClickable && it.contentDescription?.startsWith(title + ". ") == true }.performClick()) }
            waitFor(scenario, "Original work sections") { activity -> shown(activity).filterIsInstance<Spinner>().any { it.contentDescription == MoteI18n.text("工作详情") } }
            scenario.onActivity { activity ->
                val selector = shown(activity).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("工作详情") }
                selector.setSelection((0 until selector.adapter.count).single { selector.adapter.getItem(it).toString() == MoteI18n.text("成果") })
            }
            click(scenario, MoteI18n.text("查看成果"))
        }
        waitFor(scenario, "Original saved conversation") { labels(it).contains(fixture.getString("answer")) || labels(it).contains(deleted) }
    }
    private fun assertCurrent(scenario: ActivityScenario<MainActivity>) { scenario.onActivity { activity ->
        val text = labels(activity)
        assertTrue(text.contains(fixture.getString("answer")))
        assertFalse(text.contains(stale)); assertFalse(text.contains(deleted))
    }; assertSavedCitations() }
    private fun assertStale(scenario: ActivityScenario<MainActivity>, older: Boolean = false) {
        val answer = fixture.getString(if (older) "olderAnswer" else "answer")
        waitFor(scenario, "Original historical answer response must finish loading") { activity ->
            labels(activity).contains(answer) && labels(activity).contains(stale) && shown(activity).filterIsInstance<TextView>().filter { it.tag == "central-status" }.all { it.text.isBlank() }
        }
        scenario.onActivity { activity ->
            val text = labels(activity)
            assertTrue("Historical version notice must accompany retained native answer", text.contains(stale))
            assertTrue(text.contains(answer)); assertFalse(text.contains(deleted)); assertFalse(text.contains(erased))
            assertTrue(shown(activity).any { it.contentDescription?.toString()?.startsWith(MoteI18n.text("查看引用")) == true } || shown(activity).filterIsInstance<TextView>().any { it.text.toString().startsWith(MoteI18n.text("查看原文依据")) })
        }
        assertSavedCitations()
    }
    private fun api() = CentralClient(fixture.getString("address"),fixture.getString("token"))
    private fun assertSavedCitations() {
        val turns=api().get("/api/conversations/"+fixture.getString("conversationId")+"?limit=50").getJSONArray("turns")
        for ((answerKey,excerptKey) in listOf("answer" to "excerpt","olderAnswer" to "olderExcerpt")) {
            val row=(0 until turns.length()).map { turns.getJSONObject(it) }.single { it.optJSONObject("result")?.optString("answer") == fixture.getString(answerKey) }
            assertEquals(fixture.getString("evidenceId"),row.getJSONObject("result").getJSONArray("citations").getJSONObject(0).getString("id"))
            assertEquals(fixture.getString(excerptKey),row.getJSONObject("result").getJSONArray("citations").getJSONObject(0).getString("excerpt"))
        }
    }
    private fun capture(scenario: ActivityScenario<MainActivity>, name: String) {
        val frames=java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { frames.countDown() } } }
        assertTrue(frames.await(5,java.util.concurrent.TimeUnit.SECONDS)); instrumentation.waitForIdleSync()
        scenario.onActivity { a ->
            assertTrue(a.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
            val root=a.window.decorView; assertTrue(GeneratedWindowRendering.hasNoPendingLabels(root))
            val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
            try { root.draw(android.graphics.Canvas(image)); File(context.filesDir,"history-final").apply { mkdirs() }.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } finally { image.recycle() }
        }
    }
    private fun assertUnavailable(scenario: ActivityScenario<MainActivity>, older: Boolean=false) {
        waitFor(scenario,"Ordinary deletion retains the exact saved answer") { labels(it).contains(deleted) && labels(it).contains(fixture.getString(if(older) "olderAnswer" else "answer")) }
        scenario.onActivity { assertFalse(labels(it).contains(erased)) }; assertSavedCitations()
        assertFalse(api().get("/api/conversations/"+fixture.getString("conversationId")+"/references/"+fixture.getString("evidenceId")).getBoolean("available"))
    }
    private fun assertErased(scenario: ActivityScenario<MainActivity>) {
        waitFor(scenario,"Explicit privacy erasure withdraws dependent answer") { labels(it).contains(erased) }
        scenario.onActivity { activity ->
            val text=labels(activity)
            for(key in listOf("answer","excerpt","olderAnswer","olderExcerpt")) assertFalse(text.contains(fixture.getString(key)))
            assertFalse(shown(activity).any { it.contentDescription?.toString()?.startsWith(MoteI18n.text("查看引用")) == true })
            assertFalse(shown(activity).filterIsInstance<TextView>().any { it.text.toString().startsWith(MoteI18n.text("查看原文依据")) })
        }
    }
    private fun refresh(scenario: ActivityScenario<MainActivity>, work: Boolean) {
        if (!work) {
            scenario.onActivity { a -> shown(a).single { it.contentDescription == MoteI18n.text("返回上级") }.performClick() }
            waitFor(scenario,"Same conversation is reachable in native history") { a -> shown(a).any { row -> row.isClickable && row.contentDescription?.toString()?.startsWith(fixture.getString("title")+". ") == true } }
            scenario.onActivity { a -> shown(a).single { row -> row.isClickable && row.contentDescription?.toString()?.startsWith(fixture.getString("title")+". ") == true }.performClick() }
        }
        else {
            scenario.onActivity { activity -> assertTrue(shown(activity).single { it.contentDescription == MoteI18n.text("返回上级") }.performClick()) }
            click(scenario, MoteI18n.text("查看成果"))
        }
    }
    private fun journey(work: Boolean) {
        reset()
        open(work).use { scenario ->
            login(scenario); conversation(scenario, work); assertCurrent(scenario); capture(scenario,if(work) "work-current" else "ask-current")
            control("stale"); refresh(scenario, work); assertStale(scenario); capture(scenario,if(work) "work-stale" else "ask-stale")
            click(scenario, MoteI18n.text("加载更早的对话")); assertStale(scenario, older = true)
            scenario.recreate(); scenario.awaitMainUi()
            if (work) click(scenario, MoteI18n.text("查看成果"))
            assertStale(scenario)
            control("deleted"); refresh(scenario,work); assertUnavailable(scenario); capture(scenario,if(work) "work-deleted-retained" else "ask-deleted-retained")
            click(scenario,MoteI18n.text("加载更早的对话")); assertUnavailable(scenario,older=true)
            if(work) {
                scenario.onActivity { activity -> shown(activity).single { it.contentDescription == MoteI18n.text("返回上级") }.performClick() }
                waitFor(scenario,"Ordinary deletion keeps the saved work result link") { labels(it).contains(MoteI18n.text("查看成果")) }
                click(scenario,MoteI18n.text("查看成果")); assertUnavailable(scenario)
            } else { refresh(scenario,false); assertUnavailable(scenario) }
            control("erase")
            // An already-open native reader must revalidate every older page.
            click(scenario,MoteI18n.text("加载更早的对话")); assertErased(scenario); capture(scenario,if(work) "work-private-erased" else "ask-private-erased")
            if(work) {
                scenario.onActivity { activity -> shown(activity).single { it.contentDescription == MoteI18n.text("返回上级") }.performClick() }
                waitFor(scenario,"Private erasure withdraws the work result link") { labels(it).contains(MoteI18n.text("成果确认保存后会出现在这里。")) }
                scenario.onActivity { assertFalse(labels(it).contains(MoteI18n.text("查看成果"))) }
            } else { refresh(scenario,false); assertErased(scenario) }

        }
    }
    @Test fun originalAskKeepsHistoricalNoticeAcrossPagingRecreationAndDeletion() = journey(false)
    @Test fun originalWorkResultKeepsHistoricalNoticeAcrossPagingRecreationAndDeletion() = journey(true)
    @Test fun restrictedCredentialWithdrawsCachedHistoricalAnswers() {
        reset(); open(false).use { scenario ->
            login(scenario); conversation(scenario,false); assertCurrent(scenario)
            CentralSession.get(context).signIn(fixture.getString("address"),fixture.getString("restrictedToken"))
            waitFor(scenario,"Changed access scope must withdraw cached answers") { !labels(it).contains(fixture.getString("answer")) && labels(it).any { text -> text.contains(MoteI18n.text("当前连接没有执行此操作的权限，请检查连接权限。")) } }
            scenario.onActivity { assertFalse(labels(it).contains(fixture.getString("olderAnswer"))) }; capture(scenario,"history-restricted")
        }
    }
    @Test fun newProcessPhaseOneRetainsOriginalOwnerHistory() {
        reset()
        open(false).use { scenario ->
            login(scenario); conversation(scenario, false); control("stale"); refresh(scenario, false); assertStale(scenario)
            CentralDraftWrites.barrier { }
            File(context.filesDir, "history-process.json").writeText(JSONObject().put("pid", android.os.Process.myPid())
                .put("started", android.os.Process.getStartElapsedRealtime()).toString())
        }
    }
    @Test fun newProcessPhaseTwoReadsRetainedHistoryThenOrdinaryDeletionAndExplicitErasure() {
        val state = control("state")
        for (key in state.keys()) fixture.put(key, state.get(key))
        val previous = JSONObject(File(context.filesDir, "history-process.json").readText())
        assertTrue("The persisted conversation must be read by a genuinely new process",
            previous.getInt("pid") != android.os.Process.myPid() || previous.getLong("started") != android.os.Process.getStartElapsedRealtime())
        open(false).use { scenario ->
            waitFor(scenario, "Persisted owner and conversation must restore in a new process") { labels(it).contains(fixture.getString("answer")) }
            assertStale(scenario)
            click(scenario, MoteI18n.text("加载更早的对话")); assertStale(scenario, older = true)
            control("deleted"); refresh(scenario, false); assertUnavailable(scenario); control("erase"); refresh(scenario,false); assertErased(scenario)
        }
    }
}
