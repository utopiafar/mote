package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutManager
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.Lifecycle
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.mote.collector.plugins.DailyHomePlugin
import dev.mote.collector.plugins.NativeAskPlugin
import dev.mote.collector.plugins.NativeRecordReceipt
import dev.mote.collector.plugins.SystemEntriesPlugin
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

private const val STAGE_CONVERSATION = "5b0f6c1e-3d0a-4f4c-9a51-2f7f3a1d8c42"

/**
 * Plugin-stage acceptance (lock E) on the dedicated emulator. It is deliberately
 * not a broad UI suite: it proves the plugin-owned home, system entries, Ask and
 * secondary routes stay reachable; Activity recreation keeps the durable owner
 * and the Ask draft without sending or reading a hidden page; and a denied
 * capture permission never renders a fake success or performs an off-page read.
 * All Central data comes from a generated loopback fixture; nothing reads a
 * personal screen, account or model.
 */
@RunWith(AndroidJUnit4::class)
class PluginStageInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val app get() = context.applicationContext as MoteApplication
    private val host get() = app.pluginHost

    private var armed = false
    private var savedMotePrefs: Map<String, Any?> = emptyMap()
    private var savedAppearance = "auto"
    private var savedLanguage = "system"
    private var savedReceipt: String? = null
    private var savedReceiptFromFirstUse = false

    // A default UiAutomation connection suppresses other accessibility services.
    private val automation get() = instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)

    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun shown(activity: Activity): List<View> = views(activity.window.decorView).filter { it.isShown }
    private fun texts(activity: Activity): List<String> = shown(activity).filterIsInstance<TextView>().map { it.text.toString() }
    private fun tags(activity: Activity): List<String> = shown(activity).mapNotNull { it.tag?.toString() }

    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }

    private fun inStage(vararg stages: Stage): List<Activity> {
        val found = mutableListOf<Activity>()
        instrumentation.runOnMainSync { stages.forEach { found += ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) } }
        return found
    }

    private fun until(description: String, timeout: Long = 20_000, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < end) {
            if (runCatching(check).getOrDefault(false)) return
            Thread.sleep(50)
        }
        val top = inStage(Stage.RESUMED).firstOrNull()
        val labels = top?.let { activity -> main { texts(activity).joinToString(" | ") } }
        fail("$description — $labels")
    }

    private fun onTop(description: String, check: (Activity) -> Boolean): Activity {
        var found: Activity? = null
        until(description) {
            val activity = inStage(Stage.RESUMED).firstOrNull() ?: return@until false
            val ok = main { check(activity) }
            if (ok) found = activity
            ok
        }
        return requireNotNull(found)
    }

    private fun click(activity: Activity, predicate: (View) -> Boolean) {
        until("a visible click target") { main { shown(activity).any { it.isEnabled && predicate(it) } } }
        main { shown(activity).first { it.isEnabled && predicate(it) }.performClick() }
    }

    /** Dialog buttons live in a second window; the preview and permission repair use them. */
    private fun clickWindowText(label: String) {
        val end = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < end) {
            var clicked = false
            main {
                val view = WindowInspector.getGlobalWindowViews().asSequence()
                    .flatMap { views(it).asSequence() }
                    .filter { it.isShown }
                    .firstOrNull { (it is TextView && it.text.toString() == label) || it.contentDescription?.toString() == label }
                clicked = view?.performClick() == true
            }
            if (clicked) return
            Thread.sleep(50)
        }
        fail("Window label is not clickable: $label")
    }

    private fun clickText(activity: Activity, label: String) =
        click(activity) { it is TextView && it.text.toString() == label }

    private fun grantNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            automation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        until("the dedicated emulator permits the plugin's status notification") { manager.areNotificationsEnabled() }
    }

    private fun waitForLocalStorage() {
        val end = SystemClock.elapsedRealtime() + 20_000
        while (QueueStorage.recovering && SystemClock.elapsedRealtime() < end) Thread.sleep(50)
        assertFalse("local storage startup recovery must finish", QueueStorage.recovering)
    }

    /** The stage gate only mutates a profile that could not contain owned data. */
    private fun requireGeneratedProfile() {
        val natives = File(context.noBackupFilesDir, "central-native")
        require(!natives.exists() || (natives.isDirectory && natives.listFiles()?.isEmpty() == true)) {
            "generated fixture needs a profile without prior central-native state"
        }
        val settings = Settings(context)
        val config = settings.read()
        require(config.token.isEmpty() && config.server in setOf("", BuildConfig.DEFAULT_SERVER)) {
            "generated fixture needs an unconfigured profile"
        }
        require(!settings.enabled && settings.lastCapture() == null) {
            "generated fixture needs a task-owned profile: capture must not be enabled or have captured"
        }
        require(!settings.hasPendingData()) { "generated fixture needs a profile without pending records, drafts or uploads" }
        require(context.queue().inventory().records == 0) { "generated fixture needs a profile without stored records" }
        require(context.localSources().sources().isEmpty()) { "generated fixture needs a profile without synced local sources" }
        require(!CaptureAccessibilityService.connected && !ProjectionService.running) {
            "generated fixture needs no connected capture session"
        }
    }

    private fun saveProfile() {
        savedMotePrefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
        savedAppearance = context.getSharedPreferences("mote.appearance", Context.MODE_PRIVATE).getString("appearance", "auto") ?: "auto"
        savedLanguage = MoteI18n.preference()
        savedReceipt = NativeRecordReceipt.recordId
        savedReceiptFromFirstUse = NativeRecordReceipt.fromFirstUse
    }

    private fun restoreProfile() {
        val prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
        val edit = prefs.edit()
        prefs.all.keys.forEach { if (it !in savedMotePrefs) edit.remove(it) }
        savedMotePrefs.forEach { (key, value) ->
            when (value) {
                is String -> edit.putString(key, value)
                is Int -> edit.putInt(key, value)
                is Long -> edit.putLong(key, value)
                is Boolean -> edit.putBoolean(key, value)
                is Float -> edit.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") edit.putStringSet(key, value as Set<String>)
            }
        }
        check(edit.commit())
        MoteI18n.select(context, savedLanguage)
        MoteAppearance.select(context, AppearancePreference.parse(savedAppearance))
        NativeRecordReceipt.recordId = savedReceipt
        NativeRecordReceipt.fromFirstUse = savedReceiptFromFirstUse
        // The preflight proved the directory was absent; anything now present is this run's.
        File(context.noBackupFilesDir, "central-native").deleteRecursively()
    }

    private fun reset() {
        val settings = Settings(context)
        settings.enabled = false
        settings.save(
            settings.read().copy(
                server = "", token = "", debugHttp = false, screenCollectionEnabled = true,
                notificationCollectionEnabled = false, deviceEventCollectionEnabled = false,
                mediaCollectionEnabled = false, mode = "accessibility", syncMode = "manual",
                syncPaused = false, authSignedOut = false, authExpiresAt = 0, authProcess = "",
            ),
            confirmCentralEndpoint = true,
        )
        settings.screenPaused(null)
        settings.status("paused", "生成的初始状态")
        context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().remove("capturePreviewSeen").remove("lastCapture").commit()
        NativeRecordReceipt.recordId = null
        NativeRecordReceipt.fromFirstUse = false
    }

    private fun connect(fixture: PluginStageFixture) {
        val settings = Settings(context)
        settings.save(
            settings.read().copy(
                server = fixture.origin,
                token = "generated-plugin-stage-owner-token-1234567890",
                debugHttp = true,
                syncMode = "manual",
                syncPaused = true,
                wifiOnly = false,
                authSignedOut = false,
                authExpiresAt = 0,
                authProcess = "",
            ),
            confirmCentralEndpoint = true,
        )
        File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)).deleteRecursively()
    }

    /** Lets reads already started before navigation reach the fixture, so a later count is the hidden-page work. */
    private fun awaitHomeReadsSettled(fixture: PluginStageFixture) {
        var last = -1
        var stable = 0
        val end = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < end) {
            val count = fixture.homeReads()
            if (count == last) stable++ else { last = count; stable = 0 }
            if (stable >= 4) return
            Thread.sleep(150)
        }
    }

    private fun askState(fixture: PluginStageFixture): JSONObject = CentralDraftWrites.barrier {
        CentralStateFile(
            File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)),
            "ask",
            context.secretBox(),
        ).read()
    }

    private fun awaitAskPage(): Activity = onTop("the Ask page is ready") { activity ->
        tags(activity).contains("central-title") && texts(activity).contains(MoteI18n.text("问一问"))
    }

    private fun awaitAskComposer(): Activity = onTop("the Ask page and its composer are ready") { activity ->
        tags(activity).contains("central-title") &&
            texts(activity).contains(MoteI18n.text("问一问")) &&
            shown(activity).filterIsInstance<EditText>().any { it.contentDescription == MoteI18n.text("你的问题") && it.isEnabled }
    }

    private fun noFakeCaptureSuccess(activity: Activity) {
        val visible = main { texts(activity) }
        assertFalse("a denied capture must not claim it is running", visible.contains(MoteI18n.text("正在本机采集")) || visible.contains(MoteI18n.text("采集中")))
        assertTrue(
            "a denied accessibility permission stays on its honest repair page",
            main { tags(activity) }.contains("local-back:PERMISSIONS") || visible.contains(MoteI18n.text("系统权限与后台运行")),
        )
        assertTrue(
            "the permission page names the missing accessibility service",
            visible.any { it.contains(MoteI18n.text("无障碍截图")) },
        )
    }

    @Before fun generatedOnly() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("pluginStageFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev") { "Run only in the isolated development package" }
        require(Build.FINGERPRINT.contains("emu64a")) { "Run only on a task-owned emulator" }
        require(Build.VERSION.SDK_INT >= 30) { "The plugin stage needs Android 11+ for the accessibility denial path" }
        waitForLocalStorage()
        requireGeneratedProfile()
        saveProfile()
        armed = true
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        reset()
    }

    /** A skipped run never touched the profile; a real run restores its exact preferences. */
    @After fun restore() {
        if (!armed) return
        armed = false
        val open = inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)
        instrumentation.runOnMainSync { open.forEach { it.finish() } }
        runCatching { context.systemEntries().clear() }
        restoreProfile()
    }

    @Test fun homeSystemEntriesAskAndSecondaryPagesRemainReachable() {
        val entriesScope = requireNotNull(host.scope(SystemEntriesPlugin.INSTANCE_ID))
        assertTrue("the system entries provider is active in the real app", SystemEntriesPlugin.availability(context).active)
        grantNotifications()

        val scenario = ActivityScenario.launch(MainActivity::class.java).awaitMainUi()
        try {
            val home = onTop("the plugin-owned home mounts Ask and the quick records") { activity ->
                val mounted = tags(activity)
                listOf("home-ask-action", "home-record-action", "home-photo-action", "home-audio-action").all { it in mounted }
            }
            assertTrue("the home owner is live", DailyHomePlugin.owner(context).active)
            val homeScope = requireNotNull(host.scope(DailyHomePlugin.INSTANCE_ID))
            assertSame("home keeps one durable owner scope", homeScope, host.scope(DailyHomePlugin.INSTANCE_ID))
            assertSame("system entries keep one durable owner scope", entriesScope, host.scope(SystemEntriesPlugin.INSTANCE_ID))

            // The widget, launcher shortcuts and notification actions share the plugin's definitions.
            main {
                val widget = QuickEntryWidget.views(context).apply(context, FrameLayout(context))
                assertEquals(MoteI18n.text("问一问…"), widget.findViewById<TextView>(R.id.widget_ask).text.toString())
                assertEquals(
                    listOf("记录", "拍照", "录音"),
                    listOf(R.id.widget_record, R.id.widget_photo, R.id.widget_audio).map { widget.findViewById<View>(it).contentDescription.toString() },
                )
            }
            main { MoteShortcuts.publish(context) }
            val shortcuts = main {
                requireNotNull(context.getSystemService(ShortcutManager::class.java)).dynamicShortcuts.map { it.id }.toSet()
            }
            assertEquals(setOf("record", "photo", "audio", "ask"), shortcuts)

            val manager = context.getSystemService(NotificationManager::class.java)
            context.systemEntries().show("生成的插件阶段采集状态")
            until("the plugin publishes its capture notification actions") {
                manager.activeNotifications.firstOrNull { it.id == Notifications.ID }?.notification?.actions
                    ?.map { it.title.toString() } == listOf(MoteI18n.text("记录"), MoteI18n.text("暂停屏幕采集"), MoteI18n.text("停止采集"))
            }
            context.systemEntries().clear()
            until("clearing the plugin notification leaves no stale action") {
                manager.activeNotifications.none { it.id == Notifications.ID }
            }

            // A real launcher/quick-entry intent enters the app and reaches Ask without destroying its home.
            context.startActivity(MoteQuickEntry.ASK.intent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val ask = awaitAskPage()
            assertNotEquals("the system entry does not destroy the existing home", Lifecycle.State.DESTROYED, scenario.state)
            assertTrue(
                "without Central, Ask states the real limitation instead of faking an answer",
                main { texts(ask) }.any { it.contains(MoteI18n.text("中央问答暂不可用")) },
            )
            assertFalse("an unsent Ask is not a local save", main { texts(ask) }.any { it.contains(MoteI18n.text("本机已保存")) })
            click(ask) { it.contentDescription == MoteI18n.text("返回上级") }
            onTop("Ask back returns to the same home task") { activity ->
                activity is MainActivity && tags(activity).contains("home-ask-action")
            }

            // Recreation recreates only the mounted views; the durable plugin owners remain.
            main { ask.recreate() }
            val recreated = onTop("the home remounts after Activity recreation") { activity ->
                activity !== ask && activity is MainActivity &&
                    tags(activity).contains("home-ask-action") && tags(activity).contains("home-record-action")
            }
            assertSame("recreation keeps the same home scope", homeScope, host.scope(DailyHomePlugin.INSTANCE_ID))
            assertSame("recreation keeps the same system-entry scope", entriesScope, host.scope(SystemEntriesPlugin.INSTANCE_ID))
            assertEquals("recreation does not create a record", 0, context.queue().depth())
            assertFalse("recreation does not invent a saved receipt", main { texts(recreated) }.any { it.contains(MoteI18n.text("本机已保存")) })

            // The real secondary menu reaches settings, the library and source management.
            main { recreated.openGeneratedMenu() }
            val manage = onTop("the management page is reachable from the home") { activity ->
                tags(activity).contains("menu:" + MoteI18n.text("资料与记忆")) && tags(activity).contains("menu:" + MoteI18n.text("设置"))
            }
            click(manage) { it.tag == "menu:" + MoteI18n.text("设置") }
            val settingsPage = onTop("settings is reachable") { activity -> tags(activity).contains("local-back:SETTINGS") }
            assertTrue("settings keeps its own title", main { texts(settingsPage) }.contains(MoteI18n.text("设置")))
            click(settingsPage) { it.tag == "local-back:SETTINGS" }
            val manageAgain = onTop("settings returns to management") { activity ->
                tags(activity).contains("menu:" + MoteI18n.text("资料与记忆"))
            }
            click(manageAgain) { it.tag == "menu:" + MoteI18n.text("资料与记忆") }
            val library = onTop("the library is reachable") { activity -> tags(activity).contains("local-back:LIBRARY") }
            assertTrue("the library keeps its own title", main { texts(library) }.contains(MoteI18n.text("资料与记忆")))
            click(library) { it.tag == "local-back:LIBRARY" }
            val manageForSources = onTop("the library returns to management") { activity ->
                tags(activity).contains("menu:" + MoteI18n.text("采集与同步"))
            }
            click(manageForSources) { it.tag == "menu:" + MoteI18n.text("采集与同步") }
            val sources = onTop("source management is reachable") { it is SourcesActivity }
            instrumentation.runOnMainSync { sources.finish() }
            onTop("source management returns to the existing task") { activity ->
                activity is MainActivity && tags(activity).contains("menu:" + MoteI18n.text("采集与同步"))
            }
            android.util.Log.i("MoteAcceptance", "plugin stage: home, system entries, Ask, settings, library and sources reachable; recreate kept durable owners")
        } finally {
            val open = inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)
            main { open.forEach { it.finish() } }
            until("the plugin stage activities finish") { inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).isEmpty() }
        }
    }

    @Test fun askDraftSurvivesRecreationWithoutSendingOrHiddenHomeReads() {
        PluginStageFixture().use { fixture ->
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                onTop("the home reads the generated conversation") { activity ->
                    tags(activity).contains("home-conversation:" + STAGE_CONVERSATION)
                }
                assertTrue("the home read came from the generated Central", fixture.requests.any { it.method == "GET" && it.path == "/api/conversations?limit=5" })
                until("the plugin-owned home reads its three visible sections") {
                    fixture.requests.any { it.path.startsWith("/api/conversations?limit=5") } &&
                        fixture.requests.any { it.path.startsWith("/api/actions?") } &&
                        fixture.requests.any { it.path.startsWith("/api/insights?") }
                }
                awaitHomeReadsSettled(fixture)

                val home = onTop("the home Ask action is mounted") { activity -> tags(activity).contains("home-ask-action") }
                click(home) { it.tag == "home-ask-action" }
                var ask = awaitAskComposer()
                val question = "生成的插件阶段草稿；未发送。"
                main { shown(ask).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text("你的问题") }.setText(question) }
                until("the Ask plugin persists its private draft") { askState(fixture).optString("question") == question }
                assertEquals("typing never submits a question", 0, fixture.queryPosts.get())

                val homeScope = requireNotNull(host.scope(DailyHomePlugin.INSTANCE_ID))
                val askScope = requireNotNull(host.scope(NativeAskPlugin.INSTANCE_ID))
                val hiddenReadBaseline = fixture.homeReads()

                scenario.recreate()
                ask = awaitAskComposer()
                main {
                    assertEquals(
                        "the plugin-owned draft survives Activity recreation",
                        question,
                        shown(ask).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text("你的问题") }.text.toString(),
                    )
                }
                val state = askState(fixture)
                assertEquals(question, state.optString("question"))
                assertFalse("recreation never invents a run ticket", state.has("runId") || state.has("pending"))
                assertEquals("recreation never sends the draft", 0, fixture.queryPosts.get())
                assertSame("the home owner survives recreation", homeScope, host.scope(DailyHomePlugin.INSTANCE_ID))
                assertSame("the Ask owner survives recreation", askScope, host.scope(NativeAskPlugin.INSTANCE_ID))
                assertFalse(askScope.revoked)

                Thread.sleep(2_500)
                assertEquals("an off-home Ask performs no hidden home read", hiddenReadBaseline, fixture.homeReads())
                assertFalse("an unsent Ask is not shown as a local save", main { texts(ask) }.any { it.contains(MoteI18n.text("本机已保存")) })
                android.util.Log.i("MoteAcceptance", "plugin stage: Ask draft survived recreation, no send, no hidden home read (home=$hiddenReadBaseline)")
            }
        }
    }

    @Test fun deniedCapturePermissionNeverFakesSuccessOrReadsHiddenPages() {
        grantNotifications()
        PluginStageFixture().use { fixture ->
            connect(fixture)
            val settings = Settings(context)
            settings.save(
                settings.read().copy(
                    screenCollectionEnabled = true,
                    notificationCollectionEnabled = false,
                    deviceEventCollectionEnabled = false,
                    mediaCollectionEnabled = false,
                    mode = "accessibility",
                ),
                confirmCentralEndpoint = true,
            )
            settings.enabled = false

            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SOURCES")).awaitMainUi().use { scenario ->
                val sourcesPage = onTop("the source page with capture controls is reachable") { activity ->
                    tags(activity).contains("local-back:SOURCES")
                }
                assertEquals("a hidden home performs no read", 0, fixture.homeReads())
                clickText(sourcesPage, MoteI18n.text("查看状态与操作"))
                until("the capture status details expand") {
                    main { shown(sourcesPage).any { it is Button && it.isEnabled && it.text.toString() == MoteI18n.text("开始采集") } }
                }
                clickText(sourcesPage, MoteI18n.text("开始采集"))
                clickWindowText(MoteI18n.text("按此范围开始"))

                val permissions = onTop("missing accessibility opens the permission page") { activity ->
                    tags(activity).contains("local-back:PERMISSIONS")
                }
                assertFalse("a denied permission never enables capture", settings.enabled)
                assertNotEquals("a denied permission never reports capturing", "capturing", settings.state())
                assertEquals("a denied permission never queues a record", 0, context.queue().depth())
                assertTrue(
                    "a denied permission publishes no capture notification",
                    context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.id == Notifications.ID },
                )
                noFakeCaptureSuccess(permissions)
                val hiddenReadBaseline = fixture.homeReads()

                scenario.recreate()
                val recreated = onTop("the honest permission page survives recreation") { activity ->
                    tags(activity).contains("local-back:PERMISSIONS")
                }
                assertFalse("recreation never enables a denied capture", settings.enabled)
                assertNotEquals("recreation never reports capturing", "capturing", settings.state())
                assertEquals("recreation never queues a record", 0, context.queue().depth())
                assertTrue(
                    "recreation publishes no capture notification",
                    context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.id == Notifications.ID },
                )
                noFakeCaptureSuccess(recreated)
                assertFalse("the accessibility service really is not connected", CaptureAccessibilityService.connected)

                Thread.sleep(2_500)
                assertEquals("a denied permission page performs no hidden home read", hiddenReadBaseline, fixture.homeReads())
                android.util.Log.i("MoteAcceptance", "plugin stage: denied capture stayed paused on the permission page across recreation; no notification, record or hidden read (home=$hiddenReadBaseline)")
            }
        }
    }

    private data class StageRequest(val method: String, val path: String)

    /** Generated loopback Central: only the responses the plugin-owned pages read. */
    private inner class PluginStageFixture : AutoCloseable {
        private val listener = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${listener.localPort}"
        val requests = ConcurrentLinkedQueue<StageRequest>()
        val queryPosts = AtomicInteger()
        private val executor = Executors.newCachedThreadPool()

        init {
            executor.submit {
                while (!listener.isClosed) {
                    runCatching { listener.accept() }.getOrNull()?.let { socket -> executor.submit { runCatching { serve(socket) } } }
                }
            }
        }

        fun homeReads(): Int = requests.count { request ->
            request.method == "GET" && (
                request.path.startsWith("/api/conversations?limit=5") ||
                    request.path == "/api/actions" || request.path.startsWith("/api/actions?") ||
                    request.path == "/api/insights" || request.path.startsWith("/api/insights?")
                )
        }

        private fun response(method: String, path: String): JSONObject = when {
            method == "POST" && path == "/api/query-runs" -> JSONObject().put("id", "generated-plugin-stage-run")
            path.startsWith("/api/conversations?limit=5") -> JSONObject().put("items", JSONArray().put(
                JSONObject()
                    .put("id", STAGE_CONVERSATION)
                    .put("title", "生成的插件阶段对话")
                    .put("updatedAt", "2026-11-04T06:00:00Z")
                    .put("turnCount", 1),
            ))
            path.startsWith("/api/conversations?") -> JSONObject().put("items", JSONArray()).put("nextCursor", JSONObject.NULL)
            path == "/api/actions" || path.startsWith("/api/actions?") -> JSONObject().put("items", JSONArray()).put("targets", JSONArray()).put("nextCursor", JSONObject.NULL)
            path == "/api/insights" || path.startsWith("/api/insights?") -> JSONObject().put("items", JSONArray())
            path == "/api/status" -> JSONObject().put("storage", JSONObject().put("captures", 1))
            path.startsWith("/api/library/catalog") || path.startsWith("/api/files") -> JSONObject().put("items", JSONArray())
            path.startsWith("/api/model-settings") -> JSONObject().put("profiles", JSONArray())
            path == "/api/query-runs" -> JSONObject().put("items", JSONArray())
            else -> JSONObject().put("items", JSONArray())
        }

        private fun serve(socket: Socket) {
            socket.use {
                socket.soTimeout = 10_000
                val input = socket.getInputStream().bufferedReader()
                val request = input.readLine().orEmpty().split(' ')
                val method = request.getOrElse(0) { "" }
                val path = request.getOrElse(1) { "" }
                var contentLength = 0
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = line.substringAfter(':').trim().toIntOrNull() ?: 0
                    }
                }
                repeat(contentLength) { input.read() }
                requests.add(StageRequest(method, path))
                if (method == "POST" && path == "/api/query-runs") queryPosts.incrementAndGet()
                val body = response(method, path).toString().toByteArray()
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(body)
                    flush()
                }
            }
        }

        override fun close() {
            listener.close()
            executor.shutdownNow()
        }
    }
}
