package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Explicit generated-only expansion/confirmation states, without granting any system permission. */
@RunWith(AndroidJUnit4::class)
class UiSupplementRolloutInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun click(activity: Activity, key: String) {
        clickLabel(activity, MoteI18n.text(key))
    }
    private fun clickLabel(activity: Activity, label: String) {
        val button = views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == label }
        assertTrue(button.performClick())
    }
    private fun overlay() = android.view.inspector.WindowInspector.getGlobalWindowViews().single { root ->
        root.isShown && views(root).any { (it.id in setOf(android.R.id.button1, android.R.id.button2) || it.tag == "add-source:FILE") && it.isShown }
    }
    private fun settleWindows() {
        instrumentation.waitForIdleSync()
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000
        var ready = false
        while (!ready && android.os.SystemClock.elapsedRealtime() < deadline) {
            instrumentation.runOnMainSync {
                val windows = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }
                ready = windows.flatMap(::views).filter { it.isShown && it.id in setOf(android.R.id.button1, android.R.id.button2, android.R.id.button3) }.all { button ->
                    val visible = android.graphics.Rect()
                    button.isLaidOut && !button.isLayoutRequested && button.getGlobalVisibleRect(visible) && visible.width() == button.width && visible.height() == button.height
                }
            }
            if (!ready) Thread.sleep(16)
        }
        // save() retains the strict real-layout and drawn-pixel assertion, including failure PNGs.
    }

    @Test fun explicitAdvancedPanelsAndNativeConfirmationFactsRemainReadable() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("uiIterationFixture") == "true" && args.getString("uiScrollEvidence") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        val variant = args.getString("uiIterationVariant", "default")!!
        MoteI18n.select(context, if (variant.contains("english")) "en" else "zh-CN")
        Settings(context).enabled = false
        val directory = File(context.filesDir, "ui-state-evidence/$variant").apply { mkdirs() }
        fun save(activity: Activity, state: String, scene: String, dialog: Boolean = false) {
            val target = File(directory, state).apply { mkdirs() }
            GeneratedWindowRendering.save(activity, target, scene, if (dialog) listOf(overlay()) else emptyList())
            val metadataFile = File(target, "$scene.json")
            metadataFile.writeText(JSONObject(metadataFile.readText()).put("supplementState", state).put("automaticVisualAcceptance", false).toString(2))
            assertFalse(Settings(context).enabled)
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SETTINGS")).awaitMainUi().use { scenario ->
            scenario.onActivity { click(it, "高级与维护") }; settleWindows()
            scenario.onActivity { save(it, "settings-expanded", "settings") }
        }
        // Give the real native dialog a completed layout before drawing.
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SETTINGS")).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                val label = if (MoteI18n.language() == "en") "Language" else "界面语言"
                assertTrue(views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }.performClick())
            }
            settleWindows()
            scenario.onActivity { save(it, "language-choice", "settings", dialog = true); overlay().findViewById<View>(android.R.id.button2).performClick() }
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "PRIVACY")).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                listOf("高级：手工编辑包名规则", "高级：查看或编辑全部页面规则", "高级：编辑精确坐标", "高级：截图文字隐私审查").forEach { click(activity, it) }
            }
            settleWindows()
            scenario.onActivity { save(it, "scope-all-advanced", "screen-scope"); click(it, "预览当前配置的记录格式") }
            settleWindows()
            scenario.onActivity { save(it, "scope-preview-dialog", "screen-scope", dialog = true); overlay().findViewById<View>(android.R.id.button2).performClick() }
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "PERMISSIONS")).awaitMainUi().use { scenario ->
            scenario.onActivity { click(it, "启用无障碍截图服务") }; settleWindows()
            scenario.onActivity { save(it, "accessibility-explanation", "rollout-permissions", dialog = true); overlay().findViewById<View>(android.R.id.button2).performClick() }
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "NOTES")).awaitMainUi().use { scenario ->
            val deadline = System.currentTimeMillis() + 10_000
            var ready = false
            while (!ready && System.currentTimeMillis() < deadline) { scenario.onActivity { ready = GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) }; if (!ready) Thread.sleep(30) }
            assertTrue(ready)
            scenario.onActivity { click(it, "新建一条 · 清除草稿") }; settleWindows()
            scenario.onActivity { save(it, "note-clear-confirmation", "note", dialog = true); overlay().findViewById<View>(android.R.id.button2).performClick() }
        }
        ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("addAction", "FILE")).use { scenario ->
            settleWindows(); scenario.onActivity { click(it, "高级设置") }; settleWindows()
            scenario.onActivity { save(it, "import-advanced", "import-local-task") }
        }
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java)).use { scenario ->
            settleWindows(); scenario.onActivity { assertTrue(views(it.window.decorView).single { view -> view.tag == "sources-add" }.performClick()) }; settleWindows()
            scenario.onActivity { save(it, "source-add-sheet", "sources", dialog = true); views(overlay()).single { view -> view.contentDescription == MoteI18n.text("关闭") }.performClick() }
        }
        ActivityScenario.launch<ActivityStatsActivity>(Intent(context, ActivityStatsActivity::class.java)).use { scenario ->
            val deadline = System.currentTimeMillis() + 10_000
            var ready = false
            while (!ready && System.currentTimeMillis() < deadline) { scenario.onActivity { ready = GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) }; if (!ready) Thread.sleep(30) }
            assertTrue(ready)
            scenario.onActivity { activity ->
                listOf(
                    "\n记录明细抽样\n采集区保留：{0} 条，截图 {1} / 活动 {2} / 媒体 {3} / 系统事件 {4} / 笔记 {5} / 无法读取 {6} / 未检查 {7}（分类最多读取100条）\n",
                    "\n资料在哪里\n队列存储：{0} / 上限 {1} MiB\n{2}\n",
                    "\n生效设置\n实际配置：每 {0} 秒，JPEG {1}，最长边 {2}px\n",
                    "\n统计口径与限制\n已保存表示本机入队成功；已上传表示节点已确认收到。本机副本按中央确认时间和保留天数清理；中央内容识别状态不影响本机保留。被过滤的画面不会入队。暂停是原因变更次数，不等于丢弃截图次数；请求可能因系统/进程中断没有后续结果。统计与队列分开持久化，进程在两次写入之间终止时累计数可能少记；当前队列数量包含同步失败和待复核保留的图片。\n"
                ).forEach { block ->
                    // These production disclosure labels are composed from the translated block heading.
                    val heading = MoteI18n.text(block).trimStart('\n').substringBefore('\n')
                    clickLabel(activity, heading + MoteI18n.text(" · 展开 / 收起"))
                }
            }
            settleWindows(); scenario.onActivity { save(it, "statistics-expanded", "rollout-activity-statistics") }
        }
    }
}
