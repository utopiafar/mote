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
class DiscoveryJourneyInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val origin = "http://127.0.0.1:" + (InstrumentationRegistry.getArguments().getString("discoveryPort") ?: "47886")
    private val owner = "generated-native-discovery-owner-token"
    private val api get() = CentralClient(origin, owner)
    private lateinit var fixture: JSONObject
    @Before fun prepare() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("discoveryFixture") == "true")
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
    private fun open(id: String? = null) = ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "insights").apply { id?.let { putExtra("insightId", it) } })
    private fun capture(name: String) = main {
        val root = activity().window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            root.draw(android.graphics.Canvas(bitmap))
            java.io.File(context.getExternalFilesDir(null), "discovery-journeys").apply { mkdirs() }.resolve("$name.png")
                .outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun state() = api.get("/api/__fixture/state")

    @Test fun homeShowsAnActualFindingAndOpensItsExactNativeReport() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "OVERVIEW")).use {
            until("actual homepage finding") { main { text("Generated native discovery 0") } }
            capture("home")
            clickTag("home-discovery:" + fixture.getString("latestId"))
            until("exact native report") { main { activity() is CentralActivity && settled() && text("Generated native discovery 0") && text("查看依据") } }
            assertEquals(fixture.getString("latestId"), main { activity().intent.getStringExtra("insightId") })
            assertEquals(0, state().getInt("insightCalls")); main { activity().finish() }
        }
    }
    @Test fun oldExactReportAndItsOriginalSurviveRecreationAndSupportARealAnchoredQuestion() {
        open(fixture.getString("oldId")).use { scenario ->
            until("exact result outside first page") { main { settled() && text("Generated native discovery 66") } }
            capture("old-report")
            scenario.recreate(); until("report after Activity recreation") { main { settled() && text("Generated native discovery 66") } }
            click("查看原文依据"); until("actual original and metadata") { main { settled() && text("Generated original discovery record: completion remains unknown.") && text("基于这条记录提问") } }
            capture("original")
            scenario.recreate(); until("original after recreation") { main { settled() && text("Generated original discovery record: completion remains unknown.") } }
            click("基于这条记录提问"); until("actual original is an anchor") { main { settled() && text("参考这条记录，自动查找相关上下文") } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated question about the original") }; click("发送")
            until("real scoped answer") { main { shown().filterIsInstance<TextView>().any { it.text.toString().contains("Generated answer from the actual original") } } }
            val query = state().getJSONObject("lastQuery"); assertEquals(fixture.getString("noteId"), query.getJSONArray("anchorEvidenceIds").getString(0)); assertTrue(query.isNull("evidenceIds"))
            back(); until("Ask returns to original") { main { settled() && text("基于这条记录提问") } }
            back(); until("original returns to exact report") { main { settled() && text("Generated native discovery 66") && text("查看依据") } }
        }
    }
    @Test fun pagedHistoryRestoresAndDeletionAndPermissionRevocationWithdrawOldReports() {
        open().use { scenario ->
            until("first history page") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } }
            click("下一页"); until("second history page") { main { settled() && text("上一页") && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } }
            scenario.recreate(); until("second page restored") { main { settled() && text("上一页") } }
            click("下一页"); until("final history page") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 7 } }
            clickTag("insight:" + fixture.getString("oldId")); until("selected old report") { main { settled() && text("Generated native discovery 66") } }
            api.delete("/api/notes/" + fixture.getString("noteId"), JSONObject())
            until("deleted report withdrawn without manual reload") { main { text("这份洞察当前不可用，请从历史选择其他洞察。") && !text("Generated native discovery 66") } }
            click("发现历史"); until("old history cursor restarted") { main { settled() && text("第一份洞察会保存在这里，之后可以随时回看。") } }
        }
        fixture = api.post("/api/__fixture/reset", JSONObject())
        open(fixture.getString("oldId")).use {
            until("owner report before revocation") { main { settled() && text("Generated native discovery 66") } }
            CentralSession.get(context).signIn(origin, fixture.getString("restrictedToken"))
            until("restricted credential cannot retain owner content") { main { !text("Generated native discovery 66") && text("当前连接没有执行此操作的权限，请检查连接权限。") } }
        }
    }
    @Test fun uncertainGenerationRetriesOneRequestKeepsTheDraftAndCancellationFencesLatePublication() {
        open().use { scenario ->
            until("history ready") { main { settled() && text("新建洞察") } }; click("新建洞察")
            until("composer ready") { main { settled() && shown().filterIsInstance<EditText>().any { it.contentDescription == "洞察要求（可选）" } } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "洞察要求（可选）" }.setText("Generated original direction") }
            api.post("/api/__fixture/drop-ack", JSONObject()); click("生成洞察")
            until("lost ACK is explicit") { main { settled() && shown().filterIsInstance<TextView>().any { it.text.toString().contains("502") } } }
            scenario.recreate(); until("same pending request restored") { main { settled() && text("重试上次提交") } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "洞察要求（可选）" }.setText("Generated next draft") }; click("重试上次提交")
            until("published original request") { main { settled() && text("报告已归档") } }
            val receipt = state(); assertEquals(1, receipt.getInt("insightCalls")); val requests = receipt.getJSONArray("seenRequests"); assertEquals(2, requests.length()); assertEquals(requests.getString(0), requests.getString(1))
            back(); until("history after run") { main { settled() && text("新建洞察") } }; click("新建洞察")
            until("unsent draft preserved") { main { settled() && shown().filterIsInstance<EditText>().any { it.text.toString() == "Generated next draft" } } }
            api.post("/api/__fixture/hold-generation", JSONObject()); click("生成洞察"); until("running cancellable task") { main { settled() && text("停止") } }
            click("停止"); until("cancelled receipt") { main { settled() && text("回顾已取消") } }
            api.post("/api/__fixture/release-generation", JSONObject()); until("uncooperative model finishes") { state().getInt("activeGenerations") == 0 }
            assertEquals(68, state().getInt("savedCount")); assertEquals(2, state().getInt("insightCalls"))
        }
    }
    @Test fun emptyHomeDoesNotInventFindingsAndOfflineHistoryRecovers() {
        api.delete("/api/notes/" + fixture.getString("noteId"), JSONObject())
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "OVERVIEW")).use {
            until("empty discovery loaded") { main { text("发现历史") && shown().none { it.tag == "discovery-loading" } } }
            assertFalse(main { shown().any { it.tag?.toString()?.startsWith("home-discovery:") == true } })
            assertEquals(0, state().getInt("insightCalls"))
        }
        open().use {
            until("actual empty history") { main { settled() && text("第一份洞察会保存在这里，之后可以随时回看。") } }
        }
        fixture = api.post("/api/__fixture/reset", JSONObject())
        api.post("/api/__fixture/offline", JSONObject())
        try {
            open().use {
                until("offline history offers retry") { main { settled() && text("重试") } }
                assertFalse(main { text("第一份洞察会保存在这里，之后可以随时回看。") })
                api.post("/api/__fixture/online", JSONObject()); click("重试")
                until("history recovers with real reports") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } }
            }
        } finally { api.post("/api/__fixture/online", JSONObject()) }
    }

}
