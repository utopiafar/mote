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
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }
    private fun editor(activity: MainActivity, hint: String) = views(activity.window.decorView)
        .filterIsInstance<EditText>().single { it.hint?.toString() == hint }
    private fun tab(activity: MainActivity, label: String) = views(activity.window.decorView)
        .filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString() == label }.performClick()
    private fun menu(activity: MainActivity, label: String) = views(activity.window.decorView)
        .single { it.isShown && it.tag == "menu:$label" }.performClick()

    @Test fun everyBottomTabSwitchesOnItsFirstTouch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(true)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            for (label in listOf("随手记", "来源", "设置", "概览", "设置", "随手记", "概览")) {
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
                    assertEquals(label == "随手记", editor(activity, "记下此刻的想法…").isShown)
                }
            }
        }
    }

    @Test fun settingsAreSeparateAndUnsavedInputsSurviveNavigationAndRotation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertFalse(editor(activity, "https://mote.example.com").isShown)
                assertFalse(editor(activity, "记下此刻的想法…").isShown)
                tab(activity, "设置"); menu(activity, "连接与同步")
                assertTrue(editor(activity, "https://mote.example.com").isShown)
                editor(activity, "https://mote.example.com").setText("https://127.0.0.1:1")
                editor(activity, "建议通过邀请获取本设备凭据").setText("generated-navigation-fixture-token-1234567890")
                tab(activity, "设置"); menu(activity, "采集与存储")
                editor(activity, "30").setText("47")
                tab(activity, "随手记")
                assertTrue(editor(activity, "记下此刻的想法…").isShown)
                tab(activity, "设置"); menu(activity, "采集与存储")
                assertEquals("47", editor(activity, "30").text.toString())
            }
            scenario.recreate()
            scenario.onActivity { activity ->
                val interval = editor(activity, "30")
                assertTrue(interval.isShown)
                assertEquals("47", interval.text.toString())
                assertEquals("generated-navigation-fixture-token-1234567890", editor(activity, "建议通过邀请获取本设备凭据").text.toString())
                interval.setText("")
                tab(activity, "概览")
                tab(activity, "保存设置")
                assertTrue("Saving must reveal the invalid hidden field", interval.isShown)
                assertNotNull(interval.error)
                assertFalse(Settings(activity).enabled)
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
                    val list = selected.parent as? android.widget.ListView
                    if (list != null) assertTrue(list.performItemClick(selected, list.getPositionForView(selected), list.getItemIdAtPosition(list.getPositionForView(selected))))
                    else assertTrue(selected.performClick())
                    clicked = true
                }
                if (!clicked) { check(SystemClock.elapsedRealtime() < deadline) { "Generated dialog choice did not appear: $label" }; Thread.sleep(50) }
            }
            instrumentation.waitForIdleSync()
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> tab(activity, "设置"); menu(activity, "采集与存储"); assertNull(editor(activity, "30").keyListener); editor(activity, "30").performClick() }
            clickDialogLabel("60")
            scenario.onActivity { activity ->
                assertEquals("60", editor(activity, "30").text.toString())
                tab(activity, "设置"); menu(activity, "隐私与应用规则"); tab(activity, "从已安装应用中选择")
            }
            val appName = instrumentation.targetContext.applicationInfo.loadLabel(instrumentation.targetContext.packageManager).toString()
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                dialogViews().filterIsInstance<EditText>().single { it.hint?.toString() == "搜索应用名称" }.setText(appName)
            }
            clickDialogLabel(appName); clickDialogLabel("仅应用活动")
            scenario.onActivity { activity ->
                assertTrue(editor(activity, "com.example.chat=activity\ncom.example.private=off").text.contains("${activity.packageName}=activity"))
                tab(activity, "遮住顶部 8%"); tab(activity, "遮住底部 12%")
                assertEquals(2, Mask.parse(editor(activity, "0,0,1,0.08").text.toString()).size)
                assertFalse(editor(activity, "0,0,1,0.08").isShown)
            }
            scenario.recreate()
            scenario.onActivity { activity -> assertEquals(2, Mask.parse(editor(activity, "0,0,1,0.08").text.toString()).size) }
        }
    }

    @Test fun renderGeneratedNavigationPagesWhenExplicitlyRequested() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        if (InstrumentationRegistry.getArguments().getString("renderGeneratedUi") != "true") return
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!Settings(context).enabled && context.queue().depth() == 0)
        require(QuickNotes.draft(context).read().text.isEmpty())
        val directory = File(context.filesDir, "generated-ui").apply { mkdirs() }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            listOf("概览" to "overview", "随手记" to "notes", "来源" to "sources", "设置" to "settings", "采集与存储" to "capture-settings", "连接与同步" to "sync-settings", "隐私与应用规则" to "privacy-settings").forEach { (label, file) ->
                scenario.onActivity { if (file.endsWith("-settings")) { tab(it, "设置"); menu(it, label) } else tab(it, label) }
                instrumentation.waitForIdleSync()
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
    }
}
