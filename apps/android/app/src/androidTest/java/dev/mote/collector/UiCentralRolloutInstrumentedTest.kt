package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real owner login and central APIs, backed only by scripts/android-central-fixture.ts. */
@RunWith(AndroidJUnit4::class)
class UiCentralRolloutInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun labels(activity: CentralActivity) = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
    private fun waitFor(scenario: ActivityScenario<CentralActivity>, label: String, predicate: (CentralActivity) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        var ready = false
        while (!ready && SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity { ready = predicate(it) }
            if (!ready) Thread.sleep(50)
        }
        assertTrue("Actual central $label must finish loading", ready)
        instrumentation.waitForIdleSync()
    }

    @Test fun generatedOwnerPagesHaveReadyContentAndKeepNativeRolesAcrossLanguageAndWidth() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit generated central loopback required", args.getString("nativeCentralFixture") == "true" && args.getString("uiIterationFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        val variant = args.getString("uiIterationVariant", "default")!!
        MoteI18n.select(context, if (variant.contains("english")) "en" else "zh-CN")
        Settings(context).enabled = false
        CentralSession.get(context).select("")
        val settings = Settings(context)
        settings.save(settings.read().copy(server = "http://127.0.0.1:47883", token = "", debugHttp = true,
            authSignedOut = false, authExpiresAt = 0, authProcess = "", syncMode = "manual"), confirmCentralEndpoint = true)
        val directory = File(context.filesDir, "ui-central-rollout/$variant").apply { mkdirs() }
        ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "overview")).use { scenario ->
            waitFor(scenario, "login") { labels(it).contains(MoteI18n.text("登录并继续")) }
            scenario.onActivity { activity ->
                views(activity.window.decorView).filterIsInstance<EditText>().single { it.isShown && it.contentDescription == MoteI18n.text("中央管理令牌") }
                    .setText("generated-native-central-owner-token-123456")
                assertTrue(views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == MoteI18n.text("登录并继续") }.performClick())
            }
            waitFor(scenario, "owner session") { it.client != null && !it.isWorking && !labels(it).contains(MoteI18n.text("登录并继续")) }
            for ((page, titleKey) in CentralScreens.pages) {
                scenario.onActivity { it.navigate(page) }
                waitFor(scenario, page) { activity ->
                    activity.client != null && !activity.isWorking && GeneratedWindowRendering.hasNoPendingLabels(activity.window.decorView) &&
                        (views(activity.window.decorView).single { it.tag == "central-title" } as TextView).text.toString() == MoteI18n.text(titleKey)
                }
                scenario.onActivity { activity ->
                    val root = activity.window.decorView
                    assertTrue(root.isShown && root.width > 0 && root.height > 0)
                    assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                    assertFalse("$page is native", views(root).any { it is WebView })
                    assertEquals("$page API work completed without errors", "", (views(root).single { it.tag == "central-status" } as TextView).text.toString())
                    assertFalse("$page reuses the verified owner session", labels(activity).contains(MoteI18n.text("登录并继续")))
                    val title = views(root).single { it.tag == "central-title" }
                    val bounds = android.graphics.Rect()
                    assertTrue(title.getGlobalVisibleRect(bounds)); assertEquals(title.width, bounds.width()); assertEquals(title.height, bounds.height())
                    assertTrue("$page renders actual content or its real empty state", views(views(root).single { it.tag == "central-body" }).filterIsInstance<TextView>().any { it.text.isNotBlank() })
                    if (!MoteNavigation.centralAllowsAdd(page)) assertFalse(views(root).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") })
                    for (button in views(root).filterIsInstance<Button>().filter { it.isShown }) {
                        if (button.getGlobalVisibleRect(bounds)) assertEquals("$page control fits horizontally: ${button.text}", button.width, bounds.width())
                    }
                    when (page) {
                        "overview" -> assertTrue("Generated fixture has a configured model", labels(activity).contains(MoteI18n.text("模型已配置")))
                        "files" -> assertTrue("The fixture has no file uploads and shows the actual empty state", labels(activity).contains(MoteI18n.text("当前范围内暂无条目。没有列出不代表不存在。")))
                        "notes" -> assertTrue("The existing native editor remains reachable from Central notes", views(root).filterIsInstance<Button>().any { it.text.toString() == MoteI18n.text("记下") && it.isEnabled })
                    }
                    GeneratedWindowRendering.save(activity, directory, "rollout-central-$page")
                    File(directory, "$page.txt").writeText(labels(activity).joinToString("\n"))
                    assertFalse(settings.enabled)
                }
            }
            if (args.getString("uiScrollEvidence") == "true") {
                fun click(key: String) {
                    waitFor(scenario, "control $key") { activity -> !activity.isWorking && views(activity.window.decorView).filterIsInstance<Button>().any {
                        it.isShown && it.text.toString() == MoteI18n.text(key)
                    } }
                    scenario.onActivity { activity ->
                        assertTrue(views(activity.window.decorView).filterIsInstance<Button>().single {
                            it.isShown && it.text.toString() == MoteI18n.text(key)
                        }.performClick())
                    }
                    waitFor(scenario, key) { !it.isWorking && GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) }
                }
                val forms = listOf(
                    "models-provider" to listOf("模型配置"),
                    "models-defaults" to listOf("模型配置", "功能默认模型"),
                    "models-copy" to listOf("模型配置", "复制为新预设"),
                    "execution-settings" to listOf("并发与执行设置"),
                    "processing-settings" to listOf("处理设置"),
                    "memory-automatic" to listOf("记忆设置", "记忆自动处理"),
                    "memory-extraction-recipe" to listOf("记忆设置", "记忆提取配方"),
                    "memory-consolidation-recipe" to listOf("记忆设置", "记忆整合"),
                    "external-applications" to listOf("来源与外部应用")
                )
                for ((state, steps) in forms) {
                    scenario.onActivity { it.navigate("settings") }
                    waitFor(scenario, "settings for $state") { !it.isWorking && labels(it).contains(MoteI18n.text("模型配置")) }
                    steps.forEach(::click); instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        val target = File(context.filesDir, "ui-state-evidence/$variant/central-$state").apply { mkdirs() }
                        GeneratedWindowRendering.save(activity, target, "rollout-central-settings")
                        val metadata = File(target, "rollout-central-settings.json")
                        metadata.writeText(org.json.JSONObject(metadata.readText()).put("supplementState", "central-$state")
                            .put("automaticVisualAcceptance", false).toString(2))
                        assertFalse(settings.enabled)
                    }
                }
            }
        }
    }
}
