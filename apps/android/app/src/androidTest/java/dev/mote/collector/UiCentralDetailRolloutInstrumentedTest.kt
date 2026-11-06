package dev.mote.collector

import android.content.Intent
import android.content.ContentValues
import android.content.ContentUris
import android.provider.CalendarContract
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
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Actual native detail paths on a separate generated populated loopback node. */
@RunWith(AndroidJUnit4::class)
class UiCentralDetailRolloutInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun shown(activity: CentralActivity) = views(activity.window.decorView).filter { it.isShown }
    private fun labels(activity: CentralActivity) = shown(activity).filterIsInstance<TextView>().map { it.text.toString() }
    private fun waitFor(scenario: ActivityScenario<CentralActivity>, marker: String, predicate: (CentralActivity) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        var ready = false
        while (!ready && SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity { ready = !it.isWorking && GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) && predicate(it) }
            if (!ready) Thread.sleep(40)
        }
        assertTrue("Generated detail is actually ready: $marker", ready)
        instrumentation.waitForIdleSync()
    }

    @Test fun populatedReadersCorrectionFormsCredentialsAndPluginPreviewsHaveFullVisualEvidence() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("uiIterationFixture") == "true" && args.getString("uiScrollEvidence") == "true" && args.getString("nativeCentralDetailFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        val variant = args.getString("uiIterationVariant", "default")!!
        MoteI18n.select(context, if (variant.contains("english")) "en" else "zh-CN")
        val settings = Settings(context); settings.enabled = false
        CentralSession.get(context).select("")
        settings.save(settings.read().copy(server = "http://127.0.0.1:47884", token = "", debugHttp = true,
            authSignedOut = false, authExpiresAt = 0, authProcess = "", syncMode = "manual"), confirmCentralEndpoint = true)
        ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "overview")).use { scenario ->
            waitFor(scenario, "login") { labels(it).contains(MoteI18n.text("登录并继续")) }
            scenario.onActivity { activity ->
                shown(activity).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text("中央管理令牌") }.setText("generated-native-central-owner-token-123456")
                assertTrue(shown(activity).filterIsInstance<Button>().single { it.text.toString() == MoteI18n.text("登录并继续") }.performClick())
            }
            waitFor(scenario, "owner") { it.client != null && !labels(it).contains(MoteI18n.text("登录并继续")) }
            fun navigate(page: String) {
                scenario.onActivity { it.navigate(page) }
                waitFor(scenario, page) { activity -> (shown(activity).single { it.tag == "central-title" } as TextView).text.toString() == MoteI18n.text(CentralScreens.pages.single { it.first == page }.second) }
            }
            fun click(key: String) {
                waitFor(scenario, key) { shown(it).filterIsInstance<Button>().any { button -> button.text.toString() == MoteI18n.text(key) } }
                scenario.onActivity { activity -> assertTrue(shown(activity).filterIsInstance<Button>().single { it.text.toString() == MoteI18n.text(key) }.performClick()) }
                waitFor(scenario, key) { true }
            }
            fun clickTag(tag: String) {
                waitFor(scenario, tag) { shown(it).any { view -> view.tag == tag && view.isEnabled } }
                scenario.onActivity { activity -> assertTrue(shown(activity).single { it.tag == tag }.performClick()) }
                waitFor(scenario, tag) { true }
            }
            fun clickCard(title: String, key: String) {
                waitFor(scenario, "$title / $key") { labels(it).contains(title) }
                scenario.onActivity { activity ->
                    val card = shown(activity).filterIsInstance<TextView>().single { it.text.toString() == title }.parent as View
                    assertTrue(views(card).filterIsInstance<Button>().single { it.isShown && it.text.toString() == MoteI18n.text(key) }.performClick())
                }
                waitFor(scenario, key) { true }
            }
            fun field(key: String, value: String) = scenario.onActivity { activity ->
                shown(activity).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text(key) }.setText(value)
            }
            fun disclosure(key: String) {
                scenario.onActivity { activity -> assertTrue(shown(activity).filterIsInstance<Button>().single { it.contentDescription == MoteI18n.text(key) }.performClick()) }
                instrumentation.waitForIdleSync()
            }
            fun pluginTab(index: Int) {
                scenario.onActivity { activity -> shown(activity).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("插件页面") }.setSelection(index) }
                waitFor(scenario, "plugin tab $index") { true }
            }
            fun save(page: String, state: String, marker: String, translated: Boolean = true, dialog: Boolean = false) {
                waitFor(scenario, state) { labels(it).any { label -> label.contains(if (translated) MoteI18n.text(marker) else marker) } || dialog }
                scenario.onActivity { activity ->
                    assertEquals("No API failure on actual detail $state", "", (views(activity.window.decorView).single { it.tag == "central-status" } as TextView).text.toString())
                    val overlays = if (dialog) android.view.inspector.WindowInspector.getGlobalWindowViews().filter { root -> root.isShown && views(root).any { it.id == android.R.id.button2 && it.isShown } } else emptyList()
                    if (dialog) assertEquals("Exactly one real native confirmation", 1, overlays.size)
                    val target = File(context.filesDir, "ui-state-evidence/$variant/central-detail-$state").apply { mkdirs() }
                    val scene = "rollout-detail-central-$page"
                    GeneratedWindowRendering.save(activity, target, scene, overlays)
                    val metadata = File(target, "$scene.json")
                    metadata.writeText(JSONObject(metadata.readText()).put("supplementState", "central-detail-$state").put("detailMarker", marker).put("automaticVisualAcceptance", false).toString(2))
                    assertFalse(settings.enabled)
                }
            }
            fun cancelDialog() {
                scenario.onActivity { activity ->
                    val root = android.view.inspector.WindowInspector.getGlobalWindowViews().single { candidate -> candidate.isShown && views(candidate).any { it.id == android.R.id.button2 && it.isShown } }
                    assertTrue(root.findViewById<View>(android.R.id.button2).performClick())
                }
                instrumentation.waitForIdleSync()
            }
            navigate("settings"); click("模型配置")
            scenario.onActivity { activity ->
                val choice = shown(activity).filterIsInstance<Spinner>().single { it.contentDescription == MoteI18n.text("Provider 预设") }
                val index = (0 until choice.count).single { choice.getItemAtPosition(it).toString() == "Generated editable provider" }; choice.setSelection(index)
            }
            waitFor(scenario, "editable provider") { labels(it).contains(MoteI18n.text("编辑")) }
            click("编辑"); save("settings", "model-edit", "保存设置")
            navigate("actions"); click("行动设置"); save("actions", "action-settings", "保存设置")
            navigate("devices"); click("生成设备连接邀请"); save("devices", "invitation-form", "保存设置")
            navigate("connections"); click("创建 MCP 授权"); save("connections", "mcp-credential-form", "保存设置")
            navigate("developer"); click("诊断设置"); save("developer", "diagnostic-settings", "保存设置")
            navigate("lark"); click("配置应用凭据"); save("lark", "lark-credential-form", "保存设置")
            navigate("notes")
            clickCard("Generated native note · 中文 🐾 <script>untrusted evidence</script>", "查看原文")
            save("notes", "central-original-reader", "Generated native note · 中文 🐾 <script>untrusted evidence</script>", translated = false)
            click("删除记录"); save("notes", "central-original-delete-confirmation", "删除记录", dialog = true); cancelDialog()
            navigate("ask"); field("你的问题", "Generated detail question"); click("发送")
            save("ask", "central-answer-running", "停止回答")
            waitFor(scenario, "generated answer") { labels(it).any { label -> label.contains("Generated native answer") } }
            save("ask", "central-answer", "Generated native answer", translated = false)
            navigate("sources"); save("sources", "sources-populated", "Generated detail source", translated = false)
            clickCard("Generated detail source", "编辑来源"); save("sources", "source-edit", "来源声明应用于已有和新资料；单份资料的声明优先。")
            navigate("sources"); clickCard("Generated detail source", "来源资料"); save("sources", "source-items", "历史版本")
            click("历史版本"); save("sources", "source-history", "历史版本")
            navigate("materials"); save("materials", "materials-populated", "Generated detail material", translated = false)
            clickCard("Generated detail material", "查看原文"); save("materials", "material-reader", "保存归属声明")
            click("来源与处理"); save("materials", "material-members", "来源与处理")
            navigate("files"); save("files", "files-populated", "Generated original.txt", translated = false)
            clickCard("Generated original.txt", "查看详情"); save("files", "file-reader", "Generated owner statement", translated = false)
            scenario.onActivity { activity ->
                assertTrue("Original and correction controls are present with technical detail closed", labels(activity).containsAll(listOf(MoteI18n.text("保存原件"), MoteI18n.text("纠正此段"))))
                assertTrue("Readable processing status is directly visible", labels(activity).contains(MoteI18n.text("处理状态") + " · " + MoteI18n.text("已完成")))
                assertFalse("Technical processing record is initially disclosed", labels(activity).any { it.contains("\"inputVersion\"") })
            }
            disclosure("处理详情"); save("files", "file-processing-details", "inputVersion", translated = false)
            scenario.onActivity { activity ->
                val complete = JSONObject(labels(activity).single { it.startsWith("{\n") && it.contains("\"inputVersion\"") })
                assertTrue("Technical processing record includes complete execution and input version", complete.has("execution") && complete.has("inputVersion") && complete.has("attempts"))
                assertTrue("Original/correction controls remain available when detail opens", labels(activity).containsAll(listOf(MoteI18n.text("保存原件"), MoteI18n.text("纠正此段"))))
            }
            disclosure("处理详情")
            click("纠正此段"); save("files", "file-correction", "保存校正")
            click("删除文件"); save("files", "file-delete-confirmation", "删除文件", dialog = true); cancelDialog()
            navigate("memories"); save("memories", "memories-populated", "Generated detail memory", translated = false)
            scenario.onActivity { assertTrue("Actual metadata title remains in the native list", labels(it).contains("Generated detail memory")) }
            scenario.onActivity { assertTrue("Actual metadata evidence count and effective status remain visible", labels(it).contains(MoteI18n.text("已生效") + " · 1 " + MoteI18n.text("条证据"))) }
            click("查看详情"); disclosure("更多"); clickTag("memory-more-correct"); save("memories", "memory-correction", "纠正")
            scenario.onActivity { activity ->
                assertTrue("Actual memory title, full statement and correction controls precede technical metadata", labels(activity).contains("Generated detail memory") && labels(activity).any { it.startsWith("Generated owner statement") } && labels(activity).contains(MoteI18n.text("纠正")))
                assertTrue("Actual evidence remains available with metadata closed", labels(activity).contains(MoteI18n.text("查看原文依据") + " 1"))
                assertFalse("Raw independent-review receipt is initially disclosed", labels(activity).any { it.contains("\"reviewReceipt\"") })
            }
            clickTag("memory-more-generation"); disclosure("元数据"); save("memories", "memory-metadata", "reviewReceipt", translated = false)
            scenario.onActivity { activity ->
                val complete = JSONObject(labels(activity).single { it.startsWith("{\n") && it.contains("\"reviewReceipt\"") })
                assertEquals("Complete original memory title remains in technical record", "Generated detail memory", complete.getString("title"))
                assertTrue("Complete review, admission, statement and evidence remain accessible", complete.has("reviewReceipt") && complete.has("admission") && complete.has("statement") && complete.has("evidence"))
            }
            disclosure("元数据")
            clickTag("memory-more-delete"); save("memories", "memory-delete-confirmation", "删除这条记忆？", dialog = true); cancelDialog()
            navigate("memories"); click("提取记忆"); save("memories", "memory-extraction-jobs", "开始提取")
            navigate("imports"); click("查看预览"); save("imports", "import-preview", "确认导入")
            click("确认导入"); save("imports", "import-confirmation", "请核对预览后再确认。", dialog = true); cancelDialog()
            navigate("processing")
            var fileOperation = false
            repeat(20) {
                if (!fileOperation) {
                    scenario.onActivity { activity -> fileOperation = shown(activity).any { view -> view.tag?.toString()?.startsWith("operation:file:") == true } }
                    if (!fileOperation) click("下一页")
                }
            }
            assertTrue("The actual generated file operation exists across native task pages", fileOperation)
            scenario.onActivity { activity -> assertTrue(shown(activity).first { it.tag?.toString()?.startsWith("operation:file:") == true }.performClick()) }
            waitFor(scenario, "file operation") { true }; save("processing", "operation-detail", "任务详情")
            navigate("plugins"); save("plugins", "plugins-installed", "Generated Android UI adapter", translated = false)
            click("新增实例"); save("plugins", "plugin-create-instance", "创建实例")
            navigate("plugins"); click("配置"); save("plugins", "plugin-configure-instance", "保存配置")
            navigate("plugins"); pluginTab(1); save("plugins", "plugin-discovery", "预览发布包")
            field("GitHub 仓库", "generated/android-ui-adapter"); field("发布标签（可选）", "v1.0.0")
            click("预览发布包"); save("plugins", "plugin-install-preview", "可信插件代码拥有中央宿主权限；访问声明不是沙箱隔离。安装完成后仍需配置、启用与绑定。")
            navigate("plugins"); pluginTab(2); save("plugins", "memory-plan", "准备与生效分开执行。只有范围、正文与索引核验通过后，才能切换写入与查询绑定。")
            clickCard("Generated UI memory plan", "预览更换"); save("plugins", "memory-plan-prepare-disabled", "更换正文权威时须迁移记忆正文、修正与删除标记，再准备索引。同一正文权威只更换检索时可重建索引。准备完成不会自动生效。")
            scenario.onActivity { activity ->
                shown(activity).filterIsInstance<android.widget.CheckBox>().single { it.text.toString() == MoteI18n.text("已确认范围。真实接入可能产生模型与 Embedding 费用，费用以实际服务用量为准。") }.isChecked = true
            }
            save("plugins", "memory-plan-prepare-enabled", "开始准备")
            navigate("plugins")
            scenario.onActivity { activity -> assertTrue(shown(activity).filterIsInstance<Button>().single { it.contentDescription == MoteI18n.text("高级：已注册能力清单") }.performClick()) }
            instrumentation.waitForIdleSync(); click("已注册能力"); save("plugins", "registered-capabilities", "处理设置")
            click("文字识别设置"); save("plugins", "perception-settings", "保存设置")
        }
        // A calendar created solely in the owned emulator proves the real native review form.
        require(args.getString("uiCalendarPermissionsFixture") == "true")
        val calendars = CalendarActions(context, foreground = true)
        assertTrue("Host explicitly granted calendar access only on the generated emulator", calendars.permissions())
        assertEquals("This dedicated generated AVD has no unrelated writable calendars", 0, calendars.calendars().length())
        val account = "generated-mote-ui-$variant"
        val calendarUri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, account)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL).build()
        val local = context.contentResolver.insert(calendarUri, ContentValues().apply {
            put(CalendarContract.Calendars.ACCOUNT_NAME, account); put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            put(CalendarContract.Calendars.NAME, account); put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, "Generated UI calendar")
            put(CalendarContract.Calendars.OWNER_ACCOUNT, account); put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER)
            put(CalendarContract.Calendars.VISIBLE, 1); put(CalendarContract.Calendars.SYNC_EVENTS, 1)
            put(CalendarContract.Calendars.CALENDAR_COLOR, MoteUi.accent); put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, "Asia/Shanghai")
        })!!
        try {
            assertEquals(1, calendars.connect().length())
            ActivityScenario.launch<CalendarActionsActivity>(Intent(context, CalendarActionsActivity::class.java)).use { scenario ->
                val deadline = SystemClock.elapsedRealtime() + 10_000
                var ready = false
                while (!ready && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { ready = GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) && views(it.window.decorView).filterIsInstance<TextView>().any { view -> view.text.toString() == "Generated calendar review" } }
                    if (!ready) Thread.sleep(40)
                }
                assertTrue("Actual generated calendar proposal loaded", ready); instrumentation.waitForIdleSync()
                fun overlays() = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { root -> root.isShown && views(root).any { it.id in setOf(android.R.id.button1, android.R.id.button2) && it.isShown } }
                fun saveCalendar(state: String, modal: Boolean = false) = scenario.onActivity { activity ->
                    val windows = if (modal) overlays() else emptyList()
                    if (modal) assertTrue("Actual native calendar dialog is present", windows.isNotEmpty())
                    val target = File(context.filesDir, "ui-state-evidence/$variant/central-detail-$state").apply { mkdirs() }
                    GeneratedWindowRendering.save(activity, target, "rollout-calendar", windows)
                    val metadata = File(target, "rollout-calendar.json")
                    metadata.writeText(JSONObject(metadata.readText()).put("supplementState", "central-detail-$state").put("automaticVisualAcceptance", false).toString(2))
                    assertFalse(settings.enabled)
                }
                saveCalendar("calendar-populated")
                scenario.onActivity { activity -> assertTrue(views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == MoteI18n.text("查看原文依据") }.performClick()) }
                instrumentation.waitForIdleSync(); saveCalendar("calendar-evidence", modal = true)
                scenario.onActivity { assertTrue(overlays().single().findViewById<View>(android.R.id.button1).performClick()) }; instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> assertTrue(views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == MoteI18n.text("核对并添加到日历") }.performClick()) }
                instrumentation.waitForIdleSync(); saveCalendar("calendar-confirmation", modal = true)
                scenario.onActivity {
                    val form = overlays().single()
                    assertTrue(views(form).filterIsInstance<EditText>().single { it.contentDescription == MoteI18n.text("开始") }.performClick())
                }
                instrumentation.waitForIdleSync(); saveCalendar("calendar-date-picker", modal = true)
                scenario.onActivity {
                    val picker = overlays().single { root -> views(root).any { it is android.widget.DatePicker } }
                    assertTrue(picker.findViewById<View>(android.R.id.button1).performClick())
                }
                instrumentation.waitForIdleSync(); saveCalendar("calendar-time-picker", modal = true)
                scenario.onActivity {
                    val picker = overlays().single { root -> views(root).any { it is android.widget.TimePicker } }
                    assertTrue(picker.findViewById<View>(android.R.id.button2).performClick())
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { assertTrue(overlays().single().findViewById<View>(android.R.id.button2).performClick()) }
            }
        } finally {
            val owned = calendarUri.buildUpon().appendPath(ContentUris.parseId(local).toString()).build()
            assertEquals("Only the generated calendar is removed", 1, context.contentResolver.delete(owned, null, null))
        }
    }
}
