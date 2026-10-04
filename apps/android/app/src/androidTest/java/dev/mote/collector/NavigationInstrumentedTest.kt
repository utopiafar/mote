package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Navigation-only fixtures. These tests never enable capture or call a model. */
@RunWith(AndroidJUnit4::class)
class NavigationInstrumentedTest {
    private var previousLanguage = "system"
    @org.junit.Before fun fixtureLanguage() {
        previousLanguage = MoteI18n.preference()
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, "zh-CN")
    }
    @org.junit.After fun restoreLanguage() {
        MoteI18n.select(InstrumentationRegistry.getInstrumentation().targetContext, previousLanguage)
    }
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }
    private fun editor(activity: MainActivity, hint: String) = views(activity.window.decorView)
        .filterIsInstance<EditText>().single { it.hint?.toString() == hint }
    private fun tab(activity: MainActivity, label: String) {
        val current = when(label) { "设置" -> "本机"; "概览" -> "今天"; "随手记" -> "记录"; else -> label }
        views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString() == current }.performClick()
        // The product explicitly confirms discarding a settings draft.
        android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap { views(it) }
            .filterIsInstance<TextView>().firstOrNull { it.isShown && it.text.toString() == "丢弃修改" }?.performClick()
    }
    private fun menu(activity: MainActivity, label: String) = views(activity.window.decorView)
        .single { it.isShown && it.tag == "menu:$label" }.performClick()

    @Test fun tappingOutsideTheNoteDismissesEditorFocus() {
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity -> tab(activity, "随手记") }
            val deadline=SystemClock.elapsedRealtime()+10000; var enabled=false
            while(!enabled && SystemClock.elapsedRealtime()<deadline){scenario.onActivity { enabled=editor(it,"记下此刻的想法…").isEnabled };if(!enabled)Thread.sleep(25)}
            scenario.onActivity { activity ->
                val field = editor(activity, "记下此刻的想法…")
                field.requestFocus(); assertTrue(field.hasFocus())
                val down = SystemClock.uptimeMillis()
                val event = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, 1f, 1f, 0)
                try { activity.dispatchTouchEvent(event) } finally { event.recycle() }
                assertFalse(field.hasFocus())
            }
        }
    }

    @Test fun everyLocalBottomTabSwitchesOnItsFirstTouch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(true)
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            val originalNavigation = arrayOfNulls<View>(1)
            scenario.onActivity { originalNavigation[0] = views(it.window.decorView).single { view -> view is MotePrimaryNavigation } }
            val askMonitor = instrumentation.addMonitor(AskActivity::class.java.name, null, true)
            val centralMonitor = instrumentation.addMonitor(CentralActivity::class.java.name, null, true)
            try { for (label in listOf("资料库", "问一问", "本机", "今天", "问一问", "资料库", "今天")) {
                instrumentation.waitForIdleSync()
                var x = 0f; var y = 0f
                scenario.onActivity { activity ->
                    val item = views(activity.window.decorView).filterIsInstance<TextView>()
                        .single { it.isShown && it.isClickable && it.text.toString() == label }
                    val position = IntArray(2); item.getLocationOnScreen(position)
                    x = position[0] + item.width / 2f; y = position[1] + item.height / 2f
                }
                val down = SystemClock.uptimeMillis()
                MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0).let { instrumentation.sendPointerSync(it); it.recycle() }
                MotionEvent.obtain(down, down + 30, MotionEvent.ACTION_UP, x, y, 0).let { instrumentation.sendPointerSync(it); it.recycle() }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    assertTrue("$label must select on one touch", views(activity.window.decorView).filterIsInstance<TextView>()
                        .single { it.isShown && it.isClickable && it.text.toString() == label }.isSelected)
                    assertSame(originalNavigation[0], views(activity.window.decorView).single { it is MotePrimaryNavigation })
                    if (label != "问一问") assertFalse(views(activity.window.decorView).filterIsInstance<EditText>().any { it.isShown })
                    assertFalse(activity.isFinishing)
                }
            }
            assertEquals("Ask must switch inside MainActivity", 0, askMonitor.hits)
            assertEquals("Primary tabs must not launch central Activities", 0, centralMonitor.hits)
            } finally { instrumentation.removeMonitor(askMonitor); instrumentation.removeMonitor(centralMonitor) }
        }
    }

    @Test fun conversationUsesTheSamePrimaryNavigationEvenBeforeConnecting() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = Settings(context); val previous = settings.read()
        org.junit.Assume.assumeTrue("Fresh generated development fixture only", context.packageName == "dev.mote.collector.dev" && previous.token.isBlank() && !settings.enabled && context.queue().depth() == 0)
        settings.save(previous.copy(server = "", token = ""), confirmCentralEndpoint = true)
        try { ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { tab(it, "问一问") }
            scenario.onActivity { activity ->
                val tabs = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }
                assertEquals(listOf("今天", "资料库", "问一问", "本机"), tabs.map { it.text.toString() })
                assertTrue(tabs.single { it.text == "问一问" }.isSelected)
                assertFalse(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text == "打开对话" })
                assertFalse(views(activity.window.decorView).any { it.isShown && it.contentDescription == "返回上一页" })
                assertFalse(Settings(activity).enabled)
            }
            scenario.recreate(); scenario.awaitMainUi()
            scenario.onActivity { activity ->
                assertTrue(views(activity.window.decorView).single { it.tag == "primary:ASK" }.isSelected)
                activity.onBackPressed()
                assertTrue(views(activity.window.decorView).single { it.tag == "primary:TODAY" }.isSelected)
                assertFalse(activity.isFinishing)
            }
        } } finally { settings.save(previous, confirmCentralEndpoint = true) }
    }

    @Test fun permissionsAndLocalLogsOpenWithoutStartingCapture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertFalse(Settings(context).enabled)
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                tab(activity, "设置"); menu(activity, "权限与后台运行")
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any {
                    it.isShown && it.text.contains("通知使用权")
                })
                assertFalse(Settings(activity).enabled)
            }
        }
        ActivityScenario.launch(LogViewerActivity::class.java).use { scenario ->
            val deadline = SystemClock.elapsedRealtime() + 10_000
            var loaded = false
            while (!loaded && SystemClock.elapsedRealtime() < deadline) {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                    loaded = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("原始日志 ·") || it.text.toString() == "暂无日志。" }
                }
                if (!loaded) Thread.sleep(50)
            }
            assertTrue("Local event log must finish loading", loaded)
        }
        assertFalse(Settings(context).enabled)
    }

    private fun navigate(scenario: ActivityScenario<MainActivity>, label: String) {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        scenario.onActivity { tab(it,label) };instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
            android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap { views(it) }
                .filterIsInstance<TextView>().firstOrNull { it.isShown && it.text.toString()=="丢弃修改" }?.performClick()
        }
        instrumentation.waitForIdleSync()
    }
    @Test fun leavingSettingsPagesDiscardsInputsAndHidesSaveBar() {
        val saved=Settings(InstrumentationRegistry.getInstrumentation().targetContext).read()
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertFalse("Advanced forms are lazy",views(activity.window.decorView).any { it is EditText })
            }
            navigate(scenario,"设置")
            scenario.onActivity { activity ->
                menu(activity,"连接与同步")
                editor(activity,"https://mote.example.com").setText("https://127.0.0.1:1")
                editor(activity,"建议通过邀请获取本设备凭据").setText("generated-navigation-fixture-token-1234567890")
            }
            navigate(scenario,"设置")
            scenario.onActivity { activity ->
                menu(activity,"采集与存储")
                assertEquals(saved,Settings(activity).read())
                editor(activity,"30").setText("47")
            }
            navigate(scenario,"随手记")
            scenario.onActivity { activity ->
                assertTrue(editor(activity,"记下此刻的想法…").isShown)
                assertFalse(views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown&&it.text=="保存设置" })
            }
            navigate(scenario,"设置")
            scenario.onActivity { activity ->
                menu(activity,"采集与存储")
                assertEquals(saved.intervalSeconds.toString(),editor(activity,"30").text.toString())
                assertEquals(saved,Settings(activity).read());assertFalse(Settings(activity).enabled)
            }
        }
    }

    @Test fun askTabUsesTheSameUnsavedSettingsConfirmation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                tab(activity, "本机"); menu(activity, "采集与存储")
                editor(activity, "30").setText("47")
                views(activity.window.decorView).single { it.tag == "primary:ASK" }.performClick()
                assertTrue(views(activity.window.decorView).single { it.tag == "primary:DEVICE" }.isSelected)
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap { views(it) }
                    .filterIsInstance<TextView>().single { it.isShown && it.text.toString() == "继续编辑" }.performClick()
            }
            scenario.onActivity { activity -> assertEquals("47", editor(activity, "30").text.toString()) }
            navigate(scenario, "问一问")
            scenario.onActivity { activity -> assertTrue(views(activity.window.decorView).single { it.tag == "primary:ASK" }.isSelected) }
            navigate(scenario, "本机")
            scenario.onActivity { activity -> menu(activity, "采集与存储"); assertEquals(Settings(activity).read().intervalSeconds.toString(), editor(activity, "30").text.toString()) }
        }
    }

    @Test fun activePageDraftSurvivesRotationAndBackgroundWithoutChangingSavedConfiguration() {
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            val saved = Settings(InstrumentationRegistry.getInstrumentation().targetContext).read()
            scenario.onActivity { activity ->
                tab(activity, "设置"); menu(activity, "采集与存储")
                editor(activity, "30").setText("47")
            }
            scenario.recreate(); scenario.awaitMainUi()
            scenario.onActivity { activity ->
                assertTrue(editor(activity, "30").isShown)
                assertEquals("47", editor(activity, "30").text.toString())
            }
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            scenario.onActivity { activity ->
                assertEquals("47", editor(activity, "30").text.toString())
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text == "保存设置" })
                assertEquals(saved, Settings(activity).read())
            }
        }
    }

    @Test fun numericAppAndMaskPickersKeepConfigurationStructured() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        fun dialogViews() = android.view.inspector.WindowInspector.getGlobalWindowViews()
            .filter { it.hasWindowFocus() }.flatMap { views(it) }
        fun clickDialogLabel(label: String) {
            val deadline = SystemClock.elapsedRealtime() + 10_000
            var clicked = false
            // Installed-app choices arrive from a background query after the UI thread becomes idle.
            while (!clicked) {
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val selected = dialogViews().filterIsInstance<TextView>().firstOrNull { it !is EditText && it.isShown && it.text.toString() == label } ?: return@runOnMainSync
                    var row: View = selected
                    while (row.parent is View && row.parent !is android.widget.ListView) row = row.parent as View
                    val list = row.parent as? android.widget.ListView
                    if (list != null) {
                        val position = list.getPositionForView(row)
                        assertTrue(list.performItemClick(row, position, list.getItemIdAtPosition(position)))
                    } else assertTrue("Dialog choice must be clickable: $label", selected.performClick())
                    clicked = true
                }
                if (!clicked) { check(SystemClock.elapsedRealtime() < deadline) { "Generated dialog choice did not appear: $label" }; Thread.sleep(50) }
            }
            instrumentation.waitForIdleSync()
        }
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity -> tab(activity, "设置"); menu(activity, "采集与存储"); assertNull(editor(activity, "30").keyListener); editor(activity, "30").performClick() }
            clickDialogLabel("60")
            scenario.onActivity { activity ->
                assertEquals("60", editor(activity, "30").text.toString())
            }
            navigate(scenario,"设置")
            scenario.onActivity { activity -> menu(activity,"隐私与应用规则");tab(activity,"管理应用 · 查看每个应用的记录方式") }
            val appName = instrumentation.targetContext.applicationInfo.loadLabel(instrumentation.targetContext.packageManager).toString()
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                dialogViews().filterIsInstance<EditText>().single { it.hint?.toString() == "搜索应用名称" }.setText(appName)
            }
            clickDialogLabel(appName); clickDialogLabel("仅应用和时长 · 不保存截图"); clickDialogLabel("完成")
            scenario.onActivity { activity ->
                assertTrue(editor(activity, "com.example.chat=activity\ncom.example.private=off").text.contains("${activity.packageName}=activity"))
                tab(activity, "遮住顶部 8%"); tab(activity, "遮住底部 12%")
                assertEquals(2, Mask.parse(editor(activity, "0,0,1,0.08").text.toString()).size)
                assertFalse(editor(activity, "0,0,1,0.08").isShown)
            }
            scenario.recreate(); scenario.awaitMainUi()
            scenario.onActivity { activity -> assertEquals(2, Mask.parse(editor(activity, "0,0,1,0.08").text.toString()).size) }
        }
    }


    @Test fun generatedNoteKeyboardKeepsPrimaryNavigationVisible() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        org.junit.Assume.assumeTrue("Explicit generated-only UI rendering required", InstrumentationRegistry.getArguments().getString("renderGeneratedUi") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:") && !Settings(context).enabled)
        require(QuickNotes.draft(context).read().text.isEmpty())
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { tab(it, "记录") }
            val editorDeadline = SystemClock.elapsedRealtime() + 10000; var ready = false
            while (!ready && SystemClock.elapsedRealtime() < editorDeadline) {
                scenario.onActivity { ready = editor(it, "记下此刻的想法…").isEnabled && it.window.decorView.hasWindowFocus() }
                if (!ready) Thread.sleep(50)
            }
            assertTrue("Fixture note draft must finish loading", ready)
            scenario.onActivity { activity ->
                val field = editor(activity, "记下此刻的想法…"); assertTrue(field.requestFocus())
                activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
            }
            val deadline = SystemClock.elapsedRealtime() + 10000; var shown = false
            while (!shown && SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity { shown = it.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }
                if (!shown) Thread.sleep(50)
            }
            assertTrue("Fixture keyboard must open", shown)
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val root = activity.window.decorView
                val ime = root.rootWindowInsets.getInsets(android.view.WindowInsets.Type.ime())
                val availableBottom = root.height - ime.bottom
                val items = views(root).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }
                assertEquals(4, items.size)
                for (item in items) {
                    val bounds = android.graphics.Rect(); assertTrue(item.getGlobalVisibleRect(bounds))
                    assertTrue("${item.text} must remain above the keyboard", bounds.bottom <= availableBottom + 2)
                }
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(bitmap))
                File(context.filesDir, "generated-ui").apply { mkdirs() }.resolve("notes-keyboard.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
                activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(root.windowToken, 0)
            }
        }
    }

    @Test fun renderGeneratedNavigationPagesWhenExplicitlyRequested() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        org.junit.Assume.assumeTrue("Explicit generated-only UI rendering required", InstrumentationRegistry.getArguments().getString("renderGeneratedUi") == "true")
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!Settings(context).enabled && context.queue().depth() == 0)
        require(QuickNotes.draft(context).read().text.isEmpty())
        val directory = File(context.filesDir, "generated-ui").apply { mkdirs() }
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            // Every primary destination is rendered inside the same generated MainActivity.
            listOf("今天" to "overview", "问一问" to "ask", "记录" to "notes", "资料库" to "library", "本机来源" to "sources", "本机" to "settings", "采集与存储" to "capture-settings", "连接与同步" to "sync-settings", "隐私与应用规则" to "privacy-settings", "本机存储" to "storage-settings", "图像与文字识别" to "processing-settings").forEach { (label, file) ->
                scenario.onActivity {
                    when {
                        file == "sources" -> { tab(it, "本机"); menu(it, label) }
                        file.endsWith("-settings") -> { tab(it, "本机"); if (file == "processing-settings") menu(it, "采集与存储"); menu(it, label) }
                        else -> tab(it, label)
                    }
                }
                instrumentation.waitForIdleSync()
                if (file == "ask") {
                    val deadline = SystemClock.elapsedRealtime() + 10000; var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < deadline) {
                        scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.tag == "central-title" && it.text.isNotBlank() } }
                        if (!ready) Thread.sleep(50)
                    }
                    assertTrue("Embedded Ask must finish loading for the generated rendering", ready)
                }
                scenario.onActivity { activity ->
                    assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                    val view = activity.window.decorView
                    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                    // Draw only this generated-fixture application's own view tree, never the device screen.
                    view.draw(Canvas(bitmap))
                    File(directory, "$file.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                }
            }
        }
        ActivityScenario.launch(AskActivity::class.java).use { scenario ->
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val root = activity.window.decorView
                val header = views(root).single { it.tag == "central-header" } as ViewGroup
                for (index in 0 until header.childCount) {
                    val child = header.getChildAt(index)
                    assertTrue("Central header child must have room", child.width > 0 && child.right <= header.width)
                }
                val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(bitmap))
                File(directory, "central-login.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
    }
}
