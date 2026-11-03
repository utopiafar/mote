package dev.mote.collector

import dev.mote.collector.plugins.NativeRecordReceipt
import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The journey-based home and its system entries on a task-owned emulator. Data comes only from a generated
 * loopback Central; no capture service, personal screen, account or model is used.
 */
@RunWith(AndroidJUnit4::class)
class HomeJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    // A default UiAutomation connection suppresses other accessibility services, including the capture service.
    private val automation get() = instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
    private val conversation = "5b0f6c1e-3d0a-4f4c-9a51-2f7f3a1d8c42"
    private val action = "8a6b2f0e-1c4d-4e7a-b2d3-6f5e4c3b2a19"
    private val settled = "3f9d2c4b-7a1e-4b6f-8c5d-0e2a9b7c6d15"
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun texts(activity: Activity) = shown(activity).filterIsInstance<TextView>().map { it.text.toString() }
    private fun inStage(vararg stages: Stage): List<Activity> {
        val found = mutableListOf<Activity>()
        instrumentation.runOnMainSync { stages.forEach { found += ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) } }
        return found
    }
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(100) }
        val labels = inStage(Stage.RESUMED).firstOrNull()?.let { top -> var value = ""; instrumentation.runOnMainSync { value = top.javaClass.simpleName + ": " + texts(top).joinToString(" | ") }; value }
        fail("$description — $labels")
    }
    private fun <T : Activity> resumed(type: Class<T>, description: String): T {
        until(description) { inStage(Stage.RESUMED).any(type::isInstance) }
        return type.cast(inStage(Stage.RESUMED).first(type::isInstance))!!
    }
    private fun onTop(description: String, check: (Activity) -> Boolean): Activity {
        var top: Activity? = null
        until(description) { inStage(Stage.RESUMED).firstOrNull()?.let { activity -> var ok = false; instrumentation.runOnMainSync { ok = check(activity) }; if (ok) top = activity; ok } ?: false }
        return top!!
    }
    private fun click(activity: Activity, find: (View) -> Boolean) = instrumentation.runOnMainSync { shown(activity).first(find).performClick() }
    private fun capture(activity: Activity, name: String) {
        instrumentation.waitForIdleSync()
        val drawn = CountDownLatch(1)
        instrumentation.runOnMainSync { activity.window.decorView.postOnAnimation { activity.window.decorView.postOnAnimation { drawn.countDown() } } }
        assertTrue(drawn.await(5, TimeUnit.SECONDS))
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            root.draw(Canvas(bitmap))
            File(context.filesDir, "journey-home").apply { mkdirs() }.resolve("$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    private fun connect(fixture: Fixture) {
        val settings = Settings(context)
        settings.save(settings.read().copy(server = fixture.origin, token = "generated-journey-owner-token-1234567890", debugHttp = true, syncMode = "manual", syncPaused = true, authSignedOut = false), confirmCentralEndpoint = true)
        File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(fixture.origin)).deleteRecursively()
    }
    private fun reset() {
        val settings = Settings(context)
        settings.enabled = false
        settings.save(settings.read().copy(server = "", token = "", debugHttp = false, screenCollectionEnabled = true, notificationCollectionEnabled = false, syncPaused = false))
        settings.screenPaused(null); settings.status("paused", "生成的初始状态")
        context.getSharedPreferences("mote", Context.MODE_PRIVATE).edit().remove("capturePreviewSeen").remove("lastCapture").commit()
        NativeRecordReceipt.recordId = null
    }

    @Before fun generatedOnly() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("journeyHomeFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a")) { "Run only on a task-owned emulator" }
        MoteI18n.select(context, "zh-CN")
        MoteAppearance.select(context, AppearancePreference.LIGHT)
        reset()
    }
    @After fun restore() { reset(); MoteAppearance.select(context, AppearancePreference.LIGHT) }

    @Test fun regularHomeLooksAtTheTopAndActsAtTheBottom() {
        Fixture().use { fixture ->
            connect(fixture)
            for (appearance in listOf(AppearancePreference.LIGHT, AppearancePreference.DARK)) {
                MoteAppearance.select(context, appearance)
                ActivityScenario.launch(MainActivity::class.java).use {
                    val home = onTop("Recent conversation and the waiting calendar item come from the generated Central") { activity ->
                        shown(activity).any { it.tag == "home-conversation:$conversation" } && shown(activity).any { it.tag == "home-calendar-need:$action" }
                    }
                    instrumentation.runOnMainSync {
                        val tags = shown(home).mapNotNull { it.tag?.toString() }
                        for (tag in listOf("home-ask-action", "home-record-action", "home-photo-action", "home-audio-action", "home-search-action")) assertTrue(tag, tag in tags)
                        assertTrue("Capture that was never started stays off the home", tags.none { it in setOf("home-capture-state", "home-capture-paused", "home-attention") })
                        assertFalse("The large prompt only belongs to first use", "想问什么？" in texts(home))
                        assertTrue("等你补充" in texts(home) && "时间待补充" in texts(home) && "生成的设计评审" in texts(home))
                        val ask = IntArray(2).also { shown(home).first { it.tag == "home-ask-action" }.getLocationOnScreen(it) }
                        val record = IntArray(2).also { shown(home).first { it.tag == "home-record-action" }.getLocationOnScreen(it) }
                        assertTrue("Ask sits above the quick records in the thumb zone", ask[1] < record[1])
                    }
                    capture(home, "home-regular-" + appearance.name.lowercase())
                    if (appearance == AppearancePreference.LIGHT) {
                        click(home) { it is Button && it.text == "补充时间" }
                        val calendar = resumed(CalendarActionsActivity::class.java, "Completing a time opens the existing calendar page")
                        instrumentation.runOnMainSync { calendar.finish() }
                        val back = resumed(MainActivity::class.java, "Calendar returns to the home")
                        click(back) { it.contentDescription == "打开菜单" }
                        onTop("Memories are one step from the menu") { activity -> shown(activity).any { it.tag == "menu:我的记忆" } && shown(activity).any { it.tag == "menu:资料与记忆" } }
                    }
                }
            }
        }
    }

    @Test fun captureLineSeparatesAPauseFromAnInterruption() {
        val settings = Settings(context)
        settings.capturePreviewAccepted()
        // MainActivity replaces its intent on onNewIntent; ActivityScenario then loses it, so this journey owns the activity.
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        try {
            val paused = onTop("An intentional stop is quiet and offers resume") { activity -> shown(activity).any { it.tag == "home-capture-paused" } }
            instrumentation.runOnMainSync {
                assertTrue("采集已暂停" in texts(paused) && "恢复采集" in texts(paused))
                assertFalse("A pause is not an error", shown(paused).any { it.tag == "home-attention" })
            }
            capture(paused, "home-paused")
            settings.save(settings.read().copy(screenCollectionEnabled = false)); settings.screenPaused(System.currentTimeMillis())
            val screen = onTop("A temporary screen pause names when it started") { activity -> "屏幕采集已暂停" in texts(activity) && texts(activity).any { it.endsWith(" 起") } }
            capture(screen, "home-screen-paused")
            settings.save(settings.read().copy(notificationCollectionEnabled = true))
            onTop("Stopped while other sources are selected is a full pause, not a screen pause") { activity ->
                "采集已暂停" in texts(activity) && "屏幕采集已暂停" !in texts(activity) && "恢复采集" in texts(activity)
            }
            settings.status("permission_required", "生成的中断：采集服务被系统停止")
            val broken = onTop("An actionable interruption is amber with its repair") { activity -> shown(activity).any { it.tag == "home-attention" } }
            instrumentation.runOnMainSync { assertTrue("采集已中断" in texts(broken) && "重新开启" in texts(broken) && "生成的中断：采集服务被系统停止" in texts(broken)) }
            capture(broken, "home-interrupted")
            click(broken) { it.tag == "home-attention" }
            val panel = resumed(CaptureStatusActivity::class.java, "The line opens the capture status panel")
            onTop("The panel reads the same facts") { activity -> shown(activity).any { it.tag == "capture-status-screen-state" && (it as TextView).text.isNotBlank() } && shown(activity).any { it.tag == "capture-status-all" } }
            instrumentation.runOnMainSync {
                assertTrue("屏幕采集" in texts(panel) && "通知与设备信息" in texts(panel) && "同步文件夹" in texts(panel))
                assertEquals("Starting returns to the app's preview", "开始采集", (shown(panel).single { it.tag == "capture-status-all" } as Button).text.toString())
            }
            capture(panel, "capture-status")
            instrumentation.runOnMainSync { panel.onBackPressedDispatcherCompat() }
            val home = onTop("Back from the panel returns to the home") { activity -> activity is MainActivity && shown(activity).any { it.tag == "home-attention" } }
            click(home) { it.tag == "home-attention" }
            val again = resumed(CaptureStatusActivity::class.java, "The amber line opens the panel again")
            onTop("The panel is ready") { activity -> shown(activity).any { it.tag == "capture-status-screen" } }
            click(again) { it.tag == "capture-status-screen" }
            val scope = onTop("The screen row leads to the recovery scope page") { activity -> activity is MainActivity && shown(activity).any { it.tag == "local-back:PRIVACY" } }
            until("The panel finished when the app took over") { inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).none { it is CaptureStatusActivity } }
            instrumentation.runOnMainSync { scope.onBackPressedDispatcherCompat() }
            onTop("Back leaves the scope page inside the app") { activity -> activity is MainActivity && shown(activity).none { it.tag == "local-back:PRIVACY" } }
        } finally {
            val open = inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)
            instrumentation.runOnMainSync { open.forEach { it.finish() } }
            until("The journey's activities finished") { inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).isEmpty() }
        }
    }

    @Test fun aStandalonePanelLeavesNothingBehindTheApp() {
        // The tile and the notification open the panel in a task of its own when no app screen is open.
        context.startActivity(Intent(context, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        try {
            val panel = onTop("The panel opens as its task's root") { activity -> activity is CaptureStatusActivity && activity.isTaskRoot && shown(activity).any { it.tag == "capture-status-screen" } }
            click(panel) { it.tag == "capture-status-screen" }
            val scope = onTop("The screen row opens the recovery scope page") { activity -> activity is MainActivity && shown(activity).any { it.tag == "local-back:PRIVACY" } }
            until("The panel does not stay behind the app, so Back from the home leaves the task") { inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).none { it is CaptureStatusActivity } }
            instrumentation.runOnMainSync { assertTrue("The app now owns the task", scope.isTaskRoot) }
        } finally {
            val open = inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED)
            instrumentation.runOnMainSync { open.forEach { it.finish() } }
            until("The journey's activities finished") { inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).isEmpty() }
        }
    }

    @Test fun quickRecordsAndSearchOpenTheirOwnPages() {
        Fixture().use { fixture ->
            connect(fixture)
            ActivityScenario.launch(MainActivity::class.java).use {
                val home = onTop("Home is ready") { activity -> shown(activity).any { it.tag == "home-photo-action" } }
                click(home) { it.tag == "home-photo-action" }
                until("Photo opens the same record editor and asks for the camera") {
                    inStage(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).any { it is RecordEditorActivity && it.intent.getStringExtra("startMedia") == "camera" } &&
                        inStage(Stage.RESUMED).none { it is RecordEditorActivity }
                }
                // The system dialog must own input focus before Back can decline it.
                until("The system camera prompt is in front") { automation.rootInActiveWindow?.packageName?.toString()?.contains("permissioncontroller") == true }
                automation.executeShellCommand("input keyevent KEYCODE_BACK").use { java.io.FileInputStream(it.fileDescriptor).readBytes() }
                val editor = onTop("Declining the camera keeps the editor and says so") { activity -> activity is RecordEditorActivity && "权限未授予" in texts(activity) }
                instrumentation.runOnMainSync { editor.finish() }
                val back = resumed(MainActivity::class.java, "The editor returns to the home")
                click(back) { it.tag == "home-search-action" }
                val search = onTop("Search opens one focused field") { activity -> activity is CentralActivity && shown(activity).any { it.tag == "material-search-field" } }
                instrumentation.runOnMainSync {
                    (shown(search).single { it.tag == "material-search-field" } as EditText).setText("评审")
                    shown(search).single { it.tag == "material-search-submit" }.performClick()
                }
                val results = onTop("Results come from Central's evidence reader") { activity -> "生成的搜索结果" in texts(activity) }
                assertEquals("评审", fixture.searchQuery)
                capture(results, "search-results")
                instrumentation.runOnMainSync { results.finish() }
                resumed(MainActivity::class.java, "Search returns to the home")
            }
        }
    }

    @Test fun systemEntriesShareOneDefinitionAndKeepTheAppTask() {
        automation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        fun actions(): List<String>? = manager.activeNotifications.firstOrNull { it.id == Notifications.ID }?.notification?.actions?.map { it.title.toString() }
        context.systemEntries().show("生成的屏幕状态")
        until("The capture notification pauses only the screen and records") { actions() == listOf("暂停屏幕采集", "记录") }
        if (Build.VERSION.SDK_INT >= 31) assertTrue("Tapping the notification opens an activity", manager.activeNotifications.first { it.id == Notifications.ID }.notification.contentIntent.isActivity)
        context.systemEntries().clear(); context.systemEntries().showEvents("生成的设备事件")
        until("Without screen capture the existing full stop remains") { actions() == listOf("停止采集", "记录") }
        context.systemEntries().showEvents(null)
        until("No capture means no ongoing notification") { actions() == null }

        instrumentation.runOnMainSync {
            val widget = QuickEntryWidget.views(context).apply(context, FrameLayout(context))
            assertEquals("问一问…", widget.findViewById<TextView>(R.id.widget_ask).text.toString())
            assertEquals(listOf("记录", "拍照", "录音"), listOf(R.id.widget_record, R.id.widget_photo, R.id.widget_audio).map { widget.findViewById<View>(it).contentDescription.toString() })
        }
        MoteShortcuts.publish(context)
        assertEquals(setOf("record", "photo", "audio", "ask"), context.getSystemService(ShortcutManager::class.java).dynamicShortcuts.map { it.id }.toSet())

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            onTop("Home is ready") { activity -> shown(activity).any { it.tag == "home-record-action" } }
            // Launchers start shortcuts with a cleared task; the entry's own task absorbs that reset.
            context.startActivity(MoteQuickEntry.RECORD.intent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            val editor = resumed(RecordEditorActivity::class.java, "The record entry opens the editor")
            assertNotEquals("The app's existing home survives a launcher entry", androidx.lifecycle.Lifecycle.State.DESTROYED, scenario.state)
            instrumentation.runOnMainSync { editor.finish() }
            resumed(MainActivity::class.java, "Closing the editor returns to the existing home")
        }
    }

    @Test fun notificationPauseStopsOnlyTheScreen() {
        until("Local storage finished its startup recovery") { !QueueStorage.recovering }
        val settings = Settings(context)
        settings.save(settings.read().copy(screenCollectionEnabled = true, notificationCollectionEnabled = true, syncPaused = false))
        settings.enabled = true
        assertEquals("The notification action keeps its broadcast until the pause is saved", true,
            whenReleased(PauseScreenReceiver::class.java) { !settings.read().screenCollectionEnabled && settings.screenPausedAt() != null })
        val after = settings.read()
        assertTrue("Notifications keep their own choice", after.notificationCollectionEnabled)
        assertFalse("Sending is not paused", after.syncPaused)
        assertTrue("Other sources keep capture enabled", settings.enabled)
    }

    @Test fun notificationStopKeepsItsBroadcastUntilCaptureIsStopped() {
        until("Local storage finished its startup recovery") { !QueueStorage.recovering }
        val settings = Settings(context)
        settings.save(settings.read().copy(screenCollectionEnabled = false, notificationCollectionEnabled = true, syncPaused = false))
        settings.enabled = true; settings.status("capturing", "生成的采集状态")
        val stopped = MoteI18n.text("你已停止采集，已有记录保留，同步按所选策略运行")
        assertEquals("The stop action keeps its broadcast until the stop and its status are saved", true,
            whenReleased(StopReceiver::class.java) { !settings.enabled && settings.state() == "paused" && settings.message() == stopped })
        assertFalse("Stopping capture leaves sending as chosen", settings.read().syncPaused)
    }

    @Test fun aSecondStopReportsOnlyAfterTheStopUnderWay() {
        until("Local storage finished its startup recovery") { !QueueStorage.recovering }
        val settings = Settings(context)
        settings.save(settings.read().copy(screenCollectionEnabled = false, notificationCollectionEnabled = true, syncPaused = false))
        settings.enabled = true; settings.status("capturing", "生成的采集状态")
        val stopped = MoteI18n.text("你已停止采集，已有记录保留，同步按所选策略运行")
        val first = java.util.concurrent.LinkedBlockingQueue<Boolean>(); val second = java.util.concurrent.LinkedBlockingQueue<Boolean>()
        // One stop is still under way when the notification's stop arrives, as after a panel stop and a quick notification tap.
        instrumentation.runOnMainSync {
            RuntimeSettings.stop(context) { first.put(it.isSuccess) }
            dev.mote.collector.plugins.CapturePlugin.controls().stopAll(context) { result -> second.put(result.isSuccess && !settings.enabled && settings.state() == "paused" && settings.message() == stopped) }
        }
        assertEquals("The stop under way still reports to its own caller", true, first.poll(20, TimeUnit.SECONDS))
        assertEquals("The joining stop reports only after capture is off and its status is saved", true, second.poll(20, TimeUnit.SECONDS))
        assertFalse(RuntimeSettings.stopping)
    }

    /** An ordered broadcast reports back only after its receiver releases it; [check] reads the state at that moment. */
    private fun whenReleased(receiver: Class<out android.content.BroadcastReceiver>, check: () -> Boolean): Boolean? {
        val result = java.util.concurrent.LinkedBlockingQueue<Boolean>()
        val thread = android.os.HandlerThread("broadcast-result").apply { start() }
        try {
            context.sendOrderedBroadcast(Intent(context, receiver), null, object : android.content.BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) { result.put(check()) }
            }, android.os.Handler(thread.looper), Activity.RESULT_OK, null, null)
            return result.poll(20, TimeUnit.SECONDS)
        } finally { thread.quitSafely() }
    }

    @Test fun normalCaptureIsOneQuietLineAndTheTilePausesOnlyTheScreen() {
        fun shell(command: String) = automation.executeShellCommand(command).use { String(java.io.FileInputStream(it.fileDescriptor).readBytes()).trim() }
        val service = "${context.packageName}/${CaptureAccessibilityService::class.java.name}"
        val tile = "${context.packageName}/${ScreenCaptureTileService::class.java.name}"
        val previousServices = shell("settings get secure enabled_accessibility_services")
        val previousEnabled = shell("settings get secure accessibility_enabled")
        automation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        try {
            until("Local storage finished its startup recovery") { !QueueStorage.recovering }
            val settings = Settings(context)
            settings.save(settings.read().copy(screenCollectionEnabled = true, mode = "accessibility"))
            settings.capturePreviewAccepted()
            shell("settings put secure enabled_accessibility_services $service"); shell("settings put secure accessibility_enabled 1")
            until("The task-owned emulator binds the capture service") { CaptureAccessibilityService.connected }
            settings.enabled = true; settings.status("capturing", "生成的采集状态")
            ActivityScenario.launch(MainActivity::class.java).use {
                val home = onTop("Normal capture is one quiet line") { activity -> shown(activity).any { it.tag == "home-capture-state" } && "采集中" in texts(activity) }
                instrumentation.runOnMainSync {
                    assertTrue("The line names the live source", "屏幕" in texts(home))
                    assertFalse("Normal capture offers no step", listOf("恢复采集", "重新开启", "处理").any { it in texts(home) })
                }
                capture(home, "home-capturing")
                until("The service's own notification pauses only the screen") {
                    manager.activeNotifications.firstOrNull { it.id == Notifications.ID }?.notification?.actions?.map { it.title.toString() } == listOf("暂停屏幕采集", "记录")
                }
                shell("cmd statusbar add-tile $tile")
                Thread.sleep(2000) // SystemUI binds a newly added tile before it accepts a click.
                shell("cmd statusbar click-tile $tile")
                until("Quick Settings pauses only the screen") { !settings.read().screenCollectionEnabled && settings.screenPausedAt() != null }
                shell("cmd statusbar collapse")
                val paused = onTop("The home shows the temporary pause with resume") { activity -> "屏幕采集已暂停" in texts(activity) && "恢复采集" in texts(activity) }
                capture(paused, "home-after-tile-pause")
            }
        } finally {
            Settings(context).enabled = false
            shell("cmd statusbar remove-tile $tile")
            shell(if (previousServices == "null" || previousServices.isBlank()) "settings delete secure enabled_accessibility_services" else "settings put secure enabled_accessibility_services $previousServices")
            shell("settings put secure accessibility_enabled ${previousEnabled.takeIf { it == "1" } ?: "0"}")
        }
    }

    private fun Activity.onBackPressedDispatcherCompat() { @Suppress("DEPRECATION") onBackPressed() }

    /**
     * Serves only generated Central responses on the emulator's loopback. One fixed port keeps one Central identity:
     * records captured by the capture test stay bound to their first node, as the app requires.
     */
    private inner class Fixture : AutoCloseable {
        private val listener = ServerSocket().apply { reuseAddress = true; bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), 47911), 8) }
        val origin = "http://127.0.0.1:${listener.localPort}"
        @Volatile var searchQuery: String? = null
        private val executor = Executors.newSingleThreadExecutor()
        init { executor.submit {
            while (!listener.isClosed) runCatching { listener.accept() }.getOrNull()?.use { socket ->
                val input = socket.getInputStream().bufferedReader()
                val path = input.readLine().orEmpty().split(' ').getOrElse(1) { "" }
                while (!input.readLine().isNullOrBlank()) Unit
                val body = when {
                    path.startsWith("/api/conversations?") -> JSONObject().put("items", JSONArray().put(JSONObject().put("id", conversation).put("title", "周五评审需要准备什么？").put("updatedAt", "2026-10-30T10:00:00Z").put("turnCount", 2)))
                    path == "/api/status" -> JSONObject().put("storage", JSONObject().put("captures", 3))
                    // A newer suggestion that needs nothing comes first, so the home has to follow the cursor to the waiting one.
                    path == "/api/actions?cursor=0" -> JSONObject().put("nextCursor", 7).put("targets", JSONArray()).put("items", JSONArray().put(JSONObject()
                        .put("id", settled).put("version", 1).put("kind", "calendar.create").put("status", "approved").put("evidence", JSONArray())
                        .put("event", JSONObject().put("title", "生成的已安排事项").put("start", "2026-11-01T07:00:00Z").put("end", "2026-11-01T08:00:00Z").put("timeZone", "Asia/Shanghai").put("allDay", false).put("location", "").put("description", ""))))
                    path.startsWith("/api/actions?") -> JSONObject().put("nextCursor", JSONObject.NULL).put("targets", JSONArray()).put("items", JSONArray().put(JSONObject()
                        .put("id", action).put("version", 1).put("kind", "calendar.create").put("status", "proposed").put("evidence", JSONArray())
                        .put("event", JSONObject().put("title", "生成的设计评审").put("start", "2026-11-02T07:00:00Z").put("end", JSONObject.NULL).put("timeZone", "Asia/Shanghai").put("allDay", false).put("location", "").put("description", ""))))
                    path.startsWith("/api/context/search?") -> {
                        searchQuery = path.substringAfter("query=").substringBefore('&').let { URLDecoder.decode(it, "UTF-8") }
                        JSONObject().put("nextCursor", JSONObject.NULL).put("items", JSONArray().put(JSONObject().put("title", "生成的搜索结果").put("snippet", "周五评审的生成原文片段").put("ref", "generated-reference")))
                    }
                    path.startsWith("/api/model-settings") -> JSONObject().put("profiles", JSONArray())
                    else -> JSONObject().put("items", JSONArray())
                }.toString().toByteArray()
                socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(body); flush() }
            }
        } }
        override fun close() { listener.close(); executor.shutdownNow() }
    }
}
