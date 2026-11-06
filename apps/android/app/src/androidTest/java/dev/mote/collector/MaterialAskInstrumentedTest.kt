package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Real generated Central Materials and query admission; the model is a controlled fixture. */
@RunWith(AndroidJUnit4::class)
class MaterialAskInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private val origin="http://127.0.0.1:47886"
    private val api get()=CentralClient(origin,"generated-native-discovery-owner-token")
    private lateinit var fixture:JSONObject
    private val directory get()=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(origin))
    private fun saved()=CentralDraftWrites.barrier { CentralStateFile(directory,"ask",context.secretBox()).read() }
    private fun control(action:String)=api.post("/api/__fixture/$action")
    private fun <T> main(block:()->T):T { val result=AtomicReference<Result<T>>();instrumentation.runOnMainSync { result.set(runCatching(block)) };return result.get().getOrThrow() }
    private fun views(root:View):List<View> = listOf(root)+if(root is ViewGroup)(0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(a:CentralActivity)=views(a.window.decorView).filter { it.isShown }
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+25_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(60)};fail(label)}
    private fun ready(s:ActivityScenario<CentralActivity>,label:String,check:(CentralActivity)->Boolean){until(label){var value=false;s.onActivity{value=check(it)};value}}
    private fun click(s:ActivityScenario<CentralActivity>,label:String,predicate:(View)->Boolean){ready(s,label){a -> !a.isWorking && shown(a).any { it.isEnabled && predicate(it) }};s.onActivity { a -> shown(a).single { it.isEnabled && predicate(it) }.apply { requestRectangleOnScreen(android.graphics.Rect(0,0,width,height),true);assertTrue(performClick()) } }}
    private fun clickText(s:ActivityScenario<CentralActivity>,text:String)=click(s,text){it is TextView && it.isClickable && it.text.toString()==text}
    private fun question(s:ActivityScenario<CentralActivity>,text:String){ready(s,"Composer ready"){a -> !a.isWorking && shown(a).filterIsInstance<EditText>().any { it.contentDescription=="你的问题" && it.isEnabled }};s.onActivity { a -> shown(a).filterIsInstance<EditText>().single { it.contentDescription=="你的问题" }.setText(text) }}
    private fun screenshotOne(s:ActivityScenario<CentralActivity>,name:String){instrumentation.waitForIdleSync();s.onActivity { a -> if(name.endsWith("-dark"))shown(a).filterIsInstance<android.widget.Spinner>().forEach { spinner -> (spinner.selectedView as? TextView)?.let { assertEquals(MoteUi.ink,it.currentTextColor) } };val root=a.window.decorView;val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(image));File(context.filesDir,"material-ask-final").apply{mkdirs()}.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }}finally{image.recycle()} }}
    private fun screenshot(s:ActivityScenario<CentralActivity>,name:String){val before=MoteAppearance.preference();try{for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){main { MoteAppearance.select(context,theme) };instrumentation.waitForIdleSync();screenshotOne(s,name+if(theme==AppearancePreference.DARK)"-dark" else "")}}finally{main { MoteAppearance.select(context,before) }}}
    private fun captureDetail(name:String){
        instrumentation.waitForIdleSync()
        main{
        val roots=android.view.inspector.WindowInspector.getGlobalWindowViews().filter{it.isShown}
        val sheet=roots.firstOrNull{ root->views(root).any{it is TextView&&it.text.toString()=="本机已保存"} }?:error("Detail sheet is not visible")
        val page=roots.firstOrNull{ root -> root!==sheet && views(root).any{ it is TextView && it.text.toString()=="原文" } }?:roots.first{it!==sheet}
        views(page).filterIsInstance<android.widget.ScrollView>().firstOrNull()?.scrollTo(0,120)
        val image=android.graphics.Bitmap.createBitmap(page.width,page.height,android.graphics.Bitmap.Config.ARGB_8888)
        try{
            val canvas=android.graphics.Canvas(image)
            page.draw(canvas)
            canvas.drawColor(android.graphics.Color.argb(82,0,0,0))
            val location=IntArray(2);sheet.getLocationOnScreen(location)
            canvas.save();canvas.translate(location[0].toFloat(),location[1].toFloat());sheet.draw(canvas);canvas.restore()
            File(context.getExternalFilesDir(null),"ua09").apply{mkdirs()}.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        }finally{image.recycle()}
    }}
    private fun <T:android.app.Activity> shownViews(a:T):List<View> = views(a.window.decorView).filter { it.isShown }
    private fun <T:android.app.Activity> readyAny(s:ActivityScenario<T>,label:String,check:(T)->Boolean){until(label){var value=false;s.onActivity{value=check(it)};value}}
    private fun <T:android.app.Activity> clickAny(s:ActivityScenario<T>,label:String,predicate:(View)->Boolean){readyAny(s,label){a -> shownViews(a).any { it.isEnabled && predicate(it) }};s.onActivity { a -> shownViews(a).single { it.isEnabled && predicate(it) }.apply { requestRectangleOnScreen(android.graphics.Rect(0,0,width,height),true);assertTrue(performClick()) } }}
    private fun windows()=android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filter { it.isShown }
    private fun openMaterial(capture:Boolean=true):ActivityScenario<CentralActivity> {
        val scenario=ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","materials"))
        click(scenario,"Actual Material list row"){it.tag=="material-open:"+fixture.getString("nativeMaterialId")}
        ready(scenario,"Pinned reader ready"){a -> !a.isWorking && shown(a).any { it.tag=="material-ask" }};val page=api.get("/api/materials/"+fixture.getString("nativeMaterialId")+"/read?offset=0&length=4000&revision="+control("state").getString("nativeMaterialRef").substringAfter('@'))
        scenario.onActivity { a->val spans=page.getJSONArray("spans");for(index in 0 until spans.length()){val span=spans.getJSONObject(index);if(span.getString("kind")=="text"){val range=span.getJSONObject("pageRange");assertEquals(page.getString("text").substring(range.getInt("start"),range.getInt("end")),shown(a).filterIsInstance<TextView>().single{it.tag=="material-literal:"+span.getString("blockId")}.text.toString())}} }
        if(capture)screenshot(scenario,"pinned-material-reader");return scenario
    }
    private fun clickWindowText(text:String){until("Window action $text"){main{windows().any{it.isEnabled&&it is TextView&&it.text.toString()==text}}};main{windows().first{it.isEnabled&&it is TextView&&it.text.toString()==text}.performClick()}}
    private fun clickWindowDescription(text:String){until("Window action $text"){main{windows().any{it.isEnabled&&it.contentDescription?.toString()==text}}};main{windows().first{it.isEnabled&&it.contentDescription?.toString()==text}.performClick()}}
    private fun choose(s:ActivityScenario<CentralActivity>):String {
        val ref=control("state").getString("nativeMaterialRef")
        click(s,"Ask about the actual pinned Material"){it.tag=="material-ask"}
        ready(s,"Exact Material chip"){a -> !a.isWorking && shown(a).any { it.contentDescription?.toString()==ref }}
        return ref
    }
    private fun clear(s:ActivityScenario<CentralActivity>,ref:String){
        click(s,"Material scope"){it.contentDescription?.toString()==ref};
        until("Clear scope dialog"){main { android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).any { it is TextView && it.text.toString()=="清除范围" } }}
        main { val list=android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }.flatMap(::views).filterIsInstance<android.widget.ListView>().single { it.isShown }
            val position=(0 until list.adapter.count).single { list.adapter.getItem(it).toString()=="清除范围" }
            assertTrue(list.performItemClick(list.getChildAt(position-list.firstVisiblePosition),position,list.adapter.getItemId(position))) }
    }
    @Test fun a09DetailReceiptsAndClearableScopeKeepTheAcceptedOriginal(){
        val before=MoteAppearance.preference()
        val state=control("state")
        val conversation=state.getString("askConversationId")
        val capture=state.getString("detailCaptureId")
        try {
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
                main { MoteAppearance.select(context,theme) }
                ActivityScenario.launch<CaptureRecordsActivity>(Intent(context,CaptureRecordsActivity::class.java)
                    .putExtra("recordId",capture).putExtra("recordRemote",true).putExtra("recordOrigin",origin)
                    .putExtra("recordSource","screen").putExtra("directReader",true).putExtra("centralReaderActions",true)).use { s ->
                    readyAny(s,"Actual original reader"){a -> shownViews(a).filterIsInstance<TextView>().any { it.text.toString().contains("暖气费按实际用量分摊") }}
                    clickAny(s,"Open the actual original More menu"){it is TextView && it.isClickable && !it.isSelected && it.text.toString()=="更多"}
                    clickAny(s,"详情"){it is TextView && it.isClickable && it.text.toString()=="详情"}
                    until("Receipt timeline and references are visible"){main{windows().any{it is TextView&&it.text.toString()=="本机已保存"}&&windows().any{it is TextView&&it.text.toString()=="中央已接收"}&&windows().any{it is TextView&&it.text.toString()=="引用它的对话"}}}
                    main { windows().filterIsInstance<TextView>().firstOrNull { it.isSelected && it.text.toString()=="更多" }?.performClick() }
                    instrumentation.waitForIdleSync()
                    s.onActivity { a ->
                        assertTrue(windows().filterIsInstance<TextView>().any { it.text.toString()=="2" })
                        assertFalse(windows().filterIsInstance<TextView>().any { it.text.toString()=="关闭" })
                        assertFalse(a.isFinishing)
                    }
                    captureDetail("impl-original-detail"+if(theme==AppearancePreference.DARK)"-dark" else "-light")
                    clickWindowDescription("关闭")
                    readyAny(s,"Closing the sheet keeps the original reader"){a -> shownViews(a).filterIsInstance<TextView>().any { it.text.toString().contains("暖气费按实际用量分摊") }}
                }
            }
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
                main { MoteAppearance.select(context,theme) }
                CentralDraftWrites.barrier { CentralStateFile(directory,"ask",context.secretBox()).write(JSONObject().put("conversationId",conversation).put("question","").put("attachments",org.json.JSONArray())) }
                ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask")).use { s ->
                    ready(s,"Scoped conversation is visible"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } && shown(a).filterIsInstance<TextView>().any { it.contentDescription?.toString()?.startsWith("material:")==true }}
                    screenshotOne(s,"impl-ask-scoped"+if(theme==AppearancePreference.DARK)"-dark" else "-light")
                    click(s,"Clear the exact scope from its chip"){it.contentDescription?.toString()=="清除范围"}
                    until("Scope chip clears without losing the conversation"){saved().isNull("anchorMaterialRef")}
                    ready(s,"The answer remains after clearing scope"){a -> shown(a).filterIsInstance<TextView>().any { it.text.toString().contains("按实际用量分摊") } && shown(a).filterIsInstance<TextView>().none { it.contentDescription?.toString()?.startsWith("material:")==true }}
                    screenshotOne(s,"impl-ask-scope-cleared"+if(theme==AppearancePreference.DARK)"-dark" else "-light")
                }
            }
        } finally { main { MoteAppearance.select(context,before) } }
    }
    @Before fun generatedOnly(){
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeAskRecoveryFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a") && !Settings(context).enabled)
        fixture=control("reset");directory.deleteRecursively()
        val settings=Settings(context);settings.save(settings.read().copy(server=origin,token="",debugHttp=true,syncMode="manual",authSignedOut=false,authExpiresAt=0,authProcess=""),confirmCentralEndpoint=true)
        CentralSession.get(context).select(origin);CentralSession.get(context).signIn(origin,"generated-native-discovery-owner-token")
        MoteI18n.select(context,"zh-CN");main { MoteAppearance.select(context,AppearancePreference.LIGHT) }
    }
    @After fun release(){if(::fixture.isInitialized)control("release-material-read")}
    @Test fun aLaterDraftDuringVersionVerificationIsNeverSubmittedWithoutAnotherSend(){
        openMaterial().use { s ->
            val ref=choose(s);question(s,"Generated initial question before reference check");control("hold-material-read")
            click(s,"Send"){it.contentDescription=="发送"};until("Actual pinned read held"){control("state").getBoolean("materialReadHeld")}
            s.onActivity { a -> val field=shown(a).filterIsInstance<EditText>().single { it.contentDescription=="你的问题" };assertTrue(field.isEnabled);field.setText("Generated later private draft while checking") }
            control("release-material-read")
            ready(s,"Later draft is preserved without implicit send"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString()=="草稿已保留，请确认当前内容后重新发送。" }}
            assertEquals("Generated later private draft while checking",saved().getString("question"));assertEquals(ref,NativeAskEvidenceScope.material(saved()));assertFalse(saved().has("pending"));assertEquals(0,control("state").getJSONArray("seenAskRequests").length());screenshot(s,"later-draft-during-reference-check")
            click(s,"Explicitly send the later draft"){it.contentDescription=="发送"};until("Only explicit later question completes"){saved().optString("runStatus")=="completed"}
            assertEquals("Generated later private draft while checking",control("state").getJSONObject("lastQuery").getString("question"));assertEquals(1,control("state").getInt("queryCalls"))
        }
    }
    @Test fun actualReaderSelectsOneWholeVersionAndSharedConversationCanClearWithoutLosingDraft(){
        CentralDraftWrites.barrier { CentralStateFile(directory,"ask",context.secretBox()).write(JSONObject().put("question","Generated prior private draft")) }
        openMaterial().use { s ->
            val ref=choose(s);assertEquals("Generated prior private draft",saved().getString("question"))
            question(s,"Generated native whole Material question");click(s,"Send"){it.contentDescription=="发送"}
            until("Actual Material run completes"){saved().optString("runStatus")=="completed"}
            val state=control("state");assertEquals(ref,state.getJSONObject("lastQuery").getString("anchorMaterialRef"));assertEquals(ref,state.getJSONArray("materialReads").getString(0))
            val input=JSONObject(state.getJSONArray("seenAskRequests").getString(0)).getJSONObject("input")
            assertEquals(ref,input.getString("anchorMaterialRef"));assertTrue(input.isNull("evidenceIds"));assertTrue(input.isNull("anchorEvidenceIds"))
            val conversation=saved().getString("conversationId");assertEquals(ref,api.get("/api/conversations/$conversation").getJSONObject("scope").getString("anchorMaterialRef"))
            question(s,"Generated later draft stays private");s.recreate()
            ready(s,"Pinned shared scope and draft survive recreation"){a -> !a.isWorking && shown(a).any { it.contentDescription?.toString()==ref } && shown(a).filterIsInstance<EditText>().any { it.text.toString()=="Generated later draft stays private" }}
            screenshot(s,"whole-version-and-later-draft");clear(s,ref)
            assertEquals("Generated later draft stays private",saved().getString("question"));assertTrue(saved().isNull("anchorMaterialRef"))
            click(s,"Send after explicit clear"){it.contentDescription=="发送"};until("Explicit clear completes"){saved().optString("runStatus")=="completed" && control("state").getInt("queryCalls")==2}
            assertTrue(control("state").getJSONObject("lastQuery").isNull("anchorMaterialRef"));assertFalse(api.get("/api/conversations/$conversation").getJSONObject("scope").has("anchorMaterialRef"));screenshot(s,"explicit-reference-clear")
        }
    }
    @Test fun changedReferenceIsNeverRetargetedAndKnownAdmissionRejectionKeepsEditableDraft(){
        openMaterial().use { s ->
            val ref=choose(s);question(s,"Generated question whose selected version changes");control("material-update")
            click(s,"Send"){it.contentDescription=="发送"}
            ready(s,"Changed version explicitly refused"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().startsWith("所选资料版本已变更或不可用") }}
            assertFalse(saved().has("pending"));assertEquals(ref,NativeAskEvidenceScope.material(saved()));assertEquals(0,control("state").getJSONArray("seenAskRequests").length());screenshot(s,"changed-version-draft-retained")
            clear(s,ref);question(s,"Generated question without automatic reference replacement")
            assertEquals("Generated question without automatic reference replacement",saved().getString("question"))
        }
        fixture=control("reset");directory.deleteRecursively()
        openMaterial().use { s ->
            val ref=choose(s);question(s,"Generated race before actual admission");control("material-race");click(s,"Send"){it.contentDescription=="发送"}
            ready(s,"Actual owner 409 keeps draft editable"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString().startsWith("所选资料版本已变更或不可用") }}
            assertFalse(saved().has("pending"));assertEquals(ref,NativeAskEvidenceScope.material(saved()));assertEquals("Generated race before actual admission",saved().getString("question"));assertEquals(0,control("state").getInt("queryCalls"));assertEquals(1,control("state").getJSONArray("seenAskRequests").length());screenshot(s,"known-admission-rejection")
        }
    }
    @Test fun readablePartialMaterialAndAnotherDevicesConversationKeepTheirExactVersion(){
        control("material-partial");val ref=control("state").getString("nativeMaterialRef")
        val admitted=api.post("/api/query-runs",JSONObject().put("id",UUID.randomUUID().toString()).put("input",JSONObject().put("question","Generated other-device whole Material question").put("anchorMaterialRef",ref)))
        var conversation="";until("Other device actual query completes"){val run=api.get("/api/query-runs/"+admitted.getString("id"));conversation=run.optString("conversationId");run.optString("status")=="completed"}
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",conversation)).use { s ->
            ready(s,"Shared partial Material scope renders"){a -> !a.isWorking && shown(a).any { it.contentDescription?.toString()==ref }}
            question(s,"Generated native follow-up to shared partial Material");click(s,"Send"){it.contentDescription=="发送"};until("Partial Material follow-up completes"){saved().optString("runStatus")=="completed"}
            assertEquals(conversation,saved().getString("conversationId"));assertEquals(ref,control("state").getJSONObject("lastQuery").getString("anchorMaterialRef"));screenshot(s,"shared-partial-material")
        }
    }
    @Test fun readableAssetOnlyMaterialShowsItsOriginalAndKeepsExactAskScope(){
        control("material-asset-only");val ref=control("state").getString("nativeMaterialRef")
        val read=api.get("/api/materials/"+fixture.getString("nativeMaterialId")+"/read?revision="+ref.substringAfter('@')+"&length=12000")
        assertEquals("asset",read.getJSONArray("spans").getJSONObject(0).getString("kind"))
        openMaterial().use { s ->
            val hash=read.getJSONArray("spans").getJSONObject(0).getJSONObject("asset").getString("hash")
            s.onActivity { a->assertTrue(shown(a).filterIsInstance<TextView>().any{it.text.toString()=="此版本暂无文字正文。"});assertTrue(shown(a).filterIsInstance<TextView>().any{it.text.toString()=="text/plain"});assertTrue(shown(a).filterIsInstance<TextView>().any{it.text.toString()=="原件已保留"});assertFalse(shown(a).filterIsInstance<TextView>().any{it.text.contains(hash) || it.text.toString().startsWith("[asset ") || it.text.toString().startsWith("sourceId ·")}) }
            screenshot(s,"asset-only-material-reader")
            click(s,"更多"){it is TextView && it.tag=="disclosure:"+MoteI18n.text("更多")};ready(s,"Actual asset hash is available only in expanded details"){a->shown(a).filterIsInstance<TextView>().any{it.text.contains(hash)}};screenshot(s,"asset-only-expanded-real-metadata");click(s,"更多"){it is TextView && it.tag=="disclosure:"+MoteI18n.text("更多")}
            clickText(s,"来源与处理");ready(s,"Pinned member original route"){a->!a.isWorking && shown(a).filterIsInstance<TextView>().any{it.text.toString()=="查看原文"}}
            val monitor=instrumentation.addMonitor(CaptureRecordsActivity::class.java.name,null,false)
            try { clickText(s,"查看原文");val reader=instrumentation.waitForMonitorWithTimeout(monitor,10_000) as? CaptureRecordsActivity;assertNotNull(reader)
                until("Existing member reader preserves the actual original"){main{views(reader!!.window.decorView).filterIsInstance<TextView>().any{it.text.toString()=="Generated original discovery record: completion remains unknown."}}};main{reader!!.finish()}
            } finally { instrumentation.removeMonitor(monitor) }
            ready(s,"Return keeps exact pinned Material"){a->shown(a).any{it.tag=="material-ask"}}
            assertEquals(ref,choose(s));question(s,"Generated native question using asset-only Material")
            screenshot(s,"asset-only-material-scope");click(s,"Send"){it.contentDescription=="发送"}
            until("Asset-only pinned read and actual controlled answer"){saved().optString("runStatus")=="completed"}
            assertEquals(ref,control("state").getJSONObject("lastQuery").getString("anchorMaterialRef"));assertEquals(ref,control("state").getJSONArray("materialReads").getString(0));screenshot(s,"asset-only-material-answer")
        }
    }

}
