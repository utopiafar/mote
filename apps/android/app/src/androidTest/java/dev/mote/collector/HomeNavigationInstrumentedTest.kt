package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors

/** Generated data on the task-owned emulator; no capture, user account or model is used. */
@RunWith(AndroidJUnit4::class)
class HomeNavigationInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val conversation = "14d4ef91-48c4-4372-b9ac-008f59b71e46"
    private val feedPhoto = "6a1c3e5b-7d9f-4a2b-8c4d-1e3f5a7b9c02"
    private val feedAudio = "4d7b2a9c-1e5f-4b3a-9d6c-2f4a6b8c0d13"
    private val feedNote = "8f2e4c6a-3b1d-4e5f-a7c9-0d2b4e6f8a24"
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(activity: MainActivity) = views(activity.window.decorView).filter { it.isShown }
    private fun waitFor(scenario: ActivityScenario<MainActivity>, description: String, check: (MainActivity) -> Boolean) {
        val until = SystemClock.elapsedRealtime() + 20000
        while (SystemClock.elapsedRealtime() < until) {
            var done = false; scenario.onActivity { done = check(it) }
            if (done) return
            Thread.sleep(50)
        }
        var labels = ""; scenario.onActivity { labels = shown(it).filterIsInstance<TextView>().joinToString(" | ") { row -> row.text.toString() } }
        fail("$description: $labels")
    }
    private fun screenshot(scenario: ActivityScenario<MainActivity>, name: String) {
        waitFor(scenario, "The requested screen must finish its foreground read before visual comparison") { activity ->
            shown(activity).filterIsInstance<TextView>().none { it.tag == "central-status" && it.text.isNotBlank() }
        }
        val committed = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { committed.countDown() } } }
        assertTrue("The native window must draw before its screenshot", committed.await(5, java.util.concurrent.TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
        scenario.onActivity { activity -> GeneratedWindowRendering.save(activity, File(context.filesDir, "ui-final-home").apply { mkdirs() }, name) }
    }

    @Before fun generatedOnly() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("uiFinalFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled)
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
    }

    /** The home no longer lists conversations; the Ask entry opens the conversation list. */
    private fun openGeneratedConversation(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity -> shown(activity).single { it.tag == "home-ask-action" }.performClick() }
        waitFor(scenario, "The history lists the generated conversation") { shown(it).any { row -> row.contentDescription?.toString()?.startsWith("周五评审需要准备什么？") == true } }
        scenario.onActivity { activity -> shown(activity).single { it.contentDescription?.toString()?.startsWith("周五评审需要准备什么？") == true }.performClick() }
        waitFor(scenario, "The selected conversation loads its answer") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString().contains("这是已提交的生成回答。") } }
    }

    @Test fun recentConversationAndDraftSurviveMenuAndBackWithoutPersistentTabs() {
        ConversationFixture().use { fixture ->
            val settings = Settings(context)
            settings.save(settings.read().copy(server = fixture.origin, token = "generated-home-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
            File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)).deleteRecursively()
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                waitFor(scenario, "The grouped originals must load from the selected Central") { shown(it).any { row -> row.tag == "home-original:$feedPhoto" } }
                screenshot(scenario, "home-recent")
                scenario.onActivity { activity ->
                    assertTrue(shown(activity).any { it.tag == "home-record-action" })
                    assertTrue(shown(activity).any { it.tag == "home-ask-action" })
                    assertFalse(shown(activity).any { it.tag?.toString()?.startsWith("primary:") == true })
                    assertFalse("An intentional capture pause is not a home error", shown(activity).any { it.tag == "home-notice-needs-action" })
                    activity.openGeneratedMenu()
                    for (label in listOf("资料与记忆", "发现历史", "日程与待办", "采集与同步", "设置", "中央工作台"))
                        assertTrue("Secondary capability remains reachable: $label", shown(activity).any { it.tag == "menu:$label" })
                    assertFalse(shown(activity).any { it.tag == "home-record-action" })
                }
                screenshot(scenario, "home-menu")
                scenario.onActivity { activity -> activity.onBackPressed() }
                openGeneratedConversation(scenario)
                assertEquals(conversation, fixture.openedId)
                scenario.onActivity { activity ->
                    shown(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("生成的未发送草稿")
                    activity.onBackPressed()
                    activity.openGeneratedMenu(); activity.onBackPressed()
                    shown(activity).single { it.tag == "home-ask-action" }.performClick()
                }
                waitFor(scenario, "Menu and home transitions preserve the existing native draft") { shown(it).filterIsInstance<EditText>().any { field -> field.contentDescription == "你的问题" && field.text.toString() == "生成的未发送草稿" } }
                scenario.onActivity { assertFalse(Settings(it).enabled) }
                screenshot(scenario, "ask-retained-draft")
                scenario.recreate(); scenario.awaitMainUi()
                waitFor(scenario, "Recreation preserves draft and secondary back path") { shown(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "生成的未发送草稿" } }
                scenario.onActivity { it.onBackPressed(); assertTrue(shown(it).any { row -> row.tag == "home-record-action" }) }
            }
            settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true)
        }
    }

    @Test fun failedHistoryIsDistinctFromEmptyAndUnconnectedFirstUseKeepsLocalRecording() {
        ConversationFixture().use { fixture ->
            val settings = Settings(context)
            settings.save(settings.read().copy(server = fixture.origin, token = "generated-home-owner-token-1234567890", debugHttp = true, syncMode = "manual", authSignedOut = false), confirmCentralEndpoint = true)
            // The feed owns the home middle now: its failures stay distinct from an honest empty.
            for (failure in listOf("http", "missing-items", "invalid-id")) {
                fixture.feedFailure = failure
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario, "A feed read failure is reported, not an empty day list") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "暂不可读取" } }
                    scenario.onActivity { assertFalse(shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "暂无记录。" }) }
                    if (failure == "http") screenshot(scenario, "home-history-error")
                }
            }
            fixture.feedFailure = ""
            // The conversation history page keeps its own failure surface.
            fixture.failure = "http"
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity -> shown(activity).single { it.tag == "home-ask-action" }.performClick() }
                waitFor(scenario, "A failed history read is reported on its own page") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "对话暂不可读取，请稍后重试。" } }
                scenario.onActivity { assertFalse(shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "还没有对话。" }) }
            }
            fixture.failure = ""
            settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true)
        }
        // The no-draft first-use capture must not inherit a retained draft from a previous journey.
        context.recordDraftStore().edit("", JSONArray(), JSONObject().put("kind", "manual"))
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            waitFor(scenario, "First use without a draft shows the record action") { activity ->
                shown(activity).any { it.tag == "home-notice-connect" } && shown(activity).any { it.contentDescription == "记录" } && shown(activity).none { it.contentDescription == "继续草稿" }
            }
            screenshot(scenario, "home-first-use")
            MoteAppearance.select(context, AppearancePreference.DARK)
            scenario.recreate(); scenario.awaitMainUi()
            waitFor(scenario, "First use without a draft keeps the record action in dark") { activity ->
                shown(activity).any { it.tag == "home-notice-connect" } && shown(activity).any { it.contentDescription == "记录" } && shown(activity).none { it.contentDescription == "继续草稿" }
            }
            screenshot(scenario, "home-first-use-dark")
            MoteAppearance.select(context, AppearancePreference.LIGHT)
        }
        context.recordDraftStore().edit("生成的本机草稿", JSONArray(), JSONObject().put("kind", "manual"))
        try { ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            waitFor(scenario, "Unconnected local drafts remain available") { shown(it).any { row -> row.contentDescription == "继续草稿" } }
            screenshot(scenario, "home-first-use-draft")
            MoteAppearance.select(context, AppearancePreference.DARK)
            scenario.recreate(); scenario.awaitMainUi()
            waitFor(scenario, "The first-use home keeps the draft label in dark") { shown(it).any { row -> row.contentDescription == "继续草稿" } }
            screenshot(scenario, "home-first-use-draft-dark")
            scenario.onActivity { activity ->
                assertFalse(Settings(activity).enabled)
                assertTrue(shown(activity).any { it.tag == "home-ask-action" })
                activity.openGeneratedMenu()
                shown(activity).single { it.tag == "menu:设置" }.performClick()
                assertFalse(shown(activity).any { it.tag == "home-record-action" })
                activity.onBackPressed(); activity.onBackPressed()
                assertEquals("生成的本机草稿", context.recordDraftStore().draft().getString("text"))
            }
        } } finally { context.recordDraftStore().edit("", JSONArray(), JSONObject().put("kind", "manual")) }
    }

    @Test fun permissionInterruptionAndStaleConversationDoNotStartOrCrossTargets() {
        ConversationFixture().use { fixture ->
            val settings = Settings(context)
            settings.save(settings.read().copy(server = fixture.origin, token = "generated-home-owner-token-1234567890", debugHttp = true, syncMode = "manual", authSignedOut = false), confirmCentralEndpoint = true)
            settings.status("permission_required", "生成的权限中断，请恢复权限")
            try {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario, "A service interruption stays visible after capture safely stops") { shown(it).any { row -> row.tag == "home-notice-needs-action" } }
                    waitFor(scenario, "Feed row is ready") { shown(it).any { row -> row.tag == "home-original:$feedPhoto" } }
                    scenario.onActivity { activity ->
                        val stale = shown(activity).single { it.tag == "home-original:$feedPhoto" }
                        settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true)
                        stale.performClick()
                        assertTrue(shown(activity).any { it.tag == "home-record-action" })
                        assertFalse(shown(activity).any { it.tag == "home-original:$feedPhoto" })
                        assertFalse(settings.enabled)
                    }
                }
            } finally { settings.status("paused", "生成的主动暂停"); settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true) }
        }
    }

    @Test fun connectedEmptyArchiveShowsFirstUseOnlyAfterSuccessfulArchiveReads() {
        val settings = Settings(context)
        require(context.queue().depth() == 0 && context.localSources().sources().isEmpty())
        ConversationFixture().use { fixture ->
            fixture.emptyArchive = true
            settings.save(settings.read().copy(server = fixture.origin, token = "generated-home-owner-token-1234567890", debugHttp = true, syncMode = "manual", authSignedOut = false), confirmCentralEndpoint = true)
            try {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario,"Confirmed empty connected archive hides the feed section") { shown(it).none { row -> row.tag == "home-feed" } }
                    scenario.onActivity { activity ->
                        assertFalse("A connected archive needs no first-use connection prompt", shown(activity).any { it.tag == "home-notice-connect" })
                        assertFalse(shown(activity).filterIsInstance<TextView>().any { it.text.toString() == "还没有自己的 Mote？" })
                        assertFalse(settings.enabled)
                    }
                    screenshot(scenario,"home-connected-empty")
                }
                fixture.archiveFailure = true
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario,"History read completed") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "暂无记录。" } }
                    scenario.onActivity { activity ->
                        assertFalse("An unavailable inventory must not be declared empty",shown(activity).any { it.tag == "home-notice-connect" })
                        assertFalse(settings.enabled)
                    }
                }
            } finally { settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true) }
        }
    }

    @Test fun turnDetailsAndCitationReturnRetainDraftAndUnavailableHistoryStaysReadable() {
        ConversationFixture().use { fixture ->
            fixture.includeCitations = true
            val settings = Settings(context)
            settings.save(settings.read().copy(server = fixture.origin, token = "generated-home-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
            val draftDirectory = File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin))
            try {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario,"The grouped feed is available") { shown(it).any { row -> row.tag == "home-original:$feedPhoto" } }
                    openGeneratedConversation(scenario)
                    waitFor(scenario,"The completed turn must show its actions") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString() == "更多" } }
                    scenario.onActivity { activity ->
                        shown(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated retained follow-up")
                        shown(activity).filterIsInstance<TextView>().single { it.text.toString() == "更多" }.performClick()
                    }
                    instrumentation.waitForIdleSync()
                    val dialogDrawn = java.util.concurrent.CountDownLatch(1)
                    scenario.onActivity { activity -> activity.window.decorView.postOnAnimation { activity.window.decorView.postOnAnimation { dialogDrawn.countDown() } } }
                    assertTrue(dialogDrawn.await(5,java.util.concurrent.TimeUnit.SECONDS))
                    scenario.onActivity { activity ->
                        val overlays = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { root -> views(root).any { it is TextView && it.text.toString() == "本轮详情" } }
                        assertEquals(1,overlays.size)
                        val labels = views(overlays.single()).filterIsInstance<TextView>().map { it.text.toString() }
                        assertTrue(labels.contains("generated-model")); assertTrue(labels.contains("未提供估价")); assertTrue(labels.contains("1 份已引用资料"))
                        val facts = views(overlays.single()).filterIsInstance<android.widget.LinearLayout>().filter { it.tag?.toString()?.startsWith("turn-detail:") == true }
                        assertEquals(3,facts.size); assertEquals(1,facts.map { it.getChildAt(1).left }.distinct().size)
                        GeneratedWindowRendering.save(activity,File(context.filesDir,"ui-final-home").apply { mkdirs() },"ask-turn-details",overlays)
                        overlays.single().findViewById<View>(android.R.id.button1).performClick()
                        shown(activity).single { it.contentDescription == "查看引用 1 · Generated source" }.performClick()
                    }
                    waitFor(scenario,"Available exact citation must load its original capture") {
                        android.view.inspector.WindowInspector.getGlobalWindowViews().filter { root -> root.isShown && root.hasWindowFocus() }.flatMap(::views).filterIsInstance<TextView>().any { row -> row.text.toString() == "Generated original content" }
                    }
                    assertEquals(2,fixture.captureReads)
                    instrumentation.runOnMainSync {
                        val root=android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.isShown && it.hasWindowFocus() }
                        val labels=views(root).filterIsInstance<TextView>().map { it.text.toString() }
                        assertTrue(labels.contains("Generated separate description"))
                        assertTrue(labels.indexOf("Generated original content") < labels.indexOf("Generated separate description"))
                        views(root).single { it.contentDescription == "返回上一页" }.performClick()
                    }
                    waitFor(scenario,"Returning from evidence retains the same draft") { shown(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "Generated retained follow-up" } }
                    fixture.referenceAvailable = false
                    scenario.onActivity { shown(it).single { row -> row.contentDescription == "查看引用 1 · Generated source" }.performClick() }
                    waitFor(scenario,"Unavailable reference explains that history stays") {
                        android.view.inspector.WindowInspector.getGlobalWindowViews().any { root -> views(root).filterIsInstance<TextView>().any { row -> row.text.toString() == "引用原文已删除，历史问答仍保留。" } }
                    }
                    assertEquals("Unavailable references may not fall back to the owner archive",2,fixture.captureReads)
                    scenario.onActivity { activity ->
                        val overlay = android.view.inspector.WindowInspector.getGlobalWindowViews().single { root -> views(root).filterIsInstance<TextView>().any { row -> row.text.toString() == "引用不可用" } }
                        overlay.findViewById<View>(android.R.id.button1).performClick()
                        activity.onBackPressed()
                    }
                    fixture.failure = "all"
                    scenario.onActivity { shown(it).single { row -> row.tag == "home-ask-action" }.performClick() }
                    waitFor(scenario,"A failed remote read must not hide the durable local question") { shown(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "Generated retained follow-up" } }
                    scenario.onActivity { activity -> assertTrue(shown(activity).filterIsInstance<TextView>().any { row -> row.text.toString() == "这是已提交的生成回答。" }) }
                }
            } finally {
                settings.save(settings.read().copy(server = "", token = "", debugHttp = false), confirmCentralEndpoint = true)
                draftDirectory.deleteRecursively()
            }
        }
    }

    @Test fun aReaderFromAnotherOriginCannotAnchorANewQuestionOnTheCurrentNode() {
        ConversationFixture().use { fixture ->
            val settings=Settings(context); val before=settings.read()
            settings.save(before.copy(server=fixture.origin,token="generated-home-owner-token-1234567890",debugHttp=true,syncMode="manual",syncPaused=true,authSignedOut=false),confirmCentralEndpoint=true)
            try {
                ActivityScenario.launch<CentralActivity>(android.content.Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("evidenceId","3f4cf6ee-b09b-4fcf-a718-c0944f4b46cc").putExtra("evidenceOrigin","https://generated-other.invalid")).use { scenario ->
                    val end=SystemClock.elapsedRealtime()+15_000; var ready=false
                    while (!ready && SystemClock.elapsedRealtime()<end) { scenario.onActivity { a -> ready=views(a.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == "访问凭据已失效，请重新连接。" } }; if(!ready) Thread.sleep(40) }
                    assertTrue("The stale origin is explained on the real composer",ready)
                    scenario.onActivity { a ->
                        val labels=views(a.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                        assertTrue(labels.contains(MoteI18n.text("参考资料"))); assertFalse(labels.any { it.startsWith("参考这条记录") || it.startsWith("仅查这条记录") })
                    }
                    assertEquals(0,fixture.captureReads)
                }
            } finally { settings.save(before,confirmCentralEndpoint=true) }
        }
    }

    @Test fun sharedReaderReturnsToTheSameLongAnswerScrollAndUnsentQuestion() {
        ConversationFixture().use { fixture ->
            fixture.includeCitations=true; fixture.longAnswer=true
            val settings=Settings(context); val before=settings.read()
            settings.save(before.copy(server=fixture.origin,token="generated-home-owner-token-1234567890",debugHttp=true,syncMode="manual",syncPaused=true,authSignedOut=false),confirmCentralEndpoint=true)
            try {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario,"The grouped feed is available") { shown(it).any { row -> row.tag == "home-original:$feedPhoto" } }
                    openGeneratedConversation(scenario)
                    waitFor(scenario,"Long answer loaded") { shown(it).filterIsInstance<TextView>().any { row -> row.text.toString().contains("Generated original answer paragraph 70") } }
                    var position=0
                    scenario.onActivity { a ->
                        shown(a).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated unsent question at the cited answer")
                        val scroll=views(a.window.decorView).filterIsInstance<android.widget.ScrollView>().single { it.isShown && it.findViewWithTag<View>("central-body") != null }
                        scroll.scrollTo(0,scroll.getChildAt(0).height); position=scroll.scrollY; assertTrue("The real long answer is scrolled",position>0)
                        shown(a).single { it.contentDescription == "查看引用 1 · Generated source" }.performClick()
                    }
                    val end=SystemClock.elapsedRealtime()+15_000; var ready=false
                    while (!ready && SystemClock.elapsedRealtime()<end) { instrumentation.runOnMainSync { ready=android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filterIsInstance<TextView>().any { it.text.toString() == "Generated original content" } }; if(!ready) Thread.sleep(40) }
                    assertTrue("Actual shared reader must show its original",ready)
                    instrumentation.runOnMainSync { views(android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.isShown && it.hasWindowFocus() }).single { it.contentDescription == "返回上一页" }.performClick() }
                    waitFor(scenario,"Return retains the unsent question") { shown(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "Generated unsent question at the cited answer" } }
                    scenario.onActivity { a -> val scroll=views(a.window.decorView).filterIsInstance<android.widget.ScrollView>().single { it.isShown && it.findViewWithTag<View>("central-body") != null }; assertEquals("Return preserves the actual answer scroll",position,scroll.scrollY) }
                }
            } finally { settings.save(before,confirmCentralEndpoint=true) }
        }
    }

    @Test fun citationPinChangesShowAnErrorAndReturnToTheUnchangedConversationDraft() {
        ConversationFixture().use { fixture ->
            fixture.includeCitations=true; fixture.changeVersionOnSecondRead=true
            val settings=Settings(context); val before=settings.read()
            settings.save(before.copy(server=fixture.origin,token="generated-home-owner-token-1234567890",debugHttp=true,syncMode="manual",syncPaused=true,authSignedOut=false),confirmCentralEndpoint=true)
            try {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    waitFor(scenario,"The grouped feed is available") { shown(it).any { row -> row.tag == "home-original:$feedPhoto" } }
                    openGeneratedConversation(scenario)
                    waitFor(scenario,"Original citation available") { shown(it).any { row -> row.contentDescription == "查看引用 1 · Generated source" } }
                    scenario.onActivity { a -> shown(a).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated pin-race draft"); shown(a).single { it.contentDescription == "查看引用 1 · Generated source" }.performClick() }
                    val end=SystemClock.elapsedRealtime()+15_000
                    var rejected=false
                    while (!rejected && SystemClock.elapsedRealtime()<end) {
                        instrumentation.runOnMainSync {
                            val labels=android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filterIsInstance<TextView>().map { it.text.toString() }
                            assertFalse("Changed record must not be presented as the cited original",labels.contains("Generated original content"))
                            rejected=labels.any { it.contains("分页内容已变化") }
                        }
                        if (!rejected) Thread.sleep(40)
                    }
                    assertTrue("Actual second read changed the pinned version",rejected); assertEquals(2,fixture.captureReads)
                    instrumentation.runOnMainSync { views(android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.isShown && it.hasWindowFocus() }).single { it.contentDescription == "返回上一页" }.performClick() }
                    waitFor(scenario,"Return preserves the original draft and answer") { shown(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "Generated pin-race draft" } && shown(it).filterIsInstance<TextView>().any { field -> field.text.toString() == "这是已提交的生成回答。" } }
                }
            } finally { settings.save(before,confirmCentralEndpoint=true) }
        }
    }

    private inner class ConversationFixture : AutoCloseable {
        private val listener = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${listener.localPort}"
        @Volatile var failure = ""
        @Volatile var openedId: String? = null
        @Volatile var includeCitations = false
        @Volatile var referenceAvailable = true
        @Volatile var captureReads = 0
        @Volatile var changeVersionOnSecondRead = false
        @Volatile var longAnswer = false
        @Volatile var emptyArchive = false
        @Volatile var archiveFailure = false
        @Volatile var feedFailure = ""
        private val evidence = "3f4cf6ee-b09b-4fcf-a718-c0944f4b46cc"
        private val zone = java.time.ZoneId.systemDefault()
        private val dayStart = java.time.LocalDate.now(zone).atStartOfDay(zone)
        private val feedItems = JSONArray()
            .put(JSONObject().put("id", feedPhoto).put("capturedAt", java.time.Instant.now().toString()).put("source", "screen")
                .put("deviceId", "generated-device").put("hasImage", true)
                .put("windowTitle", "生成的设计稿.png").put("appName", "生成设计工具").put("textPreview", "生成的设计稿标注内容"))
            .put(JSONObject().put("id", feedAudio).put("capturedAt", dayStart.minusHours(2).toInstant().toString()).put("source", "media")
                .put("deviceId", "generated-device").put("hasImage", false).put("durationMs", 642000)
                .put("windowTitle", "生成的录音").put("appName", "录音机").put("textPreview", ""))
            .put(JSONObject().put("id", feedNote).put("capturedAt", dayStart.minusHours(3).toInstant().toString()).put("source", "note")
                .put("deviceId", "generated-device").put("hasImage", false)
                .put("windowTitle", "生成的会议纪要.txt").put("appName", "生成文本编辑器").put("textPreview", "生成的纪要正文摘要"))
        private val thumbnail: ByteArray by lazy {
            val bitmap = android.graphics.Bitmap.createBitmap(96, 64, android.graphics.Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(bitmap).apply { drawColor(0xFF33608C.toInt()); drawRect(8f, 8f, 88f, 56f, android.graphics.Paint().apply { color = 0xFFE8C468.toInt() }) }
            java.io.ByteArrayOutputStream().also { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        }
        private val executor = Executors.newSingleThreadExecutor()
        init { executor.submit {
            while (!listener.isClosed) runCatching { listener.accept() }.getOrNull()?.use { socket ->
                val input = socket.getInputStream().bufferedReader()
                val first = input.readLine().orEmpty(); val path = first.split(' ').getOrElse(1) { "" }
                while (!input.readLine().isNullOrBlank()) Unit
                val isHistory = path.startsWith("/api/conversations?")
                val isFeedList = path.startsWith("/api/capture-browser?")
                val isFailure = failure == "all" || failure == "http" && isHistory || archiveFailure && path == "/api/status" || feedFailure == "http" && isFeedList
                if (path.startsWith("/api/capture-browser/") && path.contains("/image")) {
                    val bytes = thumbnail
                    socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(bytes); flush() }
                    return@use
                }
                val body = when {
                    isFailure -> JSONObject().put("error", "generated_failure")
                    isFeedList && feedFailure == "missing-items" -> JSONObject().put("unrelated", true)
                    isFeedList && feedFailure == "invalid-id" -> JSONObject().put("items", JSONArray().put(JSONObject()
                        .put("id", "not-a-record-id").put("capturedAt", "2026-10-28T10:00:00Z").put("source", "note").put("deviceId", "generated-device")))
                    isFeedList -> JSONObject().put("items", if (emptyArchive) JSONArray() else feedItems)
                    isHistory && failure == "missing-items" -> JSONObject().put("unrelated", true)
                    isHistory && failure == "invalid-id" -> JSONObject().put("items", JSONArray().put(JSONObject().put("id", "not-a-conversation-id")))
                    path.startsWith("/api/conversations?") -> JSONObject().put("items", JSONArray().apply { if (!emptyArchive) put(JSONObject().put("id", conversation).put("title", "周五评审需要准备什么？").put("updatedAt", "2026-10-28T10:00:00Z").put("turnCount", 1)) })
                    path == "/api/status" -> JSONObject().put("storage",JSONObject().put("captures",0))
                    path.contains("/references/") -> JSONObject().put("id",evidence).put("available",referenceAvailable)
                    path.startsWith("/api/capture-browser/") -> { captureReads++; JSONObject().put("id",evidence).put("deviceId","generated-source-device").put("source","note").put("libraryVersion", (if (changeVersionOnSecondRead && captureReads >= 2) "b" else "a").repeat(64)).put("appName","Generated source").put("ocrText","Generated original content").put("capturedAt","2026-10-28T10:00:00Z").put("metadata",JSONObject().put("ownerDescription","Generated separate description")) }
                    path.startsWith("/api/conversations/") -> { openedId = path.substringAfter("/api/conversations/").substringBefore('?'); JSONObject().put("id", conversation).put("scope", JSONObject()).put("turns", JSONArray().put(JSONObject().put("question", "周五评审需要准备什么？").put("result", JSONObject().put("answer", "这是已提交的生成回答。" + if (longAnswer) "\n\n" + (1..70).joinToString("\n\n") { "Generated original answer paragraph $it" } else "").put("modelSelection",JSONObject().put("model","generated-model")).put("citations", JSONArray().apply { if (includeCitations) put(JSONObject().put("id",evidence).put("appName","Generated source").put("capturedAt","2026-10-28T10:00:00Z")) })))) }
                    path.startsWith("/api/model-settings") -> JSONObject().put("profiles", JSONArray())
                    else -> JSONObject().put("items", JSONArray())
                }.toString().toByteArray()
                val status = if (isFailure) "503 Service Unavailable" else "200 OK"
                socket.getOutputStream().apply { write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(body); flush() }
            }
        } }
        override fun close() { listener.close(); executor.shutdownNow() }
    }
}
