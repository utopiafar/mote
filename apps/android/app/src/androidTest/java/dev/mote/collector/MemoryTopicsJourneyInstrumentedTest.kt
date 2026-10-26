package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in generated HTTP fixture; never a personal node, source or live model. */
@RunWith(AndroidJUnit4::class)
class MemoryTopicsJourneyInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val origin = "http://127.0.0.1:" + (InstrumentationRegistry.getArguments().getString("topicsPort") ?: "47894")
    private val owner = "generated-native-topics-owner-token"
    private val api get() = CentralClient(origin, owner)
    private lateinit var fixture: JSONObject
    @Before fun prepare() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("topicsFixture") == "true")
        assertTrue(Build.MODEL.contains("sdk", true) || Build.FINGERPRINT.contains("emulator", true)); assertEquals("dev.mote.collector.dev", context.packageName)
        fixture = api.post("/api/__fixture/reset", JSONObject())
        val settings = Settings(context); settings.enabled = false
        settings.save(settings.read().copy(server = origin, token = "", debugHttp = true, authSignedOut = false, authExpiresAt = 0, authProcess = ""), confirmCentralEndpoint = true)
        CentralSession.get(context).select(origin); CentralSession.get(context).signIn(origin, owner)
        java.io.File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(origin)).deleteRecursively()
        MoteI18n.select(context, "zh-CN")
    }
    private fun <T> main(job: () -> T): T { var value: T? = null; instrumentation.runOnMainSync { value = job() }; @Suppress("UNCHECKED_CAST") return value as T }
    private fun activity(): Activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single()
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown() = views(activity().window.decorView).filter { it.isShown }
    private fun text(value: String) = shown().filterIsInstance<TextView>().any { it.text.toString() == value }
    private fun until(label: String, test: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 25000
        while (System.currentTimeMillis() < deadline) { if (runCatching(test).getOrDefault(false)) return; Thread.sleep(75) }
        fail(label + ": " + main { shown().filterIsInstance<TextView>().joinToString(" | ") { it.text.toString() } })
    }
    private fun settled() = (activity() as? CentralActivity)?.isWorking != true
    private fun click(label: String) { until(label) { main { settled() && shown().filterIsInstance<TextView>().any { it.text.toString() == label && it.isClickable && it.isEnabled } } }; main { shown().filterIsInstance<TextView>().first { it.text.toString() == label && it.isClickable && it.isEnabled }.performClick() } }
    private fun clickTag(tag: String) { until(tag) { main { settled() && shown().any { it.tag == tag && it.isEnabled } } }; main { shown().single { it.tag == tag }.performClick() } }
    private fun back() { instrumentation.uiAutomation.executeShellCommand("input keyevent 4").close() }
    private fun open() = ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "memories"))
    private fun capture(name: String) = main {
        val root = activity().window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            root.draw(android.graphics.Canvas(bitmap))
            java.io.File(context.getExternalFilesDir(null), "topic-journeys").apply { mkdirs() }.resolve("$name.png")
                .outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun state() = api.get("/api/__fixture/state")

    private fun chooseTree(label: String) {
        until("tree selector") { main { settled() && shown().filterIsInstance<android.widget.Spinner>().any { it.contentDescription.toString() == "浏览维度" } } }
        main { val spinner = shown().filterIsInstance<android.widget.Spinner>().single { it.contentDescription.toString() == "浏览维度" }; val index = (0 until spinner.adapter.count).single { spinner.adapter.getItem(it).toString() == label }; spinner.setSelection(index) }
        click("浏览维度")
    }
    private fun members() = shown().count { it.tag?.toString()?.startsWith("topic-memory:") == true }
    private fun topic(node: String, tree: String = "treeOne") = clickTag("memory-topic:" + fixture.getString(tree) + ":" + node)
    @Test fun sameMemoryAcrossTreesRetainsDetailsOriginalReturnAndRecreation() {
        open().use {
            chooseTree("合成项目"); topic("review")
            until("one exact member") { main { settled() && members() == 1 } }
            clickTag("topic-memory:" + fixture.getString("firstMemory"))
            until("actual memory detail") { main { settled() && text("Synthetic topic memory 0") && text("查看原文依据 1") } }
            val before = main { activity() }; main { before.recreate() }
            until("same selected memory after Activity recreation") { main { activity() !== before && settled() && text("查看原文依据 1") && text("Synthetic topic memory 0") } }
            capture("detail-restored")
            click("查看原文依据 1"); until("actual original") { main { settled() && text("Synthetic native topic original 0") && text("基于这条记录提问") } }
            capture("original"); back(); until("back to same memory") { main { settled() && text("查看原文依据 1") } }
            back(); until("back to exact topic") { main { settled() && members() == 1 && text("合成复核") } }
            chooseTree("合成实践"); topic("reuse", "treeTwo")
            until("same ID in second tree") { main { settled() && shown().any { it.tag == "topic-memory:" + fixture.getString("firstMemory") } } }
            capture("second-tree")
        }
    }
    @Test fun paginationAndRecreationPreserveCursorAndInvalidationClearsOldLabels() {
        open().use {
            chooseTree("合成项目"); topic("planning")
            until("first page thirty") { main { settled() && members() == 30 } }
            click("下一页"); until("second page two") { main { settled() && members() == 2 } }
            val before = main { activity() }; main { before.recreate() }
            until("cursor restored") { main { activity() !== before && settled() && members() == 2 && text("上一页") } }
            click("上一页"); until("back first page") { main { settled() && members() == 30 } }
            api.post("/api/__fixture/invalidate", JSONObject())
            until("whole derived batch disappears") { main { settled() && text("此主题已不可用，请返回全部记忆。") && members() == 0 && !text("合成计划") } }
            capture("invalidated"); click("全部记忆"); until("existing memory still readable") { main { settled() && members() > 0 } }
        }
    }
    @Test fun emptyStateAndUnsavedCorrectionReturnDoNotCreateFacts() {
        open().use {
            chooseTree("合成项目"); topic("review")
            clickTag("topic-memory:" + fixture.getString("firstMemory"))
            until("editable detail") { main { settled() && text("保存校正") } }
            main { shown().filterIsInstance<EditText>().first().setText("UNSAVED synthetic correction") }
            api.post("/api/__fixture/mode", JSONObject().put("mode", "offline"))
            until("poll error preserves draft") { main { settled() && text("UNSAVED synthetic correction") && text("保存校正") } }
            // Wait for an actual scheduled poll, not merely the pre-poll state.
            Thread.sleep(5500)
            assertTrue(main { text("UNSAVED synthetic correction") && text("保存校正") })
            api.post("/api/__fixture/mode", JSONObject().put("mode", "online")); back()
            until("cancel returns to same topic") { main { settled() && members() == 1 } }
            assertFalse(api.get("/api/memories/" + fixture.getString("firstMemory")).getString("statement").contains("UNSAVED"))
            api.post("/api/__fixture/empty", JSONObject()); click("全部记忆")
            until("empty list") { main { settled() && members() == 0 && text("当前筛选下没有匹配的记忆。可切换内容分类或调整筛选条件。") } }
            capture("empty")
        }
    }
    @Test fun allMemoriesDetailDisappearsWhenOnlySelectedMemoryIsDeletedOrDenied() {
        for (change in listOf("delete", "deny", "version")) {
            if (change != "delete") fixture = api.post("/api/__fixture/reset", JSONObject())
            open().use {
                click("下一页")
                clickTag("topic-memory:" + fixture.getString("firstMemory"))
                until("selected detail") { main { settled() && text("查看原文依据 1") } }
                main { shown().filterIsInstance<EditText>().first().setText("UNSAVED owner edit") }
                when (change) {
                    "delete" -> api.post("/api/__fixture/invalidate", JSONObject())
                    "deny" -> api.post("/api/__fixture/detail-mode", JSONObject().put("mode", "denied"))
                    else -> {
                        val row = api.get("/api/memories/" + fixture.getString("firstMemory"))
                        api.post("/api/memories/" + fixture.getString("firstMemory") + "/correct", JSONObject().put("version", row.getInt("version")).put("title", "Synthetic replacement").put("statement", "Synthetic updated statement").put("uncertainty", "Fixture only"))
                    }
                }
                until("invalid selected detail clears despite available directory") { main { settled() && !text("查看原文依据 1") && !text("保存校正") && !text("Synthetic topic memory 0") } }
                if (change == "version") Thread.sleep(6000)
                assertTrue(main { text("UNSAVED owner edit") && text("有未保存的更改") })
                assertTrue(api.get("/api/context-trees").getJSONArray("items").length() > 0)
            }
        }
    }
    @Test fun lateOriginalCannotRestoreWithdrawnMemoryContent() {
        open().use {
            click("下一页"); clickTag("topic-memory:" + fixture.getString("firstMemory"))
            until("selected detail") { main { settled() && text("查看原文依据 1") } }
            api.post("/api/__fixture/hold-original", JSONObject()); click("查看原文依据 1")
            until("original response held") { state().optBoolean("held") }
            api.post("/api/__fixture/invalidate", JSONObject()); api.post("/api/__fixture/release-detail", JSONObject())
            until("withdrawn original and detail cleared") { main { settled() && !text("查看原文依据 1") && !text("保存校正") && !text("Synthetic native topic original 0") } }
        }
    }
    @Test fun offlineAndDeniedReadsClearOldMembersAndRetryActualNativeRoute() {
        open().use {
            chooseTree("合成项目"); topic("review"); until("selected member") { main { settled() && members() == 1 } }
            api.post("/api/__fixture/mode", JSONObject().put("mode", "offline"))
            until("offline state") { main { settled() && text("重试") && members() == 0 } }; capture("offline")
            api.post("/api/__fixture/mode", JSONObject().put("mode", "online")); click("重试")
            until("same selection after retry") { main { settled() && members() == 1 } }
            api.post("/api/__fixture/mode", JSONObject().put("mode", "denied"))
            until("denied content cleared") { main { settled() && text("重试") && members() == 0 && !text("合成复核") } }; capture("denied")
            api.post("/api/__fixture/mode", JSONObject().put("mode", "online")); click("重试")
            until("explicit retry recovers") { main { settled() && members() == 1 } }
        }
    }
}
