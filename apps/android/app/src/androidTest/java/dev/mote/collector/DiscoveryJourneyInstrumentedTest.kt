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
    private fun shown() = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun text(value: String) = shown().filterIsInstance<TextView>().any { (it.text.toString() == value || it.contentDescription?.toString() == value) }
    private fun until(label: String, test: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 25000
        while (System.currentTimeMillis() < deadline) { if (runCatching(test).getOrDefault(false)) return; Thread.sleep(75) }
        fail(label + ": " + main { shown().filterIsInstance<TextView>().joinToString(" | ") { it.text.toString() } })
    }
    private fun settled() = (activity() as? CentralActivity)?.isWorking != true
    private fun click(label: String) {
        val action=if (label == "关闭详情" && main { activity() is CaptureRecordsActivity }) "返回上一页" else label
        until(action) { main { settled() && shown().filterIsInstance<TextView>().any { (it.text.toString() == action || it.contentDescription?.toString() == action) && it.isClickable && it.isEnabled } } }
        main { shown().filterIsInstance<TextView>().first { (it.text.toString() == action || it.contentDescription?.toString() == action) && it.isClickable && it.isEnabled }.performClick() }
    }
    private fun clickTag(tag: String) { until(tag) { main { settled() && shown().any { it.tag == tag && it.isEnabled } } }; main { shown().single { it.tag == tag }.performClick() } }
    private fun chooseMenu(label: String) {
        until("menu item "+label) { main { shown().filterIsInstance<android.widget.ListView>().any { list -> (0 until list.adapter.count).any { list.adapter.getItem(it).toString() == label } } } }
        main { val list = shown().filterIsInstance<android.widget.ListView>().single { list -> (0 until list.adapter.count).any { list.adapter.getItem(it).toString() == label } }
            val position = (0 until list.adapter.count).single { list.adapter.getItem(it).toString() == label }; list.performItemClick(list.getChildAt(position),position,list.adapter.getItemId(position)) }
    }
    private fun newReport() { clickTag("insight-more"); chooseMenu("新建洞察") }
    private fun tapInline(number: Int) {
        var point: FloatArray? = null
        until("inline text has a current actual layout") { main {
            val content = shown().filterIsInstance<TextView>().singleOrNull { it.tag == "insight-content" } ?: return@main false
            val layout = content.layout ?: return@main false
            val text = content.text as android.text.Spanned
            val span = text.getSpans(0,text.length,android.text.style.ClickableSpan::class.java).first { text.subSequence(text.getSpanStart(it),text.getSpanEnd(it)).toString() == "[$number]" }
            val offset=text.getSpanStart(span);val line=layout.getLineForOffset(offset)
            val x=(layout.getPrimaryHorizontal(offset)+layout.getPrimaryHorizontal(text.getSpanEnd(span)))/2+content.totalPaddingLeft
            val y=(layout.getLineTop(line)+layout.getLineBottom(line))/2f+content.totalPaddingTop
            content.requestRectangleOnScreen(android.graphics.Rect(x.toInt(),y.toInt(),x.toInt()+1,y.toInt()+1),true)
            val location=IntArray(2);content.getLocationOnScreen(location);point=floatArrayOf(location[0]+x,location[1]+y);true
        } }
        val touch=point!!;val now=android.os.SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,touch[0],touch[1],0))
        instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,touch[0],touch[1],0))
    }
    private fun back() { instrumentation.uiAutomation.executeShellCommand("input keyevent 4").close() }
    private fun open(id: String? = null) = ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "insights").apply { id?.let { putExtra("insightId", it) } })
    private fun captureOne(name: String) = main {
        val root = activity().window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            root.draw(android.graphics.Canvas(bitmap))
            java.io.File(context.filesDir, "discovery-journeys").apply { mkdirs() }.resolve("$name.png")
                .outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun capture(name:String) {
        val before=MoteAppearance.preference()
        try { for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
            main { MoteAppearance.select(context,theme) };instrumentation.waitForIdleSync()
            val frame=java.util.concurrent.CountDownLatch(1);main { activity().window.decorView.postOnAnimation { activity().window.decorView.postOnAnimation { frame.countDown() } } };assertTrue(frame.await(5,java.util.concurrent.TimeUnit.SECONDS))
            captureOne(name+if(theme==AppearancePreference.DARK)"-dark" else "")
        } } finally { main { MoteAppearance.select(context,before) } }
    }
    private fun state() = api.get("/api/__fixture/state")

    @Test fun homeShowsAnActualFindingAndOpensItsExactNativeReport() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "OVERVIEW")).use {
            until("home loaded") { main { shown().any { it.tag == "home-record-action" } } }
            capture("home")
            main { activity().openGeneratedMenu() }
            clickTag("menu:发现历史")
            until("actual discovery history") { main { settled() && shown().any { it.tag == "insight:" + fixture.getString("latestId") } } }
            clickTag("insight:" + fixture.getString("latestId"))
            until("exact native report") { main { activity() is CentralActivity && settled() && text("Generated native discovery 0") && text("原文依据") } }
            assertTrue(main { text("Generated native discovery 0") })
            capture("latest-report"); assertEquals(0, state().getInt("insightCalls")); main { activity().finish() }
        }
    }
    @Test fun sourceListAndDiscoveryCitationUseTheSameActualCaptureReader() {
        val original="Generated original discovery record: completion remains unknown."
        var first=emptyList<String>()
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","notes")).use {
            until("actual note list loaded") { main { settled() && shown().filterIsInstance<TextView>().any { it.text.toString() == original } } }
            click("查看原文")
            until("shared list reader") { main { activity() is CaptureRecordsActivity && shown().filterIsInstance<TextView>().any { it.text.toString() == original } } }
            main {
                assertEquals("原文",shown().filterIsInstance<TextView>().single { it.tag == "detail-title" }.text.toString())
                assertTrue("The shared reader has no browser filters",shown().filterIsInstance<android.widget.Spinner>().isEmpty())
            }
            val firstReader=main { activity() }; main { firstReader.recreate() }
            until("direct reader restored") { main { activity() !== firstReader && activity() is CaptureRecordsActivity && shown().filterIsInstance<TextView>().any { it.text.toString() == original } } }
            first=main { shown().filterIsInstance<TextView>().map { it.text.toString() }.filter(String::isNotBlank) }; capture("list-shared-original")
            click("关闭详情")
            until("list return") { main { activity() is CentralActivity && text("已经留下的心绪与杂事") } }
        }
        open(fixture.getString("oldId")).use {
            until("saved discovery loaded") { main { settled() && text("Generated native discovery 66") } }
            clickTag("insight-citation:"+fixture.getString("noteId"))
            until("shared citation reader") { main { activity() is CaptureRecordsActivity && shown().filterIsInstance<TextView>().any { it.text.toString() == original } } }
            assertEquals("The actual reader renders the same original and metadata from both entrypoints",first,main { shown().filterIsInstance<TextView>().map { it.text.toString() }.filter(String::isNotBlank) }); capture("citation-shared-original")
            click("关闭详情"); until("same report return") { main { activity() is CentralActivity && text("Generated native discovery 66") } }
        }
        assertEquals(0,state().getInt("insightCalls"))
    }

    @Test fun reportReadingChoiceIsInMoreAndSurvivesRecreationWithoutChangingSavedReport() {
        val id=fixture.getString("oldId"); val before=api.get("/api/insights/$id").toString()
        open(id).use { scenario ->
            until("report loaded") { main { settled() && text("Generated native discovery 66") } }
            fun select(label: String) {
                clickTag("insight-more")
                main {
                    val list=android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<android.widget.ListView>().single { it.isShown }
                    val position=(0 until list.adapter.count).single { list.adapter.getItem(it).toString() == label }
                    list.performItemClick(list.getChildAt(position),position,list.adapter.getItemId(position))
                }
            }
            select("标准阅读"); capture("discovery-standard")
            assertEquals(InsightPresentation.answer(api.get("/api/insights/$id")),main { shown().filterIsInstance<TextView>().single { it.tag == "insight-content" }.text.toString() })
            scenario.recreate(); until("report restored") { main { settled() && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" } } }
            clickTag("insight-more")
            main {
                val list=android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<android.widget.ListView>().single { it.isShown }
                assertEquals("Standard reading remains selected after recreation",1,list.checkedItemPosition)
                list.performItemClick(list.getChildAt(0),0,list.adapter.getItemId(0))
            }
            capture("discovery-formatted")
        }
        assertEquals(before,api.get("/api/insights/$id").toString()); assertEquals(0,state().getInt("insightCalls"))
    }
    @Test fun oldExactReportAndItsOriginalSurviveRecreationAndSupportARealAnchoredQuestion() {
        open(fixture.getString("oldId")).use { scenario ->
            until("exact result outside first page") { main { settled() && text("Generated native discovery 66") } }
            capture("old-report")
            scenario.recreate(); until("report after Activity recreation") { main { settled() && text("Generated native discovery 66") } }
            clickTag("insight-citation:"+fixture.getString("noteId")); until("actual original and metadata") { main { settled() && text("Generated original discovery record: completion remains unknown.") && text("围绕这份资料提问") } }
            capture("original")
            main { activity().recreate() }; until("original after recreation") { main { settled() && text("Generated original discovery record: completion remains unknown.") } }
            click("围绕这份资料提问"); until("actual original is an anchor") { main { settled() && shown().filterIsInstance<TextView>().any { it.text.toString() == "Generated original discovery record: completion remains unknown." } } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText("Generated question about the original") }; click("发送")
            until("real scoped answer") { main { shown().filterIsInstance<TextView>().any { it.text.toString().contains("Generated answer from the actual original") } } }
            val query = state().getJSONObject("lastQuery"); assertEquals(fixture.getString("noteId"), query.getJSONArray("anchorEvidenceIds").getString(0)); assertTrue(query.isNull("evidenceIds"))
            back(); until("Ask returns to original") { main { settled() && text("围绕这份资料提问") } }
            back(); until("original returns to exact report") { main { settled() && text("Generated native discovery 66") && text("原文依据") } }
        }
    }
    @Test fun pagedHistoryRestoresAndDeletionAndPermissionRevocationWithdrawOldReports() {
        open().use { scenario ->
            until("first history page") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } }
            click("下一页"); until("second history page") { main { settled() && text("上一页") && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } }
            scenario.recreate(); until("second page restored") { main { settled() && text("上一页") } }
            click("下一页"); until("final history page") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 7 } }
            capture("history-last-page"); clickTag("insight:" + fixture.getString("oldId")); until("selected old report") { main { settled() && text("Generated native discovery 66") } }
            api.delete("/api/notes/" + fixture.getString("noteId"), JSONObject())
            until("deleted report withdrawn without manual reload") { main { text("这份洞察当前不可用，请从历史选择其他洞察。") && !text("Generated native discovery 66") } }
            capture("deleted-report-unavailable"); click("发现历史"); until("old history cursor restarted") { main { settled() && text("第一份洞察会保存在这里，之后可以随时回看。") } }
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
            until("history ready") { main { settled() && shown().any { it.tag == "insight-more" } } }; newReport()
            until("composer ready") { main { settled() && shown().filterIsInstance<EditText>().any { it.contentDescription == "洞察要求（可选）" } } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "洞察要求（可选）" }.setText("Generated original direction") }
            api.post("/api/__fixture/drop-ack", JSONObject()); click("生成洞察")
            until("lost ACK is explicit") { main { settled() && shown().filterIsInstance<TextView>().any { it.text.toString().contains("502") } } }
            capture("generation-receipt-lost"); scenario.recreate(); until("same pending request restored") { main { settled() && text("重试上次提交") } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "洞察要求（可选）" }.setText("Generated next draft") }; click("重试上次提交")
            until("published original request") { main { settled() && text("报告已归档") } }
            capture("generation-completed"); val receipt = state(); assertEquals(1, receipt.getInt("insightCalls")); val requests = receipt.getJSONArray("seenRequests"); assertEquals(2, requests.length()); assertEquals(requests.getString(0), requests.getString(1))
            back(); until("history after run") { main { settled() && shown().any { it.tag == "insight-more" } } }; newReport()
            until("unsent draft preserved") { main { settled() && shown().filterIsInstance<EditText>().any { it.text.toString() == "Generated next draft" } } }
            api.post("/api/__fixture/hold-generation", JSONObject()); click("生成洞察"); until("running cancellable task") { main { settled() && text("停止") } }
            click("停止"); until("cancelled receipt") { main { settled() && text("回顾已取消") } }
            capture("generation-cancelled"); api.post("/api/__fixture/release-generation", JSONObject()); until("uncooperative model finishes") { state().getInt("activeGenerations") == 0 }
            assertEquals(68, state().getInt("savedCount")); assertEquals(2, state().getInt("insightCalls"))
        }
    }
    @Test fun emptyHomeDoesNotInventFindingsAndOfflineHistoryRecovers() {
        api.delete("/api/notes/" + fixture.getString("noteId"), JSONObject())
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "OVERVIEW")).use {
            until("light home loaded") { main { shown().any { it.tag == "home-record-action" } } }
            assertFalse(main { shown().any { it.tag?.toString()?.startsWith("home-discovery:") == true } })
            assertEquals(0, state().getInt("insightCalls"))
        }
        open().use {
            until("actual empty history") { main { settled() && text("第一份洞察会保存在这里，之后可以随时回看。") } };capture("history-empty")
        }
        fixture = api.post("/api/__fixture/reset", JSONObject())
        api.post("/api/__fixture/offline", JSONObject())
        try {
            open().use {
                until("offline history offers retry") { main { settled() && text("重试") } }
                capture("history-offline"); assertFalse(main { text("第一份洞察会保存在这里，之后可以随时回看。") })
                api.post("/api/__fixture/online", JSONObject()); click("重试")
                until("history recovers with real reports") { main { settled() && shown().count { it.tag?.toString()?.startsWith("insight:") == true } == 30 } };capture("history-recovered")
            }
        } finally { api.post("/api/__fixture/online", JSONObject()) }
    }

    @Test fun finalDiscoveryUsesQuietChromeAndActualInlineReferencesInBothReadingModes() {
        val published=api.post("/api/__fixture/inline-report",JSONObject());val id=published.getString("runId");val noteId=published.getString("noteId")
        val saved=api.get("/api/insights/$id");val original=api.get("/api/capture-browser/$noteId").getString("ocrText")
        open().use {
            until("source-shaped history") { main { settled() && shown().any { it.tag == "insight:$id" } } }
            main { assertFalse(shown().any { it.tag == "central-collection-scope" });assertFalse(text("本机保留"));assertFalse(text("设置"));assertFalse(text("生成任务"));assertFalse(text("刷新")) }
            main { val row=shown().single { it.tag == "insight:$id" }; assertFalse(views(row).filterIsInstance<TextView>().any { it.text.toString().contains("**") || it.text.toString().contains(noteId) }) }
            capture("final-discovery-history");clickTag("insight:$id")
            until("actual full saved body") { main { settled() && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" && it.text.toString().contains("Generated full paragraph 34") } } }
            main {
                val rendered=shown().filterIsInstance<TextView>().single { it.tag == "insight-content" }.text as android.text.Spanned
                assertFalse(rendered.toString().contains(noteId));assertTrue(rendered.toString().startsWith("Generated exact inline report [1]"))
                assertEquals(2,rendered.getSpans(0,rendered.length,android.text.style.ClickableSpan::class.java).size)
                val meta=shown().filterIsInstance<TextView>().single { it.tag == "insight-meta" }.text.toString();assertTrue(meta.contains(MoteI18n.text("{0} 份依据",1)));assertFalse(meta.contains("T00:"))
                assertFalse(shown().any { it.tag == "central-collection-scope" });assertFalse(text("设置"));assertFalse(text("生成信息与检索过程"))
            }
            capture("final-discovery-formatted");tapInline(1)
            until("inline opens exact original") { main { activity() is CaptureRecordsActivity && text(original) } };capture("final-discovery-inline-original");click("关闭详情")
            until("same report returns") { main { activity() is CentralActivity && settled() && shown().any { it.tag == "insight-content" } } };capture("final-discovery-inline-return")
            clickTag("insight-more");chooseMenu("标准阅读")
            until("standard body and native focus restored") { main { settled() && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" && it.text.toString().startsWith("Generated exact inline report [1]") } } }
            main { val rendered=shown().filterIsInstance<TextView>().single { it.tag == "insight-content" }.text as android.text.Spanned;assertTrue(rendered.toString().startsWith("Generated exact inline report [1]"));assertTrue(rendered.toString().contains("Generated full paragraph 34"));assertEquals(2,rendered.getSpans(0,rendered.length,android.text.style.ClickableSpan::class.java).size);assertEquals(0,rendered.getSpans(0,rendered.length,android.text.style.StyleSpan::class.java).size) }
            capture("final-discovery-standard");tapInline(1)
            until("standard inline opens same original") { main { activity() is CaptureRecordsActivity && text(original) } };click("关闭详情")
            until("standard report returns") { main { activity() is CentralActivity && settled() && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" && it.text.toString().startsWith("Generated exact inline report [1]") } } }
            main { activity().recreate() };until("standard report survives recreation") { main { settled() && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" && it.text.toString().startsWith("Generated exact inline report [1]") } } }
            clickTag("insight-more");chooseMenu("资料与记忆");chooseMenu("资料类型");until("secondary type routes remain") { main { text("资料库") } };back()
        }
        assertEquals(saved.toString(),api.get("/api/insights/$id").toString());assertEquals(0,state().getInt("insightCalls"))
    }

}
