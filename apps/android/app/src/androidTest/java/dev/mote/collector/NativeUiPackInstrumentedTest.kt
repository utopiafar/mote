package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Opt-in generated views on a dedicated no-window emulator. Never reads the device display. */
@RunWith(AndroidJUnit4::class)
class NativeUiPackInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private lateinit var original: CollectorConfig
    private lateinit var originalBinding: NativeUiBinding
    private var appearance = AppearancePreference.AUTO
    private var language = "system"
    private val themes = mutableListOf<NativeUiIdentity>()
    private val layouts = mutableListOf<NativeUiIdentity>()
    @Before fun fixture() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("nativeUiPackFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && QuickNotes.draft(context).read() == NoteDraft() && context.localSources().sources().isEmpty())
        original = settings.read(); originalBinding = NativeUiPacks.registry.activeBinding(); language = MoteI18n.preference()
        require(original.token.isBlank())
        appearance = MoteAppearance.preference(); instrumentation.runOnMainSync { MoteAppearance.select(context,AppearancePreference.DARK) }
        MoteI18n.select(context, "zh-CN")
        settings.save(original.copy(server = "", token = "", syncMode = "manual"), confirmCentralEndpoint = true)
        CentralSession.get(context).select("")
    }
    @After fun cleanup() {
        if (!::original.isInitialized) return
        instrumentation.runOnMainSync { NativeUiPacks.registry.bind(originalBinding) }
        themes.forEach(NativeUiPacks.registry::removeTheme); layouts.forEach(NativeUiPacks.registry::removeLayout)
        Settings(context).save(original, confirmCentralEndpoint = true)
        MoteI18n.select(context, language)
        instrumentation.runOnMainSync { MoteAppearance.select(context,appearance) }
    }
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    private fun visible(activity: Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun click(activity: Activity, text: String) = visible(activity).filterIsInstance<TextView>().first { it.isClickable && (it.text.toString() == MoteI18n.text(text) || it.contentDescription?.toString() == MoteI18n.text(text)) }.performClick()
    private fun <T : Activity> await(scenario: ActivityScenario<T>, description: String, check: (T) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20000
        while (SystemClock.elapsedRealtime() < deadline) {
            var ready = false; scenario.onActivity { ready = check(it) }; if (ready) return
            Thread.sleep(30)
        }
        var labels = ""; scenario.onActivity { labels = visible(it).filterIsInstance<TextView>().joinToString(" | ") { row -> row.text.toString() } }
        fail("$description: $labels | titleColor=" + run { var color = ""; scenario.onActivity { a -> color = visible(a).filterIsInstance<TextView>().filter { it.tag == "local-page-title" }.joinToString { "${it.currentTextColor}/${MoteTheme.ink} enabled=${it.isEnabled}" } }; color })
    }
    private fun variant(): NativeUiBinding {
        val suffix = UUID.randomUUID().toString()
        val theme = NativeThemeSnapshot(NativeUiIdentity("fixture.native.$suffix", "1"), NativeUiPacks.registry.theme().tokens + mapOf("background" to "#11202a", "ink" to "#dceef3", "primary-background" to "#cbe4c9", "primary-ink" to "#142515", "font" to "monospace", "control-height-mobile" to "56px"))
        val layout = NativeLayoutSnapshot(NativeUiIdentity("fixture.native.$suffix", "1"), listOf("home"), "home", "home", "stack")
        NativeUiPacks.registry.register(object : NativeThemeProvider { override val snapshot = theme })
        NativeUiPacks.registry.register(object : NativeLayoutProvider { override val snapshot = layout })
        themes.add(theme.identity); layouts.add(layout.identity)
        return NativeUiBinding(theme.identity, layout.identity)
    }
    private fun render(activity: Activity, name: String) {
        val root = activity.window.decorView
        assertTrue(root.width > 0 && root.height > 0)
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        try {
            root.draw(Canvas(bitmap))
            File(context.filesDir, "ui-packs/$name.png").apply { parentFile!!.mkdirs(); outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        } finally { bitmap.recycle() }
    }
    @Test fun lightHomeAndSecondaryDeepLinksKeepTheNativeOwnerWindow() {
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(visible(activity).any { it.tag == "home-record-action" })
                assertFalse(visible(activity).any { it.tag?.toString()?.startsWith("primary:") == true })
                assertEquals(Color.parseColor("#1c1b1a"), MoteTheme.background)
                render(activity, "home-default")
            }
            for (destination in listOf("资料与记忆", "设置")) {
                scenario.onActivity { activity -> activity.openGeneratedMenu(); visible(activity).single { it.tag == "menu:$destination" }.performClick() }
                scenario.onActivity { assertFalse(visible(it).any { row -> row.tag == "home-record-action" }); assertFalse(Settings(it).enabled) }
            }
            val sourceMonitor = instrumentation.addMonitor(SourcesActivity::class.java.name,null,false)
            try {
                scenario.onActivity { a -> a.openGeneratedMenu(); visible(a).single { it.tag == "menu:采集与同步" }.performClick() }
                val source = instrumentation.waitForMonitorWithTimeout(sourceMonitor,10_000) as SourcesActivity
                instrumentation.runOnMainSync { assertNotNull(source.window.decorView.findViewWithTag<View>("sources-add")); source.finish() }
            } finally { instrumentation.removeMonitor(sourceMonitor) }
            scenario.onActivity { it.openGeneratedHome() }
            scenario.recreate(); scenario.awaitMainUi()
            await(scenario, "The light home survives recreation") { visible(it).any { row -> row.tag == "home-record-action" } }
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "SOURCES")).awaitMainUi().use { scenario ->
            scenario.onActivity { assertTrue(visible(it).any { row -> row.tag == "local-back:SOURCES" }); assertFalse(visible(it).any { row -> row.tag == "home-record-action" }); render(it, "sources") }
        }
    }
    @Test fun liveThemeAndLayoutReplacementAndRemovalPreserveUnsavedSensitiveFieldsAndReturnPolicy() {
        val binding = variant()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "CONNECTION")).awaitMainUi().use { scenario ->
            var previous: MainActivity? = null
            scenario.onActivity { activity ->
                previous = activity
                visible(activity).single { it.tag == "connection-settings-toggle" }.performClick()
                visible(activity).filterIsInstance<EditText>().single { it.tag == "设备名称" }.setText("Generated unsaved name")
                visible(activity).filterIsInstance<EditText>().single { it.hint == "建议通过邀请获取本设备凭据" }.setText("generated-unsaved-token-1234567890")
                NativeUiPacks.registry.bind(binding)
            }
            await(scenario, "Active provider replacement preserves and restyles the real window") { activity -> activity === previous && (visible(activity).single { it.tag == "local-page-title" } as TextView).currentTextColor == MoteTheme.ink && visible(activity).filterIsInstance<EditText>().any { it.tag == "设备名称" && it.text.toString() == "Generated unsaved name" } }
            scenario.onActivity { activity ->
                assertEquals(emptyList<String>(), visible(activity).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }.map { it.text.toString() })
                assertTrue(visible(activity).any { it.tag == "local-back:CONNECTION" })
                assertEquals(Color.parseColor("#11202a"), (visible(activity).first { it is NativeAppShell }.background as ColorDrawable).color)
                assertEquals(Color.parseColor("#dceef3"), (visible(activity).single { it.tag == "local-page-title" } as TextView).currentTextColor)
                assertEquals("generated-unsaved-token-1234567890", visible(activity).filterIsInstance<EditText>().single { it.hint == "建议通过邀请获取本设备凭据" }.text.toString())
                assertEquals(original.deviceName, Settings(activity).read().deviceName)
                val save = visible(activity).filterIsInstance<Button>().single { it.text == "保存设置" }
                assertEquals(Color.parseColor("#142515"), save.currentTextColor); assertTrue(save.minimumHeight >= activity.moteDp(56))
                val pixels = Bitmap.createBitmap(save.width, save.height, Bitmap.Config.ARGB_8888)
                try { save.draw(Canvas(pixels)); assertEquals(Color.parseColor("#cbe4c9"), pixels.getPixel(save.width / 2, activity.moteDp(4))) } finally { pixels.recycle() }
                render(activity, "replacement-connection")
                visible(activity).single { it.tag == "local-back:CONNECTION" }.performClick()
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val dialog = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().single { it.isShown && it.text == "继续编辑" }
                assertTrue(dialog.performClick())
            }
            scenario.onActivity { activity -> previous = activity; NativeUiPacks.registry.removeTheme(binding.theme) }
            await(scenario, "Removing only the active theme restores builtin theme and retains layout and draft") { activity -> activity === previous && (visible(activity).single { it.tag == "local-page-title" } as TextView).currentTextColor == MoteTheme.ink && visible(activity).filterIsInstance<EditText>().any { it.tag == "设备名称" && it.text.toString() == "Generated unsaved name" } }
            scenario.onActivity { activity ->
                assertEquals(originalBinding.theme, NativeUiPacks.registry.activeBinding().theme); assertEquals(binding.layout, NativeUiPacks.registry.activeBinding().layout)
                assertEquals(emptyList<String>(), visible(activity).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }.map { it.text.toString() })
                assertEquals(Color.parseColor("#1c1b1a"), MoteTheme.background)
                previous = activity; NativeUiPacks.registry.removeLayout(binding.layout)
            }
            await(scenario, "Removing the layout keeps the secondary route without bringing back retired tabs") { activity -> activity === previous && visible(activity).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }.map { it.text.toString() } == emptyList<String>() && (visible(activity).single { it.tag == "local-page-title" } as TextView).currentTextColor == MoteTheme.ink && visible(activity).filterIsInstance<EditText>().any { it.tag == "设备名称" && it.text.toString() == "Generated unsaved name" } }
            scenario.onActivity { activity -> assertTrue(visible(activity).any { it.tag == "local-back:CONNECTION" }); assertEquals(originalBinding, NativeUiPacks.registry.activeBinding()); assertFalse(Settings(activity).enabled) }
        }
    }
    @Test fun actualWorkActivityReceiptsAndReadOnlyResultsSurviveRecreationWithoutChangingAskDraft() {
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("A generated real central fixture is required", args.getString("nativeUiOrigin") != null)
        val origin = requireNotNull(args.getString("nativeUiOrigin"))
        val owner = requireNotNull(args.getString("nativeUiOwner"))
        require(origin.startsWith("http://127.0.0.1:"))
        Settings(context).save(Settings(context).read().copy(server = origin, token = "", debugHttp = true, authSignedOut = false), confirmCentralEndpoint = true)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "ASK")).awaitMainUi().use { scenario ->
            await(scenario, "Native owner login") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "中央管理令牌" } }
            scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "中央管理令牌" }.setText(owner); click(activity, "登录并继续") }
            await(scenario, "Native Ask is ready") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "问一问" } }
            fun idle(activity: MainActivity): Boolean {
                val field = MainActivity::class.java.getDeclaredField("centralContent").apply { isAccessible = true }
                return (field.get(activity) as? CentralContent)?.isWorking == false
            }
            await(scenario, "Previous generated history finishes restoring") { idle(it) }
            await(scenario, "The conversation list owns the new-conversation entry") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "问一问" && row.isEnabled } }
            val question = "Generated UI pack work ${UUID.randomUUID()}"
            scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "问一问" }.setText(question); visible(activity).first { it.isClickable && it.contentDescription?.toString() == "发送" }.performClick() }
            await(scenario, "New conversation is ready through the native entry point") { idle(it) && visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" } }
            await(scenario, "Generated deterministic agent answer is actually archived") { idle(it) && visible(it).filterIsInstance<TextView>().any { row -> row.text.contains("Generated native answer") } && visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" && row.text.isEmpty() } }
            val draft = "Generated unsent Ask draft remains private"
            scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText(draft); activity.openMoteLocalPage("ACTIVITY") }
            await(scenario, "The primary Activity loads product receipts") { visible(it).filterIsInstance<TextView>().any { row -> row.isClickable && row.text == "最近完成" } }
            scenario.onActivity { click(it, "最近完成") }
            await(scenario, "Completed product work appears in Activity") { visible(it).filterIsInstance<TextView>().any { row -> row.text.toString() == question } }
            scenario.onActivity { activity ->
                render(activity, "work-activity")
                visible(activity).filterIsInstance<LinearLayout>().single { it.isClickable && it.contentDescription?.toString()?.startsWith(question + ". ") == true }.performClick()
            }
            await(scenario, "Work details are distinct from technical operations") { visible(it).filterIsInstance<Spinner>().any { row -> row.contentDescription == "工作详情" } }
            scenario.onActivity { activity ->
                val sections = visible(activity).filterIsInstance<Spinner>().single { it.contentDescription == "工作详情" }
                sections.setSelection((0 until sections.adapter.count).single { sections.adapter.getItem(it).toString() == "成果" })
            }
            await(scenario, "Saved product result is available") { visible(it).filterIsInstance<Button>().any { row -> row.text == "查看成果" } }
            scenario.recreate(); scenario.awaitMainUi()
            await(scenario, "Activity detail selection and result section restore by origin") { visible(it).filterIsInstance<Button>().any { row -> row.text == "查看成果" } }
            scenario.onActivity { click(it, "查看成果") }
            await(scenario, "Actual saved conversation opens read-only") { visible(it).filterIsInstance<TextView>().any { row -> row.text.contains("Generated native answer") } }
            scenario.onActivity { activity -> render(activity, "work-result"); activity.openGeneratedHome(); visible(activity).single { it.tag == "home-ask-action" }.performClick() }
            await(scenario, "Returning to Ask shows the conversation list") { visible(it).any { row -> row.contentDescription?.toString()?.startsWith(question) == true } }
            scenario.onActivity { activity -> visible(activity).single { row -> row.contentDescription?.toString()?.startsWith(question) == true }.performClick() }
            await(scenario, "Returning to Ask preserves the separate unsent draft") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" && row.text.toString() == draft } }
            val binding = variant()
            var old: MainActivity? = null
            scenario.onActivity { old = it; NativeUiPacks.registry.bind(binding) }
            await(scenario, "Live provider replacement preserves Ask, owner session and draft") { activity -> activity === old && visible(activity).filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }.map { it.text.toString() } == emptyList<String>() && visible(activity).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" && row.text.toString() == draft } }
            scenario.onActivity { assertTrue(visible(it).any { row -> row.contentDescription == "返回上级" }); assertFalse(Settings(it).enabled); render(it, "replacement-ask") }
        }
        CentralSession.get(context).signOut()
    }
    @Test fun existingWorkIsReachableFromTheSecondaryCentralMenuAndReturnsToTheDraft() {
        val args=InstrumentationRegistry.getArguments(); val origin=requireNotNull(args.getString("nativeUiOrigin")); val owner=requireNotNull(args.getString("nativeUiOwner"))
        require(origin.startsWith("http://127.0.0.1:"))
        Settings(context).save(Settings(context).read().copy(server=origin,token="",debugHttp=true,authSignedOut=false),confirmCentralEndpoint=true)
        CentralSession.get(context).select(origin); CentralSession.get(context).signIn(origin,owner)
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","ASK")).awaitMainUi().use { scenario ->
            await(scenario,"Ask ready") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" && row.isEnabled } }
            val monitor=instrumentation.addMonitor(CentralActivity::class.java.name,null,false)
            try {
                scenario.onActivity { a -> visible(a).filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated draft before Activity"); a.openGeneratedMenu(); visible(a).single { it.tag == "menu:中央工作台" }.performClick() }
                val central=instrumentation.waitForMonitorWithTimeout(monitor,10_000) as CentralActivity
                fun ready(label:String,check:()->Boolean) { val until=SystemClock.elapsedRealtime()+20_000; while(SystemClock.elapsedRealtime()<until) { var done=false; instrumentation.runOnMainSync { done=check() }; if(done)return; Thread.sleep(40) }; fail(label) }
                ready("Central overview loaded") { !central.isWorking && visible(central).filterIsInstance<TextView>().any { it.isClickable && it.text.toString() == "更多" } }
                instrumentation.runOnMainSync { click(central,"更多") }
                fun menu(label: String) { instrumentation.runOnMainSync {
                    val list=android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<android.widget.ListView>().single { it.isShown }
                    val index=(0 until list.adapter.count).single { list.adapter.getItem(it).toString() == label }
                    list.performItemClick(list.getChildAt(index),index,list.adapter.getItemId(index))
                } }
                menu("首页"); menu("活动")
                ready("Existing work list loads through its visible menu") { !central.isWorking && visible(central).filterIsInstance<TextView>().any { it.text.toString() == "最近完成" && it.isClickable } }
                instrumentation.runOnMainSync { render(central,"activity-secondary-menu"); visible(central).single { it.contentDescription == "返回上级" }.performClick() }
                ready("Native header returns to Central overview") { !central.isWorking && visible(central).filterIsInstance<TextView>().any { it.text.toString() == "中央工作台" } }
                instrumentation.runOnMainSync { central.finish() }
            } finally { instrumentation.removeMonitor(monitor) }
            scenario.onActivity { a -> a.openGeneratedHome(); visible(a).single { it.tag == "home-ask-action" }.performClick() }
            await(scenario,"Back returns to the same Ask draft") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "你的问题" && row.text.toString() == "Generated draft before Activity" } }
        }
        CentralSession.get(context).signOut()
    }
    @Test fun liveBindingsPreserveCentralSourceEditorsSettingsAndSecretFieldsWithoutSaving() {
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("A generated real central fixture is required", args.getString("nativeUiOrigin") != null)
        val origin = requireNotNull(args.getString("nativeUiOrigin")); val owner = requireNotNull(args.getString("nativeUiOwner"))
        require(origin.startsWith("http://127.0.0.1:"))
        val api = CentralClient(origin, owner)
        val sourceId = "generated-ui-pack-${UUID.randomUUID()}"
        val sourceName = "Generated source editor $sourceId"
        api.post("/api/sources", org.json.JSONObject().put("id", sourceId).put("name", sourceName).put("kind", "local-files").put("deviceId", "generated-ui-pack-phone").put("platform", "import").put("retention", "archive"))
        Settings(context).save(Settings(context).read().copy(server = origin, token = "", debugHttp = true, authSignedOut = false), confirmCentralEndpoint = true)
        ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "sources")).use { scenario ->
            await(scenario, "Native central login") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "中央管理令牌" } }
            scenario.onActivity { activity -> visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "中央管理令牌" }.setText(owner); click(activity, "登录并继续") }
            await(scenario, "The generated source is ready") { visible(it).filterIsInstance<TextView>().any { row -> row.text.toString() == sourceName } }
            var originalActivity: CentralActivity? = null
            lateinit var sourceField: EditText
            lateinit var retention: Spinner
            lateinit var enabled: android.widget.CheckBox
            val firstBinding = variant()
            scenario.onActivity { activity ->
                originalActivity = activity
                val card = visible(activity).filterIsInstance<TextView>().single { it.text.toString() == sourceName }.parent as LinearLayout
                views(card).filterIsInstance<Button>().single { it.text == "编辑来源" }.performClick()
                sourceField = views(card).filterIsInstance<EditText>().single { it.contentDescription == "名称" }
                retention = views(card).filterIsInstance<Spinner>().single { it.adapter.count == 3 && it.adapter.getItem(0).toString() == "archive" }
                enabled = views(card).filterIsInstance<android.widget.CheckBox>().single { it.text == "启用" }
                sourceField.setText("Generated unsaved central source"); sourceField.requestFocus(); sourceField.setSelection(3, 9); retention.setSelection(2); enabled.isChecked = false
                NativeUiPacks.registry.bind(firstBinding)
            }
            await(scenario, "The same central source editor consumes the selected theme") { activity -> activity === originalActivity && (visible(activity).single { it.tag == "central-title" } as TextView).currentTextColor == Color.parseColor("#dceef3") }
            scenario.onActivity { activity ->
                assertSame(sourceField, visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "名称" })
                assertEquals("Generated unsaved central source", sourceField.text.toString()); assertEquals(2, retention.selectedItemPosition); assertFalse(enabled.isChecked)
                assertTrue(sourceField.hasFocus()); assertEquals(3, sourceField.selectionStart); assertEquals(9, sourceField.selectionEnd)
                render(activity, "central-source-preserved")
                NativeUiPacks.registry.removeTheme(firstBinding.theme)
            }
            await(scenario, "Active removal restores the native theme in the same central editor") { activity -> activity === originalActivity && (visible(activity).single { it.tag == "central-title" } as TextView).currentTextColor == MoteTheme.ink }
            scenario.onActivity { activity ->
                assertSame(sourceField, visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "名称" }); assertEquals("Generated unsaved central source", sourceField.text.toString()); assertEquals(2, retention.selectedItemPosition)
                assertTrue(visible(activity).filterIsInstance<TextView>().any { it.tag == "native-presentation-notice" && it.text == "界面扩展已移除，已恢复内置方案。" })
                NativeUiPacks.registry.removeLayout(firstBinding.layout)
            }
            val sources = api.get("/api/sources").getJSONArray("items")
            val unchanged = (0 until sources.length()).map(sources::getJSONObject).single { it.getString("id") == sourceId }
            assertEquals(sourceName, unchanged.getString("name")); assertEquals("archive", unchanged.getString("retention")); assertTrue(unchanged.getBoolean("enabled"))
            val executionBefore = api.get("/api/execution-settings")
            scenario.onActivity { it.navigate("settings") }
            await(scenario, "Central settings") { visible(it).filterIsInstance<Button>().any { row -> row.text == "并发与执行设置" } }
            scenario.onActivity { click(it, "并发与执行设置") }
            await(scenario, "Editable concurrency form") { visible(it).filterIsInstance<EditText>().isNotEmpty() && !it.isWorking }
            lateinit var executionField: EditText
            val secondBinding = variant()
            scenario.onActivity { activity -> executionField = visible(activity).filterIsInstance<EditText>().first(); executionField.setText("17"); NativeUiPacks.registry.bind(secondBinding) }
            await(scenario, "Settings form consumes replacement without reopening its route") { (visible(it).single { row -> row.tag == "central-title" } as TextView).currentTextColor == Color.parseColor("#dceef3") }
            scenario.onActivity { activity -> assertSame(executionField, visible(activity).filterIsInstance<EditText>().first()); assertEquals("17", executionField.text.toString()); NativeUiPacks.registry.removeTheme(secondBinding.theme); NativeUiPacks.registry.removeLayout(secondBinding.layout) }
            assertEquals(executionBefore.getInt("interactiveConcurrency"), api.get("/api/execution-settings").getInt("interactiveConcurrency"))
            val models = api.get("/api/model-settings"); val copiedId = "generated-ui-pack-${UUID.randomUUID()}"
            val copiedName = "Generated editable UI provider $copiedId"
            api.post("/api/model-settings/profiles/" + models.getJSONArray("profiles").getJSONObject(0).getString("id") + "/copy", org.json.JSONObject().put("revision", models.getLong("revision")).put("id", copiedId).put("name", copiedName).put("includeCredentials", false))
            scenario.onActivity { it.navigate("settings") }
            await(scenario, "Model settings entrance") { visible(it).filterIsInstance<Button>().any { row -> row.text == "模型配置" } }
            scenario.onActivity { click(it, "模型配置") }
            await(scenario, "Model profile selector") { visible(it).filterIsInstance<Spinner>().any { row -> row.contentDescription == "Provider 预设" } }
            scenario.onActivity { activity -> visible(activity).filterIsInstance<Spinner>().single { it.contentDescription == "Provider 预设" }.let { spinner -> spinner.setSelection((0 until spinner.adapter.count).single { spinner.adapter.getItem(it).toString() == copiedName }) } }
            await(scenario, "Copied profile edit action") { visible(it).filterIsInstance<Button>().any { row -> row.text == "编辑" } }
            scenario.onActivity { click(it, "编辑") }
            await(scenario, "Private API key field") { visible(it).filterIsInstance<EditText>().any { row -> row.contentDescription == "API Key（留空保留）" } }
            lateinit var secret: EditText
            val thirdBinding = variant()
            scenario.onActivity { activity -> secret = visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "API Key（留空保留）" }; secret.setText("generated-private-unsaved-key"); NativeUiPacks.registry.bind(thirdBinding) }
            await(scenario, "Secret form consumes new theme in place") { (visible(it).single { row -> row.tag == "central-title" } as TextView).currentTextColor == Color.parseColor("#dceef3") }
            scenario.onActivity { activity -> assertSame(secret, visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "API Key（留空保留）" }); assertEquals("generated-private-unsaved-key", secret.text.toString()); NativeUiPacks.registry.removeTheme(thirdBinding.theme); NativeUiPacks.registry.removeLayout(thirdBinding.layout) }
            scenario.onActivity { activity -> assertSame(secret, visible(activity).filterIsInstance<EditText>().single { it.contentDescription == "API Key（留空保留）" }); assertEquals("generated-private-unsaved-key", secret.text.toString()) }
        }
        CentralSession.get(context).signOut()
    }
}
