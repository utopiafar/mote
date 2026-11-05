package dev.mote.collector

import android.app.Activity
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
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Manually selected final Central journey. No test answers or server responses are substituted. */
@RunWith(AndroidJUnit4::class)
class FinalCentralJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val output get() = File(context.filesDir,"final-central-ui").apply { mkdirs() }
    private fun <T> main(block: () -> T): T { val result=AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }; return result.get().getOrThrow() }
    private fun views(root: View): List<View> = listOf(root) + if(root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun currentOrNull(): Activity? = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull()
    private fun current(): Activity = requireNotNull(currentOrNull())
    private fun shown() = android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun until(label: String, timeout: Long = 30_000, check: () -> Boolean) {
        val end=SystemClock.elapsedRealtime()+timeout
        while(SystemClock.elapsedRealtime()<end) { if(check()) return; Thread.sleep(80) }; fail(label)
    }
    private fun configuration(): JSONObject {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeFinalCentral") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val file=File(context.filesDir,"final-central-journey.json"); require(file.isFile)
        val config=JSONObject(file.readText()); require(config.getBoolean("generatedOnly"))
        val origin=java.net.URI(config.getString("origin")); require(origin.scheme == "http" && origin.host in setOf("127.0.0.1","localhost") && origin.port > 0)
        require(config.getString("token").length >= 32 && !Settings(context).enabled)
        MoteI18n.select(context,"zh-CN"); main { MoteAppearance.select(context,AppearancePreference.LIGHT) }
        return config
    }
    private fun connect(config: JSONObject): CentralClient {
        val settings=Settings(context); val origin=config.getString("origin"); val token=config.getString("token")
        ConnectionGuard.change(context,origin,bindLocal=true) {
            settings.saveConnection(origin,token,"Generated final Android",true)
            settings.save(settings.read().copy(syncMode="manual",syncPaused=false,wifiOnly=false,syncChargingOnly=false,syncBatteryNotLow=false),confirmCentralEndpoint=true)
        }
        return CentralClient(origin,token).also { assertEquals("owner",it.get("/api/connections/self").getJSONObject("credential").getString("scope")) }
    }
    private fun existingConnection(config:JSONObject):CentralClient {
        val settings=Settings(context);val current=settings.read();val origin=config.getString("origin")
        require(current.server.trimEnd('/')==origin&&settings.centralEndpoint().trimEnd('/')==origin&&current.connectionToken()==config.getString("token")) { "Read-only verification requires the existing selected owner connection" }
        val selected=CentralAccess.resolve(context);require(selected.server==origin)
        return requireNotNull(selected.client).also{assertEquals("owner",it.get("/api/connections/self").getJSONObject("credential").getString("scope"))}
    }
    private fun screenshot(name: String) {
        val latch=java.util.concurrent.CountDownLatch(1)
        main { current().window.decorView.postOnAnimation { current().window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5,java.util.concurrent.TimeUnit.SECONDS))
        main { val root=android.view.inspector.WindowInspector.getGlobalWindowViews().last { it.isShown && it.hasWindowFocus() }; val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
            try { root.draw(android.graphics.Canvas(image)); output.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } finally { image.recycle() }
        }
    }
    private fun click(label: String) {
        until("Native action unavailable: $label") { main { shown().filterIsInstance<TextView>().any { it.isEnabled && it.isClickable && (it.text.toString() == label || it.contentDescription?.toString() == label) } } }
        main { shown().filterIsInstance<TextView>().first { it.isEnabled && it.isClickable && (it.text.toString() == label || it.contentDescription?.toString() == label) }.performClick() }
    }
    @Test fun saveAndSynchronizeIndependentDescription() {
        val config=configuration(); val api=connect(config); val marker=UUID.randomUUID().toString()
        val original="Generated final Android record $marker: the review decision remains pending."
        val description="Generated owner context $marker: this is a test diary, not a completed commitment."
        val before=context.queue().dedupeIds().toSet()
        require(context.recordDraftStore().draft().let { it.optString("text").isBlank() && it.getJSONArray("attachments").length() == 0 })
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            until("Actual editor ready") { var ready=false; scenario.onActivity { a -> ready=views(a.window.decorView).filterIsInstance<EditText>().any { it.contentDescription == "正在想什么" && it.isEnabled } }; ready }
            scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<EditText>().single { it.contentDescription == "正在想什么" }.setText(original); views(a.window.decorView).single { it.tag == "record-describe-toggle" }.performClick(); views(a.window.decorView).filterIsInstance<EditText>().single { it.tag == "record-description" }.setText(description) }
            until("Both fields persisted independently") { context.recordDraftStore().draft().let { it.getString("text") == original && it.getString("description") == description } }
            screenshot("record-before-save"); click("保存")
            until("Explicit native save creates exactly one record") { (context.queue().dedupeIds().toSet()-before).size == 1 }
        }
        val id=(context.queue().dedupeIds().toSet()-before).single()
        assertEquals(description,context.queue().capture(id)!!.getJSONObject("metadata").getString("ownerDescription"))
        UploadWorker.schedule(context,Settings(context).read(),true)
        until("Real Central receipt required",120_000) { context.queue().capture(id)?.optBoolean("uploaded") == true }
        val remote=api.get("/api/capture-browser/$id")
        assertEquals(original,remote.getString("ocrText")); assertEquals(listOf(description),NativeRecordDescription.read(remote,true))
        output.resolve("save-result.json").writeText(JSONObject().put("generatedOnly",true).put("sourceRecordId",id).put("deviceId",Settings(context).deviceId).put("descriptionVerified",true).put("centralReceived",true).toString(2))
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { screenshot("home-after-save") }
    }
    /** Reopens the already ACKed native record; never creates or uploads a second note. */
    @Test fun verifyPersistedIndependentDescriptionInCentralReader() {
        val config=configuration();val api=existingConnection(config);val id=config.getString("existingRecordId")
        val local=requireNotNull(context.queue().capture(id));assertTrue("Original local ACK remains durable",local.getBoolean("uploaded"))
        val original=local.getString("ocrText");val description=local.getJSONObject("metadata").getString("ownerDescription")
        val remote=api.get("/api/capture-browser/$id");assertEquals(original,remote.getString("ocrText"));assertEquals(listOf(description),NativeRecordDescription.read(remote,true));assertFalse(remote.getJSONObject("metadata").has("ownerDescription"));assertFalse(original.contains(description))
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","notes")).use {
            until("Actual Central notes list contains this received original"){main{(currentOrNull() as? CentralActivity)?.isWorking==false&&shown().filterIsInstance<TextView>().any{it.text.toString()==original}}}
            main{val label=shown().filterIsInstance<TextView>().single{it.text.toString()==original};val card=label.parent as ViewGroup;views(card).filterIsInstance<TextView>().single{it.text.toString()=="查看原文"}.performClick()}
            until("Public CentralLibrary route renders exact original and independent declaration"){main{currentOrNull() is CaptureRecordsActivity&&shown().filterIsInstance<TextView>().any{it.text.toString()==original}&&shown().filterIsInstance<TextView>().any{it.text.toString()==description}}};screenshot("received-record-independent-description")
            main{shown().single{it.contentDescription=="返回上一页"}.performClick()}
            until("Return to same Central notes and durable receipt"){main{currentOrNull() is CentralActivity&&shown().filterIsInstance<TextView>().any{it.text.toString()==original}}&&context.queue().capture(id)?.optBoolean("uploaded")==true};screenshot("received-record-return")
        }
        output.resolve("save-result.json").writeText(JSONObject().put("generatedOnly",true).put("sourceRecordId",id).put("deviceId",Settings(context).deviceId).put("descriptionVerified",true).put("centralReceived",true).put("readOnlyVerification",true).put("descriptionTransport","attributionContext.recordContextStatements").put("publicCentralReaderVerified",true).toString(2))
    }
    @Test fun continueSharedConversationAndReturnFromExactCitation() {
        val config=configuration(); val api=connect(config); val id=config.getString("conversationId"); val question=config.getString("question")
        val prior=api.get("/api/conversations/$id?limit=50").getJSONArray("turns"); val priorIds=(0 until prior.length()).map { prior.getJSONObject(it).getString("id") }.toSet()
        require(prior.length() > 0)
        val resolveGeneratedDraft = config.optBoolean("verifyGeneratedDraftGuard")
        if (resolveGeneratedDraft) {
            // This path is selected only for a generated, externally snapshotted test profile.
            // A real user's draft is never discarded by this test.
            val store = CentralStateFile(File(context.noBackupFilesDir, "central-native/" + SourceRules.hash(api.server)), "ask", context.secretBox())
            val saved = CentralDraftWrites.barrier { store.read() }
            val savedQuestion = saved.optString("question")
            val savedAttachments = saved.optJSONArray("attachments")?.toString() ?: "[]"
            require(savedQuestion.isNotBlank() && saved.optString("conversationId") != id)
            ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",id)).use {
                until("Existing draft blocks switching") { main { shown().filterIsInstance<TextView>().any { it.text.toString() == "还有未发送的内容" } } }
                screenshot("draft-switch-guard")
                click("继续编辑")
                until("Continue editing preserves the existing draft") { main { shown().filterIsInstance<EditText>().any { it.contentDescription == "你的问题" && it.text.toString() == savedQuestion } } }
                val retained = CentralDraftWrites.barrier { store.read() }
                assertEquals(savedQuestion, retained.optString("question"))
                assertEquals(savedAttachments, retained.optJSONArray("attachments")?.toString() ?: "[]")
                screenshot("draft-continued")
            }
            val after = api.get("/api/conversations/$id?limit=50").getJSONArray("turns")
            assertEquals("Cancelling the switch must not admit a query", priorIds, (0 until after.length()).map { after.getJSONObject(it).getString("id") }.toSet())
        }
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",id)).use {
            if (resolveGeneratedDraft) {
                until("Generated draft switch requires explicit confirmation") { main { shown().filterIsInstance<TextView>().any { it.text.toString() == "还有未发送的内容" } } }
                click("舍弃并切换")
            }
            until("Shared conversation and composer loaded") { main { (current() as? CentralActivity)?.let { !it.isWorking && it.selectedAskConversationId==id } == true && shown().filterIsInstance<EditText>().any { it.contentDescription == "你的问题" && it.isEnabled } } }
            main { assertEquals("Explicit shared conversation must be selected before any model admission",id,(current() as CentralActivity).selectedAskConversationId) }
            screenshot("shared-conversation-before")
            main { shown().filterIsInstance<EditText>().single { it.contentDescription == "你的问题" }.setText(question) }; click("发送")
            var turn: JSONObject?=null
            until("Actual live model turn must complete",300_000) {
                val turns=api.get("/api/conversations/$id?limit=50").getJSONArray("turns")
                turn=(0 until turns.length()).map { turns.getJSONObject(it) }.firstOrNull { it.getString("id") !in priorIds && it.getString("question") == question }
                turn?.let { assertFalse("Actual model turn failed",it.optString("status") in setOf("failed","cancelled")) }
                turn?.optString("status") == "completed"
            }
            verifyPersistedTurn(config,api,id,turn!!,newInference=true)
        }
    }
    /** Continues UI verification after a completed real turn; never admits another query. */
    @Test fun readPersistedSharedTurnAndReturnFromExactCitation() {
        val config=configuration();val api=existingConnection(config);val id=config.getString("conversationId");val turnId=config.getString("existingTurnId")
        val snapshot=api.get("/api/conversations/$id?limit=50");assertEquals(id,snapshot.getString("id"))
        val turns=snapshot.getJSONArray("turns");val turn=(0 until turns.length()).map{turns.getJSONObject(it)}.single{it.getString("id")==turnId}
        assertEquals(config.getString("question"),turn.getString("question"));assertEquals("completed",turn.getString("status"))
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",id)).use {
            until("Persisted actual target is selected before read-only citation work") { main { (current() as? CentralActivity)?.let{!it.isWorking&&it.selectedAskConversationId==id}==true&&shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.isEnabled} } }
            verifyPersistedTurn(config,api,id,turn,newInference=false)
        }
    }
    /** Reuses one completed real turn; saving a generated note must not start another query. */
    @Test fun savePersistedTurnWithExactIdentityAndReadableQuote() {
        val config=configuration();val api=connect(config);val id=config.getString("conversationId");val turnId=config.getString("existingTurnId")
        val originalRuns=api.get("/api/query-runs").getJSONArray("items").toString()
        val snapshot=api.get("/api/conversations/$id?limit=50");val turns=snapshot.getJSONArray("turns")
        val turn=(0 until turns.length()).map(turns::getJSONObject).single{it.getString("id")==turnId}
        val answer=turn.getJSONObject("result");val raw=turn.getString("question")+"\n\n"+answer.getString("answer")
        val citations=answer.getJSONArray("citations");val ids=(0 until citations.length()).map{citations.getJSONObject(it).getString("id")}.distinct()
        val evidence=config.getString("expectedEvidenceId");val number=ids.indexOf(evidence)+1;require(number>0)
        val before=context.queue().dedupeIds().toSet();assertEquals("Do not upload unrelated queued originals",0,context.queue().pendingSync().count)
        val draft="Generated same-turn inline return draft";val description="Generated independent Android context for $turnId"
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",id)).use {
            if(config.optBoolean("verifyGeneratedDraftGuard")) {
                until("Previously snapshotted generated draft requires confirmation") { main { shown().filterIsInstance<TextView>().any { it.text.toString()=="还有未发送的内容" } } };click("舍弃并切换")
            }
            until("Saved actual turn is selected") { main { (currentOrNull() as? CentralActivity)?.let{!it.isWorking&&it.selectedAskConversationId==id}==true&&shown().any{it.tag=="ask-answer:$turnId"} } }
            main{shown().filterIsInstance<EditText>().single{it.contentDescription=="你的问题"}.setText(draft)}
            var point:FloatArray?=null
            until("Exact verified inline citation is laid out") { main {
                val view=shown().filterIsInstance<TextView>().single{it.tag=="ask-answer:$turnId"};val layout=view.layout?:return@main false
                val text=view.text as? android.text.Spanned?:return@main false
                val span=text.getSpans(0,text.length,android.text.style.ClickableSpan::class.java).firstOrNull { text.subSequence(text.getSpanStart(it),text.getSpanEnd(it)).toString()=="[$number]" }?:return@main false
                val start=text.getSpanStart(span);val end=text.getSpanEnd(span);val line=layout.getLineForOffset(start)
                val x=(layout.getPrimaryHorizontal(start)+layout.getPrimaryHorizontal(end))/2+view.totalPaddingLeft;val y=(layout.getLineTop(line)+layout.getLineBottom(line))/2f+view.totalPaddingTop
                view.requestRectangleOnScreen(android.graphics.Rect(x.toInt(),y.toInt(),x.toInt()+1,y.toInt()+1),true)
                val where=IntArray(2);view.getLocationOnScreen(where);point=floatArrayOf(where[0]+x,where[1]+y);true
            } }
            // requestRectangleOnScreen may finish after the first animation frame; measure only
            // after it settles so the before/after comparison reflects the user's actual position.
            Thread.sleep(500);instrumentation.waitForIdleSync()
            fun position(): Pair<Int,Int> = main {
                val question=shown().filterIsInstance<TextView>().single{it.text.toString()==turn.getString("question")};val location=IntArray(2);question.getLocationOnScreen(location)
                shown().filterIsInstance<android.widget.ScrollView>().first().scrollY to location[1]
            }
            val beforePosition=position()
            val retainedViews = main { shown().filterIsInstance<android.widget.ScrollView>().first() to shown().filterIsInstance<TextView>().single{it.text.toString()==turn.getString("question")} }
            main {
                val view=shown().filterIsInstance<TextView>().single{it.tag=="ask-answer:$turnId"};val text=view.text as android.text.Spanned
                val span=text.getSpans(0,text.length,android.text.style.ClickableSpan::class.java).first{ text.subSequence(text.getSpanStart(it),text.getSpanEnd(it)).toString()=="[$number]" }
                val start=text.getSpanStart(span);val end=text.getSpanEnd(span);val layout=view.layout;val line=layout.getLineForOffset(start);val where=IntArray(2);view.getLocationOnScreen(where)
                point=floatArrayOf(where[0]+(layout.getPrimaryHorizontal(start)+layout.getPrimaryHorizontal(end))/2+view.totalPaddingLeft,where[1]+(layout.getLineTop(line)+layout.getLineBottom(line))/2f+view.totalPaddingTop)
            }
            screenshot("saved-turn-inline-before")
            val down=SystemClock.uptimeMillis();instrumentation.sendPointerSync(android.view.MotionEvent.obtain(down,down,android.view.MotionEvent.ACTION_DOWN,point!![0],point!![1],0));instrumentation.sendPointerSync(android.view.MotionEvent.obtain(down,down+50,android.view.MotionEvent.ACTION_UP,point!![0],point!![1],0))
            val afterTapPosition=main { val location=IntArray(2);retainedViews.second.getLocationOnScreen(location);retainedViews.first.scrollY to location[1] }
            val original=api.get("/api/capture-browser/$evidence").getString("ocrText")
            until("Inline citation opens the exact stored original") { main { currentOrNull() is CaptureRecordsActivity&&shown().filterIsInstance<TextView>().any{it.text.toString()==original} } };screenshot("saved-turn-inline-original")
            main{shown().single{it.contentDescription=="返回上一页"}.performClick()}
            until("Inline citation returns to the same turn and unsent draft") { main { (currentOrNull() as? CentralActivity)?.selectedAskConversationId==id&&shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.text.toString()==draft}&&shown().any{it.tag=="ask-answer:$turnId"} } }
            Thread.sleep(500);instrumentation.waitForIdleSync();val afterPosition=position();screenshot("saved-turn-inline-return")
            output.resolve("inline-scroll-result.json").writeText(JSONObject().put("beforeScroll",beforePosition.first).put("afterTapScroll",afterTapPosition.first).put("afterScroll",afterPosition.first).put("beforeQuestionY",beforePosition.second).put("afterTapQuestionY",afterTapPosition.second).put("afterQuestionY",afterPosition.second).toString(2))
            assertEquals("Citation return must preserve the actual scroll",beforePosition.first,afterPosition.first)
            assertTrue("The same turn must return to the same screen position",kotlin.math.abs(beforePosition.second-afterPosition.second)<=2)
            if (config.optBoolean("verifyInlineOnly")) {
                assertEquals("No new model request",originalRuns,api.get("/api/query-runs").getJSONArray("items").toString())
                output.resolve("inline-only-result.json").writeText(JSONObject().put("generatedOnly",true).put("newInference",false).put("conversationId",id).put("turnId",turnId).put("evidenceId",evidence).put("inlineCitationAndReturnVerified",true).toString(2))
                return@use
            }
            main {
                val question=shown().filterIsInstance<TextView>().single{it.text.toString()==turn.getString("question")};val parent=question.parent as ViewGroup
                val start=parent.indexOfChild(question)+1;val end=(start until parent.childCount).firstOrNull{(parent.getChildAt(it) as? TextView)?.text?.toString() in (0 until turns.length()).map{n->turns.getJSONObject(n).getString("question")}}?:parent.childCount
                val action=(start until end).flatMap{n->views(parent.getChildAt(n))}.filterIsInstance<TextView>().single{it.text.toString()=="保存为记录"&&it.isClickable}
                action.requestRectangleOnScreen(android.graphics.Rect(0,0,action.width,action.height),true);assertTrue(action.performClick())
            }
            until("Native record editor opened") { main { currentOrNull() is RecordEditorActivity } }
            if(main{shown().filterIsInstance<TextView>().any{it.text.toString()=="替换草稿"&&it.isClickable}})click("替换草稿")
            until("Saved quote carries the exact turn") { context.recordDraftStore().draft().getJSONObject("origin").optJSONArray("messageIds")?.optString(0)==turnId }
            val expectedDisplay=turn.getString("question")+"\n\n"+NativeAnswerPresentation.format(answer.getString("answer"),ids).text
            until("Readable quote is shown without changing the original") { main { shown().filterIsInstance<TextView>().any{it.tag=="record-origin-fulltext"&&it.text.toString()==expectedDisplay} } }
            val initial=context.recordDraftStore().draft();assertEquals(raw,initial.getJSONObject("origin").getString("text"));assertEquals(id,initial.getJSONObject("origin").getString("conversationId"));assertEquals("",initial.getString("text"))
            click("资料说明");main{shown().filterIsInstance<EditText>().single{it.tag=="record-description"}.setText(description)}
            until("Independent context is retained") { context.recordDraftStore().draft().optString("description")==description };screenshot("saved-turn-readable-quote")
            click("保存");until("Exactly one generated record is saved") {(context.queue().dedupeIds().toSet()-before).size==1}
            val recordId=(context.queue().dedupeIds().toSet()-before).single();val local=requireNotNull(context.queue().capture(recordId));val origin=local.getJSONObject("metadata").getJSONObject("noteOrigin")
            assertEquals(raw,origin.getString("text"));assertEquals(id,origin.getString("conversationId"));assertEquals(turnId,origin.getJSONArray("messageIds").getString(0));assertEquals("",local.getString("ocrText"));assertEquals(description,local.getJSONObject("metadata").getString("ownerDescription"))
            UploadWorker.schedule(context,Settings(context).read(),true)
            until("Exact generated note receives Central acknowledgement",120_000){context.queue().capture(recordId)?.optBoolean("uploaded")==true}
            val remote=api.get("/api/capture-browser/$recordId");val receivedOrigin=remote.getJSONObject("metadata").getJSONObject("noteOrigin")
            assertEquals(origin.toString(),receivedOrigin.toString());assertEquals(listOf(description),NativeRecordDescription.read(remote,true))
            assertEquals("No new model request",originalRuns,api.get("/api/query-runs").getJSONArray("items").toString())
            output.resolve("saved-turn-result.json").writeText(JSONObject().put("generatedOnly",true).put("newInference",false).put("conversationId",id).put("turnId",turnId).put("recordId",recordId).put("evidenceId",evidence).put("exactOriginReceived",true).put("independentDescriptionReceived",true).put("inlineCitationAndReturnVerified",true).toString(2))
        }
    }
    private fun verifyPersistedTurn(config:JSONObject,api:CentralClient,id:String,turn:JSONObject,newInference:Boolean) {
        val snapshot=api.get("/api/conversations/$id?limit=50");assertEquals(id,snapshot.getString("id"));val all=snapshot.getJSONArray("turns")
        val turns=(0 until all.length()).map{all.getJSONObject(it)};val index=turns.indexOfFirst{it.getString("id")==turn.getString("id")};assertTrue(index>=0)
        assertEquals(turn.toString(),turns[index].toString());val questions=turns.map{it.getString("question")}
        val result=turn.getJSONObject("result");val expected=config.optString("expectedModel","gpt-6.1-terra")
        val model=result.optJSONObject("modelSelection")?.optString("model").orEmpty().ifBlank{result.optJSONObject("usage")?.optString("model").orEmpty()};assertEquals("Actual stored requested model",expected,model)
        val raw=result.getJSONArray("citations");val citations=(0 until raw.length()).map{raw.getJSONObject(it)}.distinctBy{it.getString("id")};assertTrue(citations.isNotEmpty())
        val evidence=config.optString("expectedEvidenceId").ifBlank{citations.first().getString("id")};val number=citations.indexOfFirst{it.getString("id")==evidence}+1;assertTrue(number>0)
        assertTrue(CentralConversationReference.available(api,id,evidence));val original=api.get("/api/capture-browser/$evidence").getString("ocrText")
        fun currentTurnCitation():View {
            val question=shown().filterIsInstance<TextView>().single{it.text.toString()==questions[index]};val parent=question.parent as ViewGroup
            val children=(0 until parent.childCount).map(parent::getChildAt);val questionViews=children.filterIsInstance<TextView>().filter{it.text.toString() in questions}
            assertEquals("Complete rendered question sequence must match actual snapshot, including historical turns",questions,questionViews.map{it.text.toString()})
            assertSame(questionViews[index],question);val first=parent.indexOfChild(question)+1;val end=questionViews.getOrNull(index+1)?.let(parent::indexOfChild)?:parent.childCount
            val rows=children.subList(first,end).filter{it.contentDescription?.toString()?.startsWith("查看引用 ")==true}
            val expectedLabels=citations.mapIndexed{i,c->"查看引用 ${i+1} · "+c.optString("title").ifBlank{c.optString("appName").ifBlank{MoteI18n.text("查看原文依据")}}}
            assertEquals("This turn's complete citation list must match its stored result",expectedLabels,rows.map{it.contentDescription.toString()})
            return rows[number-1]
        }
        until("Exact persisted turn and all its references rendered"){main{runCatching{currentTurnCitation()}.isSuccess}}
        val laterDraft="Generated native citation-return draft "+turn.getString("id")
        main{shown().filterIsInstance<EditText>().single{it.contentDescription=="你的问题"}.setText(laterDraft);val row=currentTurnCitation();row.requestRectangleOnScreen(android.graphics.Rect(0,0,row.width,row.height),true)}
        screenshot("shared-conversation-answer")
        main{assertTrue(currentTurnCitation().performClick())}
        until("Exact original must render in the actual capture reader"){main{currentOrNull() is CaptureRecordsActivity&&shown().filterIsInstance<TextView>().any{it.text.toString()==original}}};screenshot("exact-citation")
        main{shown().single{it.contentDescription=="返回上一页"}.performClick()}
        until("Same conversation, exact turn and unsent draft return") { main { (currentOrNull() as? CentralActivity)?.selectedAskConversationId==id&&shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.text.toString()==laterDraft}&&runCatching{currentTurnCitation()}.isSuccess } };screenshot("citation-return")
        val runs=api.get("/api/query-runs").getJSONArray("items");val run=(0 until runs.length()).map{runs.getJSONObject(it)}.single{it.optString("turnId")==turn.getString("id")};assertEquals("completed",run.getString("status"));assertEquals(id,run.getString("conversationId"))
        output.resolve("conversation-result.json").writeText(JSONObject().put("generatedOnly",true).put("liveModel",true).put("newInferenceByThisMethod",newInference).put("model",model).put("conversationId",id).put("turnId",turn.getString("id")).put("queryRunId",run.getString("id")).put("evidenceId",evidence).put("renderedTurnIndex",index).put("exactCitationVerified",true).put("laterDraftRetained",true).toString(2))
    }
    /** Read-only final Discovery leg: root supplies the already persisted real report. */
    @Test fun readPersistedDiscoveryAndReturnFromExactInlineCitation() {
        val config=configuration();val api=existingConnection(config);val reportId=config.getString("discoveryRunId")
        val report=api.get("/api/insights/"+CentralScreens.encode(reportId));assertEquals(reportId,report.getString("runId"))
        val raw=report.getJSONArray("citations");val citations=(0 until raw.length()).map { raw.getJSONObject(it) }.distinctBy { it.getString("id") }
        assertTrue("The real persisted report must have actual citations",citations.isNotEmpty())
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","insights").putExtra("insightId",reportId)).use {
            until("Actual persisted Discovery body must render") { main { (currentOrNull() as? CentralActivity)?.isWorking == false && shown().filterIsInstance<TextView>().any { it.tag == "insight-content" && it.text.isNotBlank() && it.layout != null } } }
            var evidenceId="";var number=0;var renderedBody=""
            var point:FloatArray?=null
            until("Persisted Discovery inline has a current actual layout") { main {
                val content=shown().filterIsInstance<TextView>().single { it.tag == "insight-content" };val layout=content.layout ?: return@main false;val text=content.text as android.text.Spanned
                renderedBody=text.toString();assertEquals(NativeAnswerPresentation.format(report.getString("answer"),citations.map{it.getString("id")}).text,renderedBody)
                val spans=text.getSpans(0,text.length,android.text.style.ClickableSpan::class.java);assertTrue("Actual report needs a clickable inline original",spans.isNotEmpty())
                val span=spans.first();val start=text.getSpanStart(span);val end=text.getSpanEnd(span);val label=text.subSequence(start,end).toString()
                assertTrue(label.matches(Regex("\\[([1-9][0-9]*)]")));number=label.substring(1,label.length-1).toInt();assertTrue(number in 1..citations.size)
                evidenceId=citations[number-1].getString("id");assertTrue("The persisted model text must cite this exact original",report.getString("answer").contains("["+evidenceId+"]"))
                val line=layout.getLineForOffset(start);val x=(layout.getPrimaryHorizontal(start)+layout.getPrimaryHorizontal(end))/2+content.totalPaddingLeft
                val y=(layout.getLineTop(line)+layout.getLineBottom(line))/2f+content.totalPaddingTop
                content.requestRectangleOnScreen(android.graphics.Rect(x.toInt(),y.toInt(),x.toInt()+1,y.toInt()+1),true)
                val location=IntArray(2);content.getLocationOnScreen(location);point=floatArrayOf(location[0]+x,location[1]+y);true
            } }
            val original=api.get("/api/capture-browser/"+CentralScreens.encode(evidenceId)).getString("ocrText");assertTrue("Generated actual original must be readable",original.isNotBlank())
            screenshot("discovery-before-inline")
            val now=SystemClock.uptimeMillis()
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,point!![0],point!![1],0))
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,point!![0],point!![1],0))
            until("Discovery inline must open the complete exact original") { main { currentOrNull() is CaptureRecordsActivity && shown().filterIsInstance<TextView>().any { it.text.toString() == original } } };screenshot("discovery-inline-original")
            main { shown().single { it.contentDescription == "返回上一页" }.performClick() }
            until("Return to the same persisted report") { main { (currentOrNull() as? CentralActivity)?.isWorking == false && shown().filterIsInstance<TextView>().any { view -> view.tag == "insight-content" && view.text.toString()==renderedBody && view.text is android.text.Spanned && (view.text as android.text.Spanned).getSpans(0,view.text.length,android.text.style.ClickableSpan::class.java).isNotEmpty() } } };screenshot("discovery-inline-return")
            assertEquals(report.toString(),api.get("/api/insights/"+CentralScreens.encode(reportId)).toString())
            output.resolve("discovery-result.json").writeText(JSONObject().put("generatedOnly",true).put("liveModelInvokedByThisMethod",false).put("persistedDiscoveryRunId",reportId).put("evidenceId",evidenceId).put("citationNumber",number).put("exactCitationVerified",true).toString(2))
        }
    }

}
