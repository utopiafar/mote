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
                    assertEquals(listOf("今天", "资料库", "问一问", "本机"), tabs.map { it.text.toString() })
                    assertTrue("$page keeps its primary destination", tabs.single { it.tag == "primary:${MoteNavigation.centralTab(page).name}" }.isSelected)
                    assertFalse("$page embeds a WebView", all(activity).any { it is WebView })
                    assertFalse("$page requested another token", contains(activity, "登录并继续"))
                    assertEquals("$page API error", "", all(activity).filterIsInstance<TextView>().first { it.tag == "central-status" }.text.toString())
                }
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
        CentralClient(origin, owner).post("/api/notes", JSONObject().put("id", java.util.UUID.randomUUID().toString())
            .put("deviceId", "generated-fixture-phone").put("deviceName", "Generated phone").put("platform", "android")
            .put("capturedAt", java.time.Instant.now().toString()).put("text", "Generated native note <script>untrusted evidence</script>"))
        open("archive").use { scenario ->
            login(scenario); waitFor(scenario, "Archive ready") { !it.isWorking && contains(it, "查看原文") }
            click(scenario, "查看原文")
            waitFor(scenario, "Literal generated evidence") { !it.isWorking && contains(it, "<script>untrusted evidence</script>") }
            scenario.onActivity { it.navigate("archive") }; waitFor(scenario, "Archive ready") { !it.isWorking }
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
    @Test fun queryAndDraftSurviveNavigationAndActivityRecreation() {
        open("ask").use { scenario ->
            login(scenario); waitFor(scenario, "Ask ready") { !it.isWorking && contains(it, "你的问题") }
            scenario.onActivity { activity -> all(activity).filterIsInstance<EditText>().first { it.contentDescription == "你的问题" }.setText("Generated native question 中文 🐾") }
            click(scenario, "发送")
            Thread.sleep(200)
            scenario.onActivity { it.navigate("archive") }; scenario.recreate()
            waitFor(scenario, "Archive restored") { it.client != null && contains(it, "搜索原文") }
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

    @Test fun querySurvivesReturningToLocalPrimaryNavigation() {
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
            val askMonitor = instrumentation.addMonitor(AskActivity::class.java.name, null, true)
            val centralMonitor = instrumentation.addMonitor(CentralActivity::class.java.name, null, true)
            try {
                click("问一问")
                await("Native login") { visible(it).any { view -> view.contentDescription == "中央管理令牌" } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "中央管理令牌" }.setText(owner) }
                click("登录并继续")
                await("Ask ready") { visible(it).any { view -> view.contentDescription == "你的问题" && view.isEnabled } }
                click("新对话")
                await("New conversation ready") { visible(it).any { view -> view.contentDescription == "你的问题" && view.isEnabled } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated primary navigation question") }
                click("发送")
                click("本机"); click("今天"); click("问一问")
                await("Accepted answer survives primary navigation") { visible(it).filterIsInstance<TextView>().any { view -> view.text.contains("Generated native answer") } }
                scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated unsent draft") }
                click("资料库"); click("问一问")
                Thread.sleep(2000) // Allow the return-to-tab poll timer to run before checking the next draft.
                scenario.onActivity { activity -> assertEquals("Generated unsent draft", visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.text.toString()) }
                click("记录")
                scenario.onActivity { activity -> assertTrue(visible(activity).filterIsInstance<EditText>().any { it.hint.toString() == "记下此刻的想法…" }) }
                click("问一问")
                scenario.recreate(); scenario.awaitMainUi()
                await("Ask draft survives host recreation") { visible(it).filterIsInstance<EditText>().any { view -> view.contentDescription == "你的问题" && view.isEnabled && view.text.toString() == "Generated unsent draft" } }
                scenario.onActivity { activity ->
                    assertTrue(visible(activity).filterIsInstance<TextView>().any { it.text.contains("Generated native answer") })
                    assertEquals(1, visible(activity).filterIsInstance<MotePrimaryNavigation>().size)
                    assertTrue(visible(activity).single { it.tag == "primary:ASK" }.isSelected)
                    assertFalse(Settings(activity).enabled)
                    val question = visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }
                    assertTrue(question.requestFocus())
                    activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(question, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                }
                await("Ask keyboard opens") { it.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }
                scenario.onActivity { activity ->
                    val root = activity.window.decorView
                    val keyboard = root.rootWindowInsets.getInsets(android.view.WindowInsets.Type.ime())
                    for (item in visible(activity).filter { it.tag?.toString()?.startsWith("primary:") == true }) {
                        val bounds = android.graphics.Rect(); assertTrue(item.getGlobalVisibleRect(bounds))
                        assertTrue("Primary navigation remains above the Ask keyboard", bounds.bottom <= root.height - keyboard.bottom + 2)
                    }
                    // Draw only this opt-in fixture app's generated views.
                    val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
                    root.draw(android.graphics.Canvas(bitmap))
                    java.io.File(context.cacheDir, "native-fixture-ask-tab-keyboard.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    activity.onBackPressed()
                    assertTrue(visible(activity).single { it.tag == "primary:TODAY" }.isSelected)
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
    @Test fun migratesLegacyOwnerSessionOnceWithoutFallbackAfterCanonicalLogout() {
        val settings = Settings(context)
        val legacy = java.io.File(context.noBackupFilesDir, "central-owner-session.enc")
        val deadline = System.currentTimeMillis() + 86400000L
        val saved = JSONObject().put("server", origin).put("token", owner).put("expiresAt", deadline)
        legacy.writeBytes(SecretBox().seal(saved.toString().toByteArray()))
        UnifiedCentralSession(context)
        assertFalse(legacy.exists())
        assertEquals(owner, settings.read().connectionToken())
        assertEquals(deadline, settings.read().authExpiresAt)
        settings.signOut()
        legacy.writeBytes(SecretBox().seal(saved.toString().toByteArray()))
        UnifiedCentralSession(context)
        assertFalse(legacy.exists())
        assertTrue(settings.read().connectionToken().isBlank())
        assertEquals(owner, settings.read().token)
    }
    @Test fun switchingNodeInvalidatesTheClientBeforeAnyNewRequest() {
        val settings = Settings(context); settings.save(settings.read().copy(token = owner), confirmCentralEndpoint = true)
        val old = CentralAccess.requireClient(context)
        settings.save(settings.read().copy(server = "http://127.0.0.1:47884", token = ""), confirmCentralEndpoint = true)
        assertThrows(IllegalStateException::class.java) { old.get("/api/status") }
        assertNull(CentralAccess.resolve(context).client)
    }
}
