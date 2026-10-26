package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant

@RunWith(AndroidJUnit4::class)
class LibrarySourceJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if(root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun waitFor(label: String, condition: () -> Boolean) { val until=SystemClock.elapsedRealtime()+30000; while(!condition()) { check(SystemClock.elapsedRealtime()<until) { label }; Thread.sleep(60) } }
    private fun guard() { require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev") && InstrumentationRegistry.getArguments().getString("recordEditorFixture")=="true"); require(!Settings(context).enabled && !ProjectionService.running) }
    private fun api(): CentralClient { val args=InstrumentationRegistry.getArguments(); val server=requireNotNull(args.getString("uiJourneyServer")); require(java.net.URI(server).host in setOf("10.0.2.2","127.0.0.1")); return CentralClient(server,requireNotNull(args.getString("uiJourneyToken"))) }
    @Test fun actualFileUploadVersionsMaterialReadDenialAndNativeRestore() {
        guard(); val args=InstrumentationRegistry.getArguments(); val api=api(); val settings=Settings(context)
        context.localSources().sources().filter { it.id.startsWith("generated-b1-") }.forEach { context.fileArchives().remove(it.id); context.localSources().remove(it.id) }
        val config=settings.read().copy(server=args.getString("uiJourneyServer")!!,token=args.getString("uiJourneyToken")!!,wifiOnly=false,syncPaused=false,syncMode="manual",authSignedOut=false,authExpiresAt=0,authProcess="",debugHttp=true)
        settings.save(config,confirmCentralEndpoint=true); MoteI18n.select(context,"zh-CN")
        api.post("/api/fixture/library-denial",JSONObject().put("mode","none"))
        val source=LocalSource(id="generated-b1-"+System.nanoTime(),name="Generated B1 file",kind="local-files",uri="content://generated/b1.txt",retention="archive",tree=false,syncContinuously=false,allowRead=true)
        context.localSources().save(source); api.post("/api/sources",source.registration(settings.deviceId))
        val queue=context.fileArchives(); val external=requireNotNull(source.uri)
        fun prepare(text: String): JSONObject {
            val bytes=text.toByteArray(); val item=JSONObject().put("externalId",external).put("uri",external).put("title","Generated B1 original.txt").put("kind","file").put("layer","original").put("text","").put("mimeType","text/plain").put("observedAt",Instant.now().toString()).put("metadata",JSONObject().put("version",1).put("file",JSONObject().put("sizeBytes",bytes.size)))
            queue.observe(source,item,queue.configure(source).getString("generation"),0)
            return queue.prepare(source,{ByteArrayInputStream(bytes)},{true},captureImmediately=true)!!
        }
        val first=prepare("Generated B1 original bytes version one")
        var attempts=0; while(!FileUpload.sync(context,source,config){true}) check(attempts++<10)
        val firstRow=queue.row(source.id,external); val firstId=firstRow.getString("captureId"); val firstRevision=firstRow.getString("revision")
        val bytes=ByteArrayOutputStream(); api.download("/api/files/$firstId/content",bytes); assertEquals("Generated B1 original bytes version one",bytes.toString("UTF-8"))
        val material=api.post("/api/fixture/library-material",JSONObject().put("sourceId",source.id).put("externalId",external).put("captureId",firstId).put("text","Generated B1 organized words differ from original"))
        val record=api.get("/api/capture-browser/$firstId"); assertEquals(material.getString("ref"),record.getString("memoryMaterialRef"))
        val saved=JSONObject().put("source",source.id).put("external",external).put("firstId",firstId).put("firstRevision",firstRevision).put("materialId",material.getString("id")).put("materialRevision",material.getString("revision"))
        File(context.filesDir,"generated-b1-keys.json").writeText(saved.toString())
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","LIBRARY")).awaitMainUi().use { scenario ->
            fun shown(text:String):Boolean { var answer=false; scenario.onActivity { answer=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.contains(text) } }; return answer }
            fun titleCount():Int { var count=0; scenario.onActivity { count=views(it.window.decorView).filterIsInstance<TextView>().count { view->view.isShown && view.text.toString()=="Generated B1 original.txt" } }; return count }
            fun click(text:String) { scenario.onActivity { views(it.window.decorView).filterIsInstance<TextView>().first { view->view.isShown && view.text.toString()==text }.performClick() } }
            waitFor("actual joined file and distinct material") { titleCount()==1 && shown("Generated B1 organized material") && shown("中央可读") }
            click("刷新"); waitFor("duplicate refresh remains one exact original") { titleCount()==1 && shown("Generated B1 organized material") }
            scenario.recreate(); waitFor("B1 Activity restored") { titleCount()==1 && shown("Generated B1 organized material") }
            val pending=prepare("Generated B1 newer saved original bytes version two")
            val revision=pending.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision")
            assertNotEquals(firstRevision,revision); assertNull(LocalContentPresentation.currentReceipt(queue.row(source.id,external)))
            saved.put("pendingRevision",revision); File(context.filesDir,"generated-b1-keys.json").writeText(saved.toString())
            click("刷新"); waitFor("new saved version does not merge with prior Central original") { titleCount()==2 }
            api.post("/api/fixture/library-denial",JSONObject().put("mode","forbidden")); click("刷新")
            waitFor("403 clears remote original and material but preserves local pending original") { titleCount()==1 && !shown("Generated B1 organized material") }
            assertEquals("Generated B1 newer saved original bytes version two",queue.pendingPreview(source.id,external,revision)!!.first)
            api.post("/api/fixture/library-denial",JSONObject().put("mode","offline")); click("刷新")
            waitFor("HTTP unavailable retains local original") { titleCount()==1 && !shown("Generated B1 organized material") }
            api.post("/api/fixture/library-denial",JSONObject().put("mode","none")); click("刷新")
            waitFor("recovery restores precise versions") { titleCount()==2 && shown("Generated B1 organized material") }
            scenario.onActivity { views(it.window.decorView).filterIsInstance<Spinner>().single { view->view.contentDescription==MoteI18n.text("资料位置") }.setSelection(1) }
            waitFor("local filter") { titleCount()==1 && !shown("Generated B1 organized material") }
            scenario.recreate(); waitFor("local filter restored with versions") { titleCount()==1 && !shown("Generated B1 organized material") }
            scenario.onActivity { views(it.window.decorView).filterIsInstance<Spinner>().single { view->view.contentDescription==MoteI18n.text("资料位置") }.setSelection(0) }
            api.post("/api/fixture/library-denial",JSONObject().put("mode","none").put("delayMs",1000));click("刷新")
            settings.signOut()
            Thread.sleep(1300)
            waitFor("late source response cannot republish after sign out") { titleCount()==1 && !shown("Generated B1 organized material") }
            api.post("/api/fixture/library-denial",JSONObject().put("mode","none")); settings.signIn(config.server,config.token,86400000)
            scenario.recreate();waitFor("reconnect revalidates exact source versions") { titleCount()==2 && shown("Generated B1 organized material") }
            scenario.onActivity { activity ->
                val target=views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()=="Generated B1 original.txt" }
                target.requestRectangleOnScreen(android.graphics.Rect(0,0,target.width,target.height),true)
                val root=activity.window.decorView;val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(image));File(context.filesDir,"generated-b1-library.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };image.recycle()
            }

        }
        val reader=Intent(context,LibrarySourceReaderActivity::class.java).putExtra("origin",config.server).putExtra("type","material").putExtra("source",material.getString("id")).putExtra("revision",material.getString("revision"))
        ActivityScenario.launch<LibrarySourceReaderActivity>(reader).use { scenario ->
            fun shown(text:String):Boolean { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.contains(text) } };return found }
            waitFor("real pinned Material reader and actual member") { shown("Generated B1 organized words differ from original") && shown("capture:$firstId") }
            scenario.recreate();waitFor("Material pinned version restored") { shown("Generated B1 organized words differ from original") }
            val monitor=instrumentation.addMonitor(LibrarySourceReaderActivity::class.java.name,null,false)
            try {
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()=="capture:$firstId" }.performClick() }
                val originalReader=instrumentation.waitForMonitorWithTimeout(monitor,15000) as LibrarySourceReaderActivity
                waitFor("actual Material member opens retained original file reader") { var found=false;instrumentation.runOnMainSync { found=views(originalReader.window.decorView).filterIsInstance<TextView>().any { it.text.toString()==MoteI18n.text("保存原件") } };found }
                instrumentation.runOnMainSync { originalReader.finish() }
                waitFor("return keeps pinned Material") { shown("Generated B1 organized words differ from original") }
            } finally { instrumentation.removeMonitor(monitor) }

        }
        var retry=0;while(!FileUpload.sync(context,source,settings.read()){true}) check(retry++<10)
        val secondRow=queue.row(source.id,external);val secondId=secondRow.getString("captureId")
        assertNotEquals(firstId,secondId)
        val newBytes=ByteArrayOutputStream();api.download("/api/files/$secondId/content",newBytes);assertEquals("Generated B1 newer saved original bytes version two",newBytes.toString("UTF-8"))
        val oldBytes=ByteArrayOutputStream();api.download("/api/files/$firstId/content",oldBytes);assertEquals("Generated B1 original bytes version one",oldBytes.toString("UTF-8"))
        val secondMaterial=api.post("/api/fixture/library-material",JSONObject().put("sourceId",source.id).put("externalId",external).put("captureId",secondId).put("text","Generated B1 organized version two"))
        assertNotEquals(material.getString("revision"),secondMaterial.getString("revision"))
        assertTrue(api.get("/api/materials/"+material.getString("id")+"/read?revision="+material.getString("revision")).getString("text").contains("Generated B1 organized words differ from original"))
        val third=prepare("Generated B1 newer saved original bytes version three")
        saved.put("pendingRevision",third.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"));File(context.filesDir,"generated-b1-keys.json").writeText(saved.toString())
    }
    private fun generatedReaderMaterial(): Triple<LocalSource,JSONObject,JSONObject> {
        guard();val api=api();val settings=Settings(context);MoteI18n.select(context,"zh-CN")
        val config=settings.read();val source=LocalSource(id="generated-b1-range-"+System.nanoTime(),name="Generated range file",kind="local-files",uri="content://generated/range.txt",retention="archive",tree=false,syncContinuously=false,allowRead=true)
        context.localSources().save(source);api.post("/api/sources",source.registration(settings.deviceId))
        val original="Generated short original";val queue=context.fileArchives();val external=requireNotNull(source.uri)
        val item=JSONObject().put("externalId",external).put("uri",external).put("title","Generated range.txt").put("kind","file").put("layer","original").put("text","").put("mimeType","text/plain").put("observedAt",Instant.now().toString()).put("metadata",JSONObject().put("version",1).put("file",JSONObject().put("sizeBytes",original.toByteArray().size)))
        queue.observe(source,item,queue.configure(source).getString("generation"),0)
        queue.prepare(source,{ByteArrayInputStream(original.toByteArray())},{true},captureImmediately=true)
        var tries=0;while(!FileUpload.sync(context,source,config){true})check(tries++<10)
        val row=queue.row(source.id,external)
        val material=api.post("/api/fixture/library-material",JSONObject().put("sourceId",source.id).put("externalId",external).put("captureId",row.getString("captureId")).put("text","Generated derived body differs from original. ".repeat(140)))
        return Triple(source,row,material)
    }
    @Test fun fileDerivedRangeTracksDisplayedBodyAcrossPages() {
        val (source,row,material)=generatedReaderMaterial();val api=api();val external=requireNotNull(source.uri);val original="Generated short original"
        val path="/api/materials/"+material.getString("id")+"/read?revision="+material.getString("revision")+"&length=4000&offset="
        val first=api.get(path+"0");val next=first.getJSONObject("textRange").getInt("nextOffset");val second=api.get(path+next)
        assertNotEquals(original.length,first.getString("text").length)
        ActivityScenario.launch<FileContentActivity>(Intent(context,FileContentActivity::class.java).putExtra("sourceId",source.id).putExtra("externalId",external).putExtra("sourceRevision",row.getString("revision"))).use { scenario ->
            fun shown(text:String):Boolean { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.toString()==text } };return found }
            fun range(page:JSONObject,start:Int)=MoteI18n.text("衍生内容范围：{0}–{1} / {2} 字符",start,start+page.getString("text").length,page.getJSONObject("textRange").getInt("total"))
            waitFor("displayed derived body has its own range") { shown(first.getString("text")) && shown(range(first,0)) }
            val newer=api.post("/api/fixture/library-material",JSONObject().put("sourceId",source.id).put("externalId",external).put("captureId",row.getString("captureId")).put("text","New revision must not replace the pinned body. ".repeat(190)))
            assertNotEquals(material.getString("revision"),newer.getString("revision"))
            scenario.onActivity { activity -> assertFalse(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.startsWith("原文范围：") });views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()==MoteI18n.text("继续展开") }.performClick() }
            waitFor("next derived page keeps accurate range and return label") { shown(second.getString("text")) && shown(range(second,next)) && shown(MoteI18n.text("返回衍生内容开头")) }
            scenario.recreate();waitFor("saved Material revision survives recreation at nonzero offset") { shown(second.getString("text")) && shown(range(second,next)) }
        }
    }
    @Test fun pausedMemberLookupRestoresPinnedMaterialInsteadOfBlankPage() {
        val (_,row,material)=generatedReaderMaterial();val api=api();val ref="capture:"+row.getString("captureId")
        val intent=Intent(context,LibrarySourceReaderActivity::class.java).putExtra("origin",Settings(context).read().server).putExtra("type","material").putExtra("source",material.getString("id")).putExtra("revision",material.getString("revision"))
        ActivityScenario.launch<LibrarySourceReaderActivity>(intent).use { scenario ->
            fun shown(text:String):Boolean { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.toString()==text } };return found }
            waitFor("actual pinned member available") { shown(ref) }
            api.post("/api/fixture/library-member-delay",JSONObject().put("delayMs",2000))
            try {
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()==ref }.performClick() }
                waitFor("member request is held by fixture") { api.get("/api/fixture/library-member-delay").getInt("requests")>0 }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                Thread.sleep(2400)
                val deadline=SystemClock.elapsedRealtime()+4000
                waitFor("discarded member navigation must restore pinned page") { check(SystemClock.elapsedRealtime()<deadline) { "Reader stayed blank after member request completed" };shown(ref) && shown("Generated B1 organized material") }
            } finally { api.post("/api/fixture/library-member-delay",JSONObject().put("delayMs",0)) }
        }
    }
    @Test fun mismatchedPinnedVersionNeverFallsBackToAnotherOriginal() {
        guard();val saved=JSONObject(File(context.filesDir,"generated-b1-keys.json").readText());val access=CentralAccess.resolve(context)
        val intent=Intent(context,LibrarySourceReaderActivity::class.java).putExtra("origin",access.server).putExtra("type","original").putExtra("source",saved.getString("source")).putExtra("external",saved.getString("external")).putExtra("device",Settings(context).deviceId).putExtra("revision","generated-wrong-revision").putExtra("capture",saved.getString("firstId"))
        ActivityScenario.launch<LibrarySourceReaderActivity>(intent).use { scenario ->
            waitFor("wrong pinned revision reports failure") { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.contains("此版本已变化") } };found }
            scenario.onActivity { activity -> assertFalse(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("Generated B1 original bytes") || it.text.toString()==MoteI18n.text("保存原件") }) }
        }
    }
    @Test fun localSourcePaginationReferenceMetadataAndPinnedReader() {
        guard();val store=context.localSources();val at=Instant.now().toString()
        val source=LocalSource(id="generated-b1-calendar-"+System.nanoTime(),name="Generated B1 calendar",kind="local-calendar",calendarId=987654,description="Generated source description remains readable")
        store.save(source)
        val bodies=(0 until 25).map { index -> JSONObject().put("externalId","generated-calendar-$index").put("observedAt",at).put("title","Generated source $index").put("kind","calendar").put("layer","snapshot").put("text","Generated saved source body $index").put("calendar",JSONObject().put("start",at).put("end",at).put("allDay",false).put("status","confirmed")) }
        store.scan(source,SourceScan(bodies,true,at));// A background permission probe may update diagnostics while the read runs.
        // Original bodies, pending versions and receipt fields must remain byte-identical.
        fun retainedState() = store.state(source.id).apply { remove("status"); remove("statusAt") }.toString()
        val before=retainedState()
        // A slow Central must not hold the local first page or local pagination hostage.
        api().post("/api/fixture/library-denial",JSONObject().put("mode","none").put("delayMs",3000))
        try {
            val started=SystemClock.elapsedRealtime()
            ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","LIBRARY")).awaitMainUi().use { scenario ->
                fun count():Int { var count=0;scenario.onActivity { count=views(it.window.decorView).filterIsInstance<TextView>().count { view->view.isShown && view.text.startsWith("Generated source ") } };return count }
                waitFor("local first page before delayed Central") { count()>=20 }
                assertTrue("local first page waited for Central",SystemClock.elapsedRealtime()-started<2500)
                scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().first { it.isEnabled && it.text.toString()==MoteI18n.text("加载更多来源资料") }.performClick() }
                waitFor("local second page while Central is still pending") { count()==25 }
                assertTrue("local pagination waited for Central",SystemClock.elapsedRealtime()-started<3000)
            }
        } finally { api().post("/api/fixture/library-denial",JSONObject().put("mode","none")) }
        val page=LibraryLocalSources.page(context,"1970-01-01T00:00:00Z",Instant.now().plusSeconds(1).toString(),null,"source",source.id)
        val next=LibraryLocalSources.page(context,"1970-01-01T00:00:00Z",Instant.now().plusSeconds(1).toString(),page.cursor,"source",source.id)
        assertEquals(20,page.items.size);assertEquals(5,next.items.size);assertNull(next.cursor);assertEquals(before,retainedState())
        val row=page.items.first();val intent=Intent(context,LibrarySourceReaderActivity::class.java).putExtra("type","original").putExtra("source",source.id).putExtra("external",row.getString("externalId")).putExtra("revision",row.getString("revision")).putExtra("local",true)
        ActivityScenario.launch<LibrarySourceReaderActivity>(intent).use { scenario ->
            fun shown(text:String):Boolean { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.contains(text) } };return found }
            waitFor("non-file source uses stored original without provider permission") { shown(row.getJSONObject("localItem").getString("text")) && shown(source.description) }
            scenario.recreate();waitFor("non-file fixed revision reader restores") { shown(row.getJSONObject("localItem").getString("text")) }
        }
        val reference=source.copy(id="generated-b1-reference-"+System.nanoTime(),name="Generated B1 reference",retention="reference");store.save(reference)
        store.scan(reference,SourceScan(listOf(JSONObject(bodies.first().toString()).put("layer","reference").put("text","")),true,at))
        val referencePage=LibraryLocalSources.page(context,"1970-01-01T00:00:00Z",Instant.now().plusSeconds(1).toString(),null,"source",reference.id)
        assertFalse(referencePage.items.single().getBoolean("localReadable"));assertEquals("",referencePage.items.single().getJSONObject("localItem").getString("text"))
        store.remove(source.id);store.remove(reference.id)
    }
    @Test fun pendingOriginalSurvivesProcessRestartAndCancelledExport() {
        guard(); val saved=JSONObject(File(context.filesDir,"generated-b1-keys.json").readText());val source=saved.getString("source");val external=saved.getString("external");val revision=saved.getString("pendingRevision")
        assertEquals("Generated B1 newer saved original bytes version three",context.fileArchives().pendingPreview(source,external,revision)!!.first)
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","LIBRARY")).awaitMainUi().use { scenario ->
            waitFor("real offline Central still renders local source original after process restart") { var found=false;scenario.onActivity { activity ->
                val texts=views(activity.window.decorView).filterIsInstance<TextView>()
                found=texts.any { view->view.isShown && view.text.toString()=="Generated B1 original.txt" }
                if(!found)texts.firstOrNull { it.isShown && it.isEnabled && it.text.toString()==MoteI18n.text("加载更多来源资料") }?.performClick()
            };found }
        }
        ActivityScenario.launch<FileContentActivity>(Intent(context,FileContentActivity::class.java).putExtra("sourceId",source).putExtra("externalId",external).putExtra("sourceRevision",revision)).use { scenario ->
            fun shown(text:String):Boolean { var found=false;scenario.onActivity { found=views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown && view.text.contains(text) } };return found }
            waitFor("retained exact original after restart") { shown("Generated B1 newer saved original bytes version three") }
            scenario.recreate();waitFor("pending reader Activity restored") { shown("Generated B1 newer saved original bytes version three") }
            scenario.onActivity { activity -> views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()==MoteI18n.text("导出本机保存的完整原件") }.performClick() }
            waitFor("system export picker is foreground before cancellation") {
                instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.let { it.contains("documentsui") } == true
            }
            instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK").close()
            waitFor("cancel returns to retained original") { shown("Generated B1 newer saved original bytes version three") }
            assertEquals(revision,context.fileArchives().row(source,external).getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"))
        }
    }
}
