package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Only the opt-in dedicated emulator and scripts/android-central-fixture.ts. No personal capture or live model. */
@RunWith(AndroidJUnit4::class)
class NativeCentralInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val origin = "http://127.0.0.1:47883"
    private val owner = "generated-native-central-owner-token-123456"
    @Before fun prepare() {
        assumeTrue("Dedicated generated-only emulator fixture required", InstrumentationRegistry.getArguments().getString("nativeCentralFixture") == "true")
        assertTrue(Build.MODEL.contains("sdk", true) || Build.FINGERPRINT.contains("emulator", true))
        assertEquals("dev.mote.collector.dev", context.packageName)
        // Each generated fixture starts clean; individual tests still verify restart persistence.
        java.io.File(context.noBackupFilesDir, "central-native").deleteRecursively()
        Settings(context).enabled = false
        MoteI18n.select(context, "zh-CN")
        CentralSession.get(context).select("")
        val settings = Settings(context)
        settings.save(settings.read().copy(server = origin, token = "", debugHttp = true, authSignedOut = false, authExpiresAt = 0, authProcess = ""), confirmCentralEndpoint = true)
    }
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun all(activity: CentralActivity) = views(activity.window.decorView)
    private fun waitFor(scenario: ActivityScenario<out CentralActivity>, label: String, predicate: (CentralActivity) -> Boolean) {
        val deadline = System.currentTimeMillis() + 20000
        while (System.currentTimeMillis() < deadline) {
            var ready = false; scenario.onActivity { ready = predicate(it) }
            if (ready) return
            Thread.sleep(100)
        }
        var current = ""; scenario.onActivity { current = all(it).filterIsInstance<TextView>().joinToString(" | ") { view -> view.text.toString() } }
        fail("$label: $current")
    }
    private fun contains(activity: CentralActivity, text: String) = all(activity).filterIsInstance<TextView>().any { it.text.toString().contains(text) }
    private fun click(scenario: ActivityScenario<out CentralActivity>, text: String) {
        waitFor(scenario, "Button $text") { activity -> all(activity).filterIsInstance<Button>().any { it.text.toString() == text && it.isEnabled } }
        scenario.onActivity { activity -> all(activity).filterIsInstance<Button>().first { it.text.toString() == text }.performClick() }
    }
    private fun login(scenario: ActivityScenario<out CentralActivity>) {
        waitFor(scenario, "Native login") { contains(it, "中央管理令牌") }
        scenario.onActivity { activity -> all(activity).filterIsInstance<EditText>().first { it.contentDescription == "中央管理令牌" }.setText(owner) }
        click(scenario, "登录并继续")
        waitFor(scenario, "Owner session") { it.client != null && !contains(it, "登录并继续") }
    }
    private fun open(page: String = "overview") = ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", page))

    @Test fun allCentralPagesUseNativeViewsAndOneSession() {
        open().use { scenario ->
            login(scenario)
            for ((page, _) in CentralScreens.pages) {
                scenario.onActivity { it.navigate(page) }
                waitFor(scenario, "Loaded $page") { activity ->
                    val text = all(activity).filterIsInstance<TextView>().map { it.text.toString() }
                    !activity.isWorking && text.none { it.startsWith("正在读取") || it.startsWith("正在连接") } && activity.client != null
                }
                scenario.onActivity { activity ->
                    val tabs = all(activity).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }
                    assertTrue(tabs.isEmpty())
                    assertTrue("$page has a visible back action", all(activity).any { it.isShown && it.contentDescription == MoteI18n.text("返回上级") })
                    assertFalse("$page embeds a WebView", all(activity).any { it is WebView })
                    assertFalse("$page requested another token", contains(activity, "登录并继续"))
                    assertEquals("$page API error", "", all(activity).filterIsInstance<TextView>().first { it.tag == "central-status" }.text.toString())
                }
            }
        }
    }
    @Test fun libraryTypesExcludeLegacyCodingStatusWithoutRedirectingItsDirectRoute() {
        open("archive").use { scenario ->
            login(scenario); waitFor(scenario, "Archive catalog ready") { !it.isWorking && contains(it, "全部资料") }
            scenario.onActivity { activity ->
                val types = all(activity).filterIsInstance<android.widget.Spinner>().single { it.contentDescription == "资料类型" }
                val labels = (0 until types.adapter.count).map { types.adapter.getItem(it).toString() }
                assertTrue(labels.contains("资料库"))
                assertFalse(labels.contains("Coding Agent 上传")); assertFalse(labels.contains("Coding 会话同步状态"))
                activity.navigate("coding")
            }
            waitFor(scenario, "Legacy Coding status remains selected after loading") { !it.isWorking && contains(it, "Coding 会话同步状态") }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                assertEquals("Coding 会话同步状态", (all(activity).single { it.tag == "central-title" } as TextView).text.toString())
                assertTrue(all(activity).filterIsInstance<android.widget.Spinner>().none { it.contentDescription == "资料类型" })
                assertFalse(all(activity).any { it.tag?.toString()?.startsWith("primary:") == true })
            }
        }
    }
    @Test fun settingsFormsSaveAgainstRealContractsAndInvitationIsDisplayed() {
        open("settings").use { scenario ->
            login(scenario); waitFor(scenario, "Settings ready") { !it.isWorking }
            click(scenario, "模型配置"); waitFor(scenario, "Models ready") { !it.isWorking && contains(it, "功能默认模型") }
            click(scenario, "功能默认模型"); click(scenario, "保存设置")
            waitFor(scenario, "Model defaults saved") { !it.isWorking && contains(it, "功能默认模型") }
            scenario.onActivity { it.navigate("settings") }; waitFor(scenario, "Settings ready") { !it.isWorking }
            click(scenario, "并发与执行设置"); waitFor(scenario, "Concurrency form") { !it.isWorking && contains(it, "交互并发") }
            click(scenario, "保存设置"); waitFor(scenario, "Concurrency saved") { !it.isWorking && contains(it, "模型配置") }
            click(scenario, "处理设置"); waitFor(scenario, "File settings") { !it.isWorking && contains(it, "保存设置") }
            click(scenario, "保存设置"); waitFor(scenario, "File settings saved") { !it.isWorking && contains(it, "模型配置") }
            scenario.onActivity { it.navigate("connections") }; waitFor(scenario, "Connections") { !it.isWorking }
            click(scenario, "生成设备连接邀请"); click(scenario, "保存设置")
            waitFor(scenario, "Invitation returned") { !it.isWorking && contains(it, "授权已创建") && contains(it, "mote.connection") }
        }
    }
    @Test fun generatedEvidenceAndActivityAreReadableWithoutExecutingMarkup() {
        val literal = "Generated native note ${java.util.UUID.randomUUID()} <script>untrusted evidence</script>"
        val device = "generated-literal-${java.util.UUID.randomUUID()}"
        CentralClient(origin, owner).post("/api/notes", JSONObject().put("id", java.util.UUID.randomUUID().toString())
            .put("deviceId", device).put("deviceName", device).put("platform", "android")
            .put("capturedAt", java.time.Instant.now().toString()).put("text", literal))
        // The archive catalog groups notes under a generic title. The actual Notes entry point
        // exposes each literal note, so select this generated card rather than the first archive item.
        open("notes").use { scenario ->
            login(scenario); waitFor(scenario, "Exact generated note card") { !it.isWorking && contains(it, literal) }
            scenario.onActivity { activity ->
                val target = all(activity).filterIsInstance<Button>().single { button ->
                    button.text.toString() == "查看原文" && views(button.parent as View).filterIsInstance<TextView>().any { it.text.toString() == literal }
                }
                assertTrue(target.performClick())
            }
            waitFor(scenario, "Literal generated evidence") { !it.isWorking && contains(it, "<script>untrusted evidence</script>") }
            scenario.onActivity { it.navigate("archive") }; waitFor(scenario, "Archive ready") { !it.isWorking }
            click(scenario, "原始采集记录"); waitFor(scenario, "Raw records ready") { !it.isWorking && contains(it, "搜索原文") }
            click(scenario, "应用活动与媒体"); waitFor(scenario, "Activity ready") { !it.isWorking && contains(it, "媒体统计") }
            scenario.onActivity { activity ->
                assertEquals("", all(activity).filterIsInstance<TextView>().first { it.tag == "central-status" }.text.toString())
                assertFalse(all(activity).any { it is WebView })
            }
        }
    }
    @Test fun renderGeneratedNativeViewsForVisualReview() {
        open("ask").use { scenario ->
            login(scenario); waitFor(scenario, "Ask ready") { !it.isWorking && contains(it, "你的问题") }
            click(scenario, "新对话"); waitFor(scenario, "Fresh generated question") { !it.isWorking && contains(it, "你的问题") }
            for (page in listOf("ask", "notes", "settings")) {
                scenario.onActivity { it.navigate(page) }; waitFor(scenario, "$page ready") { !it.isWorking }
                // App drawing of this isolated fixture only; never capture another app or a personal device.
                scenario.onActivity { activity ->
                    val root = activity.window.decorView
                    val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
                    root.draw(android.graphics.Canvas(bitmap))
                    java.io.File(context.cacheDir, "native-fixture-$page.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                }
            }
        }
    }
    @Test fun settingsUiUsesOneSelectedProviderAndTenTaskPages() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("settingsUiFixture") == "true")
        fun screenshot(scenario: ActivityScenario<out CentralActivity>, name: String) {
            scenario.onActivity { activity ->
                val root = activity.window.decorView
                val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bitmap))
                java.io.File(context.cacheDir, "settings-ui-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
        open("settings").use { scenario ->
            login(scenario); waitFor(scenario, "Settings loaded") { !it.isWorking }
            screenshot(scenario, "settings")
            click(scenario, "模型配置"); waitFor(scenario, "Provider choice") { !it.isWorking && all(it).any { view -> view.contentDescription == "Provider 预设" } }
            scenario.onActivity { activity ->
                assertEquals(1, all(activity).filterIsInstance<Button>().count { it.text.toString() == "复制为新预设" })
                assertEquals(1, all(activity).count { it.contentDescription == "返回上级" })
            }
            scenario.onActivity { activity ->
                val choice = all(activity).filterIsInstance<android.widget.Spinner>().first { it.contentDescription == "Provider 预设" }
                assertTrue(choice.count > 1); choice.setSelection(1)
            }
            waitFor(scenario, "Selected provider only") { !it.isWorking && contains(it, "合成预设 1 ·") }
            scenario.onActivity { activity -> assertEquals(1, all(activity).filterIsInstance<Button>().count { it.text.toString() == "复制为新预设" }) }
            screenshot(scenario, "models")
            scenario.onActivity { all(it).first { view -> view.contentDescription == "返回上级" }.performClick(); it.navigate("processing") }
            waitFor(scenario, "First ten tasks") { !it.isWorking && all(it).count { view -> view.tag?.toString()?.startsWith("operation:") == true } == 10 }
            fun ids(): List<String> { var result = emptyList<String>(); scenario.onActivity { activity -> result = all(activity).mapNotNull { it.tag?.toString()?.takeIf { tag -> tag.startsWith("operation:") } } }; return result }
            screenshot(scenario, "processing")
            click(scenario, "下一页"); waitFor(scenario, "Page two") { !it.isWorking && contains(it, "第 2 页") }; val second = ids()
            click(scenario, "下一页"); waitFor(scenario, "Page three") { !it.isWorking && contains(it, "第 3 页") }
            click(scenario, "上一页"); waitFor(scenario, "Previous page two") { !it.isWorking && contains(it, "第 2 页") }; assertEquals(second, ids())
            scenario.onActivity { activity -> all(activity).first { it.tag?.toString()?.startsWith("operation:") == true }.performClick() }
            waitFor(scenario, "Task detail") { !it.isWorking && contains(it, "任务详情") }; screenshot(scenario, "detail")
            scenario.onActivity { all(it).first { view -> view.contentDescription == "返回上级" }.performClick() }; waitFor(scenario, "Detail returns to page two") { !it.isWorking && contains(it, "第 2 页") }; assertEquals(second, ids())
            scenario.onActivity { activity -> all(activity).filterIsInstance<android.widget.Spinner>().first { it.contentDescription == "任务状态" }.setSelection(4) }
            waitFor(scenario, "Empty failed filter") { !it.isWorking && contains(it, "没有符合条件的任务") && contains(it, "第 1 页") }
            assertTrue(ids().isEmpty())
        }
    }
    @Test fun queryAndDraftSurviveNavigationAndActivityRecreation() {
        open("ask").use { scenario ->
            login(scenario); waitFor(scenario, "Ask ready") { !it.isWorking && contains(it, "你的问题") }
            scenario.onActivity { activity -> all(activity).filterIsInstance<EditText>().first { it.contentDescription == "你的问题" }.setText("Generated native question 中文 🐾") }
            click(scenario, "发送")
            Thread.sleep(200)
            scenario.onActivity { it.navigate("archive") }; scenario.recreate()
            waitFor(scenario, "Archive restored") { it.client != null && contains(it, "全部资料") }
            scenario.onActivity { it.navigate("ask") }
            waitFor(scenario, "Answer persisted") { contains(it, "Generated native answer") }
            scenario.onActivity { it.navigate("notes") }
            waitFor(scenario, "Notes ready") { !it.isWorking && contains(it, "此刻想留下什么？") }
            scenario.onActivity { activity -> all(activity).filterIsInstance<EditText>().first { it.contentDescription == "此刻想留下什么？" }.setText("Generated offline draft 中文 🐾") }
            scenario.recreate()
            waitFor(scenario, "Encrypted draft restored") { all(it).filterIsInstance<EditText>().any { field -> field.text.toString() == "Generated offline draft 中文 🐾" } }
            click(scenario, "保存并同步")
            waitFor(scenario, "Note synchronized") { contains(it, "Generated offline draft 中文 🐾") && all(it).filterIsInstance<EditText>().any { field -> field.contentDescription == "此刻想留下什么？" && field.text.isEmpty() } }
        }
    }

    @Test fun querySurvivesReturningThroughHomeAndSecondaryMenu() {
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            fun visible(activity: MainActivity) = views(activity.window.decorView).filter { it.isShown }
            fun await(label: String, predicate: (MainActivity) -> Boolean) {
                val deadline = System.currentTimeMillis() + 20000
                while (System.currentTimeMillis() < deadline) {
                    var ready = false; scenario.onActivity { ready = predicate(it) }
                    if (ready) return
                    Thread.sleep(50)
                }
                fail(label)
            }
            fun click(label: String) = scenario.onActivity { activity ->
                visible(activity).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == label }.performClick()
            }
            val askMonitor = instrumentation.addMonitor("dev.mote.collector.AskActivity", null, true)
            val centralMonitor = instrumentation.addMonitor(CentralActivity::class.java.name, null, true)
            try {
                scenario.onActivity { activity -> visible(activity).single { it.tag == "home-ask-action" }.performClick() }
                await("Native login") { visible(it).any { view -> view.contentDescription == "中央管理令牌" } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "中央管理令牌" }.setText(owner) }
                click("登录并继续")
                await("Ask ready") { visible(it).any { view -> view.contentDescription == "你的问题" && view.isEnabled } }
                click("新对话")
                await("New conversation ready") { visible(it).any { view -> view.contentDescription == "你的问题" && view.isEnabled } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated primary navigation question") }
                click("发送")
                scenario.onActivity { activity -> activity.openGeneratedMenu(); activity.openGeneratedHome(); visible(activity).single { it.tag == "home-ask-action" }.performClick() }
                await("Accepted answer survives primary navigation") { visible(it).filterIsInstance<TextView>().any { view -> view.text.contains("Generated native answer") } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated unsent draft") }
                scenario.onActivity { activity -> activity.openGeneratedHome(); visible(activity).single { it.tag == "home-ask-action" }.performClick() }
                Thread.sleep(2000) // Allow the return-to-tab poll timer to run before checking the next draft.
                scenario.onActivity { activity -> assertEquals("Generated unsent draft", visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.text.toString()) }
                scenario.recreate(); scenario.awaitMainUi()
                await("Ask draft survives host recreation") { visible(it).filterIsInstance<EditText>().any { view -> view.contentDescription == "你的问题" && view.isEnabled && view.text.toString() == "Generated unsent draft" } }
                scenario.onActivity { activity ->
                    assertTrue(visible(activity).filterIsInstance<TextView>().any { it.text.contains("Generated native answer") })
                    assertEquals(0, visible(activity).filterIsInstance<MotePrimaryNavigation>().size)
                    assertTrue(visible(activity).any { it.tag == "central-title" })
                    assertFalse(Settings(activity).enabled)
                    val question = visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }
                    assertTrue(question.requestFocus())
                    activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(question, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                }
                await("Ask keyboard opens") { it.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }
                scenario.onActivity { activity ->
                    val root = activity.window.decorView
                    val keyboard = root.rootWindowInsets.getInsets(android.view.WindowInsets.Type.ime())
                    val question = visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }
                    val bounds = android.graphics.Rect(); assertTrue(question.getGlobalVisibleRect(bounds))
                    assertTrue("Question stays reachable above the keyboard", bounds.top < root.height - keyboard.bottom)
                    // Draw only this opt-in fixture app's generated views.
                    val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
                    root.draw(android.graphics.Canvas(bitmap))
                    java.io.File(context.cacheDir, "native-fixture-ask-tab-keyboard.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    activity.onBackPressed()
                    assertTrue(visible(activity).any { it.tag == "home-record-action" })
                }
                assertEquals(0, askMonitor.hits); assertEquals(0, centralMonitor.hits)
            } finally { instrumentation.removeMonitor(askMonitor); instrumentation.removeMonitor(centralMonitor) }
        }
    }

    @Test fun pairedLoginIsSharedByCentralPagesAndLogoutStopsAllAccess() {
        val api = CentralClient(origin, owner); val settings = Settings(context)
        val invitation = api.post("/api/connections/invitations", JSONObject().put("serverUrl", origin).put("label", "Generated emulator").put("deviceId", settings.deviceId))
        val response = HttpJson.request("POST", origin + "/api/connections/redeem", JSONObject().put("code", invitation.getJSONObject("invitation").getString("code"))
            .put("deviceId", settings.deviceId).put("deviceName", "Generated emulator").put("platform", "android"), "")
        assertEquals(200, response.first)
        settings.save(settings.read().copy(token = response.second!!.getString("token")), confirmCentralEndpoint = true)
        assertNotNull(CentralAccess.resolve(context).client)
        open().use { scenario ->
            waitFor(scenario, "Paired login opens central pages") { it.client != null }
            assertNotNull(CentralAccess.resolve(context).client)
            scenario.recreate(); waitFor(scenario, "Shared owner restored") { it.client != null }
        }
        CentralSession.get(context).select("")
        settings.save(settings.read().copy(token = owner), confirmCentralEndpoint = true)
        assertNotNull(CentralAccess.resolve(context).client)
        CentralSession.get(context).signOut()
        assertNull(CentralAccess.resolve(context).client)
    }
    @Test fun expiryAndBackgroundRejectionInvalidateEveryFeatureAndFenceOldClients() {
        val settings = Settings(context)
        settings.signIn(origin, owner, 86400000L)
        val old = CentralAccess.requireClient(context)
        settings.save(settings.read().copy(authExpiresAt = 1))
        assertFalse(settings.read().hasSyncConnection())
        assertNull(CentralAccess.resolve(context).client)
        assertThrows(IllegalStateException::class.java) { old.get("/api/status") }
        settings.signIn(origin, owner, 86400000L)
        settings.rejectCredential("https://elsewhere.invalid/api/status", owner)
        assertTrue(settings.read().hasSyncConnection())
        settings.rejectCredential(origin + "/api/status", "generated-wrong-credential")
        assertTrue(settings.read().hasSyncConnection())
        settings.rejectCredential(origin + "/api/status", owner)
        assertTrue(Settings(context).read().authSignedOut)
        assertEquals(owner, settings.read().token)
        assertNull(CentralAccess.resolve(context).client)
        settings.signIn(origin, owner, 86400000L)
        open("ask").use { scenario ->
            waitFor(scenario, "Reauthorization is shared") { it.client != null }
            settings.save(settings.read().copy(authExpiresAt = 1))
            waitFor(scenario, "Foreground expiry clears private pages") { it.client == null && contains(it, "登录并继续") }
        }
    }
    @Test fun retiredOwnerSessionIsPreservedWithoutImportOrFallbackAfterCanonicalLogout() {
        val settings = Settings(context)
        val legacy = java.io.File(context.noBackupFilesDir, "central-owner-session.enc")
        val deadline = System.currentTimeMillis() + 86400000L
        val saved = JSONObject().put("server", origin).put("token", owner).put("expiresAt", deadline)
        val bytes = context.secretBox().seal(saved.toString().toByteArray())
        legacy.writeBytes(bytes)
        try {
            val session = UnifiedCentralSession(context)
            session.select(origin)
            assertArrayEquals(bytes, legacy.readBytes())
            assertTrue(settings.read().connectionToken().isBlank()); assertNull(session.client(origin))
            assertEquals(0L, settings.read().authExpiresAt)
            session.signIn(origin, owner, 86400000L)
            assertEquals(owner, settings.read().connectionToken()); assertNotNull(session.client(origin))
            session.signOut()
            val reopened = UnifiedCentralSession(context); reopened.select(origin)
            assertArrayEquals(bytes, legacy.readBytes())
            assertTrue(settings.read().connectionToken().isBlank()); assertNull(reopened.client(origin))
            assertEquals(owner, settings.read().token)
        } finally { legacy.delete() }
    }
    @Test fun switchingNodeInvalidatesTheClientBeforeAnyNewRequest() {
        val settings = Settings(context); settings.save(settings.read().copy(token = owner), confirmCentralEndpoint = true)
        val old = CentralAccess.requireClient(context)
        settings.save(settings.read().copy(server = "http://127.0.0.1:47884", token = ""), confirmCentralEndpoint = true)
        assertThrows(IllegalStateException::class.java) { old.get("/api/status") }
        assertNull(CentralAccess.resolve(context).client)
    }
    @Test fun generatedCalendarProposalPermissionBoundaryIgnoreAndTodoCompletionHaveNativeVisuals() {
        val host=InstrumentationRegistry.getArguments().getString("nativeCalendarVisualOrigin")
        assumeTrue(host!=null);require(Regex("http://127\\.0\\.0\\.1:[0-9]+").matches(host!!))
        val api=CentralClient(host,"generated-managed-calendar-owner")
        fun fixtureRequest(path:String,body:JSONObject?=null):JSONObject { val (status,value)=HttpJson.request(if(body==null)"GET" else "POST",host+path,body,"generated-managed-calendar-owner");check(status in 200..299 && value!=null);return value }
        val action=fixtureRequest("/fixture/add",JSONObject())
        val settings=Settings(context);settings.save(settings.read().copy(server=host,token="",debugHttp=true,syncMode="manual"),confirmCentralEndpoint=true)
        CentralSession.get(context).select(host);CentralSession.get(context).signIn(host,"generated-managed-calendar-owner")
        fun shown()=android.view.inspector.WindowInspector.getGlobalWindowViews().filter{it.isShown && it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
        fun until(label:String,check:()->Boolean){val end=System.currentTimeMillis()+25000;while(System.currentTimeMillis()<end){var ok=false;instrumentation.runOnMainSync{ok=check()};if(ok)return;Thread.sleep(60)};fail(label)}
        fun click(label:String){until(label){shown().filterIsInstance<TextView>().any{it.isEnabled && it.isClickable && it.text.toString()==label}};instrumentation.runOnMainSync{shown().filterIsInstance<TextView>().first{it.isEnabled && it.isClickable && it.text.toString()==label}.performClick()}}
        fun capture(name:String){val before=MoteAppearance.preference();try{for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){instrumentation.runOnMainSync{MoteAppearance.select(context,theme)};instrumentation.waitForIdleSync();val latch=java.util.concurrent.CountDownLatch(1);instrumentation.runOnMainSync{shown().first().postOnAnimation{shown().first().postOnAnimation{latch.countDown()}}};assertTrue(latch.await(5,java.util.concurrent.TimeUnit.SECONDS));instrumentation.runOnMainSync{val root=android.view.inspector.WindowInspector.getGlobalWindowViews().last{it.isShown && it.hasWindowFocus()};val bitmap=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888);root.draw(android.graphics.Canvas(bitmap));java.io.File(context.filesDir,"calendar-todo-final").apply{mkdirs()}.resolve(name+"-"+theme.value+".png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}}}finally{instrumentation.runOnMainSync{MoteAppearance.select(context,before)}}}
        val permission=context.checkSelfPermission(android.Manifest.permission.WRITE_CALENDAR)
        require(permission!=android.content.pm.PackageManager.PERMISSION_GRANTED)
        ActivityScenario.launch(CalendarActionsActivity::class.java).use {
            until("Real validated generated proposal"){shown().filterIsInstance<TextView>().any{it.text.toString()=="Generated appointment"}};capture("calendar-proposed")
            click("查看原文依据");until("Real original evidence dialog"){shown().filterIsInstance<TextView>().any{it.text.toString().contains("Generated appointment on 18 September 2099.")}};capture("calendar-original");click("关闭")
            click("核对并添加到日历");until("Permission boundary remains actual"){shown().filterIsInstance<TextView>().any{it.text.toString()=="请先连接本机日历"}};capture("calendar-needs-permission")
            assertEquals("proposed",fixtureRequest("/fixture/action/"+action.getString("id")).getString("status"));click("忽略这条建议")
            until("Actual ignored receipt"){shown().filterIsInstance<TextView>().any{it.text.toString().startsWith("已忽略")} && shown().filterIsInstance<TextView>().none{it.text.toString()=="忽略这条建议"}};capture("calendar-dismissed")
            assertEquals("dismissed",fixtureRequest("/fixture/action/"+action.getString("id")).getString("status"))
        }
        val title="Generated native Todo "+java.util.UUID.randomUUID()
        open("actions").use { scenario ->
            waitFor(scenario,"Actual Todo page"){a->!a.isWorking && contains(a,"待办标题")}
            scenario.onActivity { a->all(a).filterIsInstance<EditText>().single{it.contentDescription=="待办标题"}.setText(title) };click("添加待办")
            waitFor(scenario,"Actual created Todo"){a->!a.isWorking && contains(a,title)};capture("todo-open");click("标记完成")
            waitFor(scenario,"Actual completed Todo"){a->!a.isWorking && contains(a,title) && contains(a,"已完成")};capture("todo-completed")
            val todos=api.get("/api/todos?limit=30").getJSONArray("items");assertEquals("completed",(0 until todos.length()).map{todos.getJSONObject(it)}.single{it.getString("title")==title}.getString("status"))
        }
        assertEquals(permission,context.checkSelfPermission(android.Manifest.permission.WRITE_CALENDAR))
    }

}
