package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.DocumentsContract
import android.view.View
import android.view.ViewGroup
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

/** Generated files and native task entry points omitted from the eight shared core roles. */
@RunWith(AndroidJUnit4::class)
class UiInventoryRolloutInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun text(activity: Activity) = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (!condition()) { assertTrue("Actual $label must be ready", SystemClock.elapsedRealtime() < deadline); Thread.sleep(50) }
        instrumentation.waitForIdleSync()
    }

    @Test fun generatedFilesSourceEditingLegacyNavigationAndRuleDialogsAreReady() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("uiIterationFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        val variant = args.getString("uiIterationVariant", "default")!!
        MoteI18n.select(context, if (variant.contains("english")) "en" else "zh-CN")
        val settings = Settings(context); settings.enabled = false
        settings.save(settings.read().copy(server = "", token = "", syncMode = "manual"), confirmCentralEndpoint = true)
        val directory = File(context.filesDir, "ui-iterations/round-rollout" + if (variant == "default") "" else "/$variant").apply { mkdirs() }
        fun render(name: String, intent: Intent, marker: String) {
            ActivityScenario.launch<Activity>(intent).use { scenario ->
                waitFor(name) { var ready = false; scenario.onActivity { ready = GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) && text(it).contains(MoteI18n.text(marker)) }; ready }
                scenario.onActivity { activity ->
                    if (name in setOf("rollout-file-task-settings", "rollout-folder-task-settings"))
                        assertFalse("Saved source configuration has no unrelated record action", views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") })
                    if (name == "rollout-file-original") {
                        val original = views(activity.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "Generated original 中文.\nAn archive preserves the original evidence.\n" }
                        assertEquals("Literal originals use the shared reading ink", MoteUi.ink, original.currentTextColor)
                    }
                    if (name in setOf("rollout-populated-sources", "rollout-populated-sources-active")) {
                        val buttons = views(activity.window.decorView).filterIsInstance<Button>().filter { it.isShown }
                        val resume = buttons.filter { it.text.toString() == MoteI18n.text("恢复这个来源") }
                        val pause = buttons.filter { it.text.toString() == MoteI18n.text("暂停这个来源") }
                        assertEquals(if (name == "rollout-populated-sources") 1 else 0, resume.size)
                        assertEquals(if (name == "rollout-populated-sources") 0 else 1, pause.size)
                        resume.forEach { assertEquals(true, it.getTag(R.id.mote_primary)); assertEquals(android.graphics.Color.WHITE, it.currentTextColor) }
                        pause.forEach { assertEquals(false, it.getTag(R.id.mote_primary)); assertEquals(MoteUi.accent, it.currentTextColor) }
                    }
                    GeneratedWindowRendering.save(activity, directory, name)
                    File(directory, "$name.txt").writeText(text(activity).joinToString("\n"))
                    assertFalse(settings.enabled)
                }
                if (args.getString("uiScrollEvidence") == "true" && name in setOf("rollout-folder-task", "rollout-file-task-settings", "rollout-folder-task-settings")) {
                    scenario.onActivity { activity ->
                        assertTrue(views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.text.toString() == MoteI18n.text("高级设置") }.performClick())
                    }
                    instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        val state = "advanced-$name"
                        val target = File(context.filesDir, "ui-state-evidence/$variant/$state").apply { mkdirs() }
                        GeneratedWindowRendering.save(activity, target, name)
                        val metadata = File(target, "$name.json")
                        metadata.writeText(org.json.JSONObject(metadata.readText()).put("supplementState", state).put("automaticVisualAcceptance", false).toString(2))
                        assertFalse(settings.enabled)
                    }
                }
            }
        }
        render("rollout-legacy-sources", Intent(context, MainActivity::class.java).putExtra("page", "SOURCES"), "已支持的来源")
        render("rollout-folder-task", Intent(context, FileTaskActivity::class.java).putExtra("addAction", "FOLDER"), "收集哪些文件")
        val run = "ui-rollout-${System.nanoTime()}"
        val generated = File(context.filesDir, "generated-file-sync/$run").apply { mkdirs() }
        File(generated, "generated-note.txt").writeText("Generated original 中文.\nAn archive preserves the original evidence.\n")
        val uri = DocumentsContract.buildDocumentUri(context.packageName + ".file-fixtures", "$run/generated-note.txt")
        val source = LocalSource(name = "Generated file source", kind = "local-files", uri = uri.toString(), enabled = false,
            syncContinuously = false, centralProcessingConsent = true, extensions = "txt", description = "Generated source description\nThe original file belongs to this generated source.")
        val folder = source.copy(id = java.util.UUID.randomUUID().toString(), name = "Generated folder source", tree = true,
            uri = DocumentsContract.buildTreeDocumentUri(context.packageName + ".file-fixtures", run).toString(), syncContinuously = true)
        val store = context.localSources()
        try {
            store.save(source); store.save(folder)
            render("rollout-file-task-settings", Intent(context, FileTaskActivity::class.java).putExtra("sourceId", source.id), "文件来源设置")
            render("rollout-folder-task-settings", Intent(context, FileTaskActivity::class.java).putExtra("sourceId", folder.id), "文件来源设置")
            render("rollout-populated-sources", Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id), "Generated file source")
            store.save(source.copy(enabled = true))
            try { render("rollout-populated-sources-active", Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id), "Generated file source") }
            finally { store.save(source) }
            assertTrue(FileSources(context).scan(source))
            assertNotNull(FileSources(context).prepare(source))
            render("rollout-file-original", Intent(context, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", uri.toString()), "原文与出处")
            ActivityScenario.launch<FileContentActivity>(Intent(context, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", uri.toString())).use { scenario ->
                waitFor("literal generated file") { var ready = false; scenario.onActivity { ready = text(it).contains("Generated original 中文.\nAn archive preserves the original evidence.\n") }; ready }
            }
        } finally { store.remove(source.id); store.remove(folder.id); context.fileArchives().remove(source.id); context.fileArchives().remove(folder.id); generated.deleteRecursively() }
        render("rollout-file-unavailable", Intent(context, FileContentActivity::class.java).putExtra("sourceId", "generated-missing-source").putExtra("externalId", "generated-missing-file"), "内容暂不可读取，原数据保留。")
        @Suppress("DEPRECATION") val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName!!
        settings.save(settings.read().copy(uiPageRules = AppPageSetup.fieldRule(context.packageName, version, "article", mapOf("title" to "generated:id/title", "body" to "generated:id/body")),
            appCollectionRules = AppCollectionRules(AppCollectionMode.ACTIVITY, mapOf(context.packageName to AppCollectionMode.CONTENT)).json()))
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "PRIVACY")).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                views(activity.window.decorView).filterIsInstance<Button>().single { it.isShown && it.contentDescription?.toString()?.contains(context.packageName) == true }.performClick()
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val dialog = android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.findViewById<View>(android.R.id.button2)?.isShown == true }
                GeneratedWindowRendering.save(activity, directory, "rollout-app-rule-detail", listOf(dialog))
                views(dialog).filterIsInstance<Button>().single { it.text.toString() == MoteI18n.text("配置当前版本的文章或商品字段") }.performClick()
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val dialog = android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.findViewById<View>(android.R.id.button1)?.isShown == true }
                GeneratedWindowRendering.save(activity, directory, "rollout-app-rule-edit", listOf(dialog))
                assertTrue(dialog.findViewById<View>(android.R.id.button2).performClick())
            }
            instrumentation.waitForIdleSync()
            scenario.onActivity {
                android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.findViewById<View>(android.R.id.button2)?.isShown == true }
                    .findViewById<View>(android.R.id.button2).performClick()
            }
        }
    }
}
