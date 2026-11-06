package dev.mote.collector

import android.app.Activity
import android.app.Instrumentation
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.TextView
import androidx.core.content.FileProvider
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

/** Only the external picker is controlled. Original bytes, resumable uploads and
 * lost receipts use the real generated Central; no external model is invoked. */
@RunWith(AndroidJUnit4::class)
class AskImagesInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private val origin="http://127.0.0.1:47886"
    private val api get()=CentralClient(origin,"generated-native-discovery-owner-token")
    private val directory get()=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(origin))
    private val images=mutableListOf<File>()
    private fun saved()=CentralDraftWrites.barrier { CentralStateFile(directory,"ask",context.secretBox()).read() }
    private fun control(action:String)=api.post("/api/__fixture/$action")
    private fun <T> main(block:()->T):T { val value=AtomicReference<Result<T>>();instrumentation.runOnMainSync { value.set(runCatching(block)) };return value.get().getOrThrow() }
    private fun views(root:View):List<View> = listOf(root)+if(root is ViewGroup)(0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun shown(a:CentralActivity)=views(a.window.decorView).filter { it.isShown }
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+30_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(60)};fail(label)}
    private fun ready(s:ActivityScenario<CentralActivity>,label:String,check:(CentralActivity)->Boolean){until(label){var value=false;s.onActivity{value=check(it)};value}}
    private fun click(s:ActivityScenario<CentralActivity>,label:String,working:Boolean=false,predicate:(View)->Boolean){ready(s,label){a -> (working || !a.isWorking) && shown(a).any { it.isEnabled && predicate(it) }};s.onActivity { a -> shown(a).single { it.isEnabled && predicate(it) }.apply { requestRectangleOnScreen(android.graphics.Rect(0,0,width,height),true);assertTrue(performClick()) } }}
    private fun question(s:ActivityScenario<CentralActivity>,text:String){s.onActivity { a -> shown(a).filterIsInstance<EditText>().single { it.contentDescription=="你的问题" }.apply { assertTrue(isEnabled);setText(text) } }}
    private fun model(s:ActivityScenario<CentralActivity>,text:String){s.onActivity { a -> views(a.window.decorView).filterIsInstance<EditText>().single { it.contentDescription?.toString()?.startsWith("模型 ID（") == true }.apply { assertTrue(isEnabled);setText(text) } }}
    private fun screenshot(s:ActivityScenario<CentralActivity>,name:String){instrumentation.waitForIdleSync();val frames=java.util.concurrent.CountDownLatch(1);s.onActivity { a -> a.window.decorView.postOnAnimation { a.window.decorView.postOnAnimation { frames.countDown() } } };assertTrue(frames.await(5,java.util.concurrent.TimeUnit.SECONDS));s.onActivity { a -> val root=a.window.decorView;val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(image));File(context.filesDir,"ask-images-final").apply{mkdirs()}.resolve("$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }}finally{image.recycle()} }}
    private fun open():ActivityScenario<CentralActivity> = ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask")).also { s -> ready(s,"Native composer loaded"){a -> !a.isWorking && shown(a).filterIsInstance<EditText>().any { it.contentDescription=="你的问题" && it.isEnabled }} }
    private fun image(index:Int):File {
        val file=File(context.cacheDir,"record-camera/ask-generated-${UUID.randomUUID()}-$index.png").apply { parentFile!!.mkdirs() }
        val bitmap=Bitmap.createBitmap(80,60,Bitmap.Config.ARGB_8888).apply { eraseColor(0xff000000.toInt() or (index*7919+0x445566)) }
        try{file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }}finally{bitmap.recycle()};images.add(file);return file
    }
    private fun pick(s:ActivityScenario<CentralActivity>,files:List<File>?,trigger:()->Unit={click(s,"Native image picker"){it.contentDescription=="添加图片"}}) {
        val hits=java.util.concurrent.atomic.AtomicInteger()
        val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult? {
            if(intent.action!=Intent.ACTION_OPEN_DOCUMENT)return null
            hits.incrementAndGet();assertEquals("image/*",intent.type);assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE,false))
            assertEquals(listOf("image/png","image/jpeg","image/webp"),intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)!!.toList())
            if(files==null)return Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null)
            val uris=files.map { FileProvider.getUriForFile(context,"${context.packageName}.record-files",it) }
            val result=Intent().addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if(uris.size==1)result.data=uris.single() else { val clip=ClipData.newRawUri("Generated selected images",uris.first());uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) };result.clipData=clip }
            return Instrumentation.ActivityResult(Activity.RESULT_OK,result)
        }}
        instrumentation.addMonitor(monitor);try{trigger();until("External picker result delivered"){hits.get()==1}}finally{instrumentation.removeMonitor(monitor)}
    }
    @Before fun generatedOnly(){
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeAskRecoveryFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a") && !Settings(context).enabled)
        control("reset");CentralDraftWrites.barrier { directory.deleteRecursively() }
        val settings=Settings(context);settings.save(settings.read().copy(server=origin,token="",debugHttp=true,syncMode="manual",authSignedOut=false,authExpiresAt=0,authProcess=""),confirmCentralEndpoint=true)
        CentralSession.get(context).select(origin);CentralSession.get(context).signIn(origin,"generated-native-discovery-owner-token")
        MoteI18n.select(context,"zh-CN");main { MoteAppearance.select(context,AppearancePreference.LIGHT) }
    }
    @After fun cleanup(){control("release-attachment-commit");control("show-ask");images.forEach(File::delete);images.clear()}
    @Test fun cancelValidationLostReceiptExplicitRetryAndRemovalPreserveThePrivateDraft(){
        open().use { s ->
            question(s,"Generated image question retained on cancellation");pick(s,null)
            assertEquals("Generated image question retained on cancellation",saved().getString("question"));assertEquals(0,NativeAskImages.count(saved()));screenshot(s,"picker-cancelled-draft-retained")
            val large=image(1);java.io.RandomAccessFile(large,"rw").use { it.setLength(8L*1024*1024+1) };pick(s,listOf(large))
            ready(s,"Oversized selection is explicit and blocks sending"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString()=="图片上传失败" }}
            assertEquals(0,control("state").getJSONArray("attachmentManifests").length());s.onActivity { a -> assertFalse(shown(a).single { it.contentDescription=="发送" }.isEnabled) };screenshot(s,"over-eight-mib-failed")
            click(s,"Remove invalid selection"){it.tag?.toString()?.startsWith("ask-image-remove:")==true}
            val original=image(2);control("drop-attachment-ack");pick(s,listOf(original))
            ready(s,"Lost real commit receipt remains unconfirmed"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString()=="上传结果尚未确认" }}
            val manifest=control("state").getJSONArray("attachmentManifests").getString(0);assertEquals(1,NativeAskImages.pending(saved()).length());screenshot(s,"commit-receipt-lost-explicit-retry")
            s.recreate();ready(s,"Recreation does not automatically retry images"){a -> !a.isWorking && shown(a).any { it.tag?.toString()?.startsWith("ask-image-retry:")==true }}
            assertEquals(1,control("state").getJSONArray("attachmentManifests").length())
            click(s,"Explicit same image retry"){it.tag?.toString()?.startsWith("ask-image-retry:")==true}
            ready(s,"Actual archived image appended"){a -> !a.isWorking && saved().optJSONArray("attachments")?.length()==1 && NativeAskImages.pending(saved()).length()==0}
            assertEquals(manifest,control("state").getJSONArray("attachmentManifests").getString(1))
            val id=saved().getJSONArray("attachments").getJSONObject(0).getString("id");val bytes=java.io.ByteArrayOutputStream();api.download("/api/files/$id/content",bytes,8*1024*1024);assertArrayEquals(original.readBytes(),bytes.toByteArray())
            screenshot(s,"retry-original-bytes-ready");click(s,"Remove ready image"){it.tag=="ask-image-remove:$id"}
            assertEquals(0,NativeAskImages.count(saved()));assertEquals("Generated image question retained on cancellation",saved().getString("question"));assertTrue(api.get("/api/files/$id").getBoolean("hasOriginal"));assertEquals(0,control("state").getInt("queryCalls"))
        }
    }
    @Test fun laterTextAndModelSurviveUploadAndRemovingAnUploadingSelectionFencesItsLateReceipt(){
        open().use { s ->
            question(s,"Generated question before image upload");click(s,"Open this-turn model"){it.contentDescription=="本次模型"};model(s,"generated-model-before")
            control("hold-attachment-commit");control("drop-attachment-ack");pick(s,listOf(image(3)));until("Actual archived commit response held"){control("state").getBoolean("attachmentCommitHeld")}
            question(s,"Generated later text while uploading");model(s,"generated-model-later");screenshot(s,"uploading-with-later-private-draft")
            click(s,"Remove uploading selection",working=true){it.tag?.toString()?.startsWith("ask-image-remove:")==true}
            control("release-attachment-commit");ready(s,"Removed upload cannot append on late receipt"){a -> !a.isWorking}
            assertEquals(0,NativeAskImages.count(saved()));assertEquals("Generated later text while uploading",saved().getString("question"));assertEquals("generated-model-later",saved().getString("modelOverride"));s.onActivity { a -> assertFalse(shown(a).filterIsInstance<TextView>().any { it.text.toString()=="请先重试或移除尚未上传完成的图片。" }) };screenshot(s,"late-receipt-removed-selection")
            control("drop-attachment-ack");pick(s,listOf(image(4)));ready(s,"Second selection held for explicit recovery"){a -> !a.isWorking && NativeAskImages.pending(saved()).length()==1}
            s.onActivity { it.navigate("conversations") }
            ready(s,"Conversation list composer"){a -> !a.isWorking && shown(a).filterIsInstance<EditText>().any { it.contentDescription=="问一问" && it.isEnabled }}
            s.onActivity { a -> shown(a).filterIsInstance<EditText>().single { it.contentDescription=="问一问" }.setText("Generated new conversation question") }
            click(s,"Send from the conversation list"){it.contentDescription=="发送"}
            until("Explicit discard dialog"){main { WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().any { it.isShown && it.text.toString()=="舍弃并切换" } }}
            main { WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString()=="舍弃并切换" }.performClick() }
            ready(s,"Explicit new conversation clears unfinished URI references"){a -> !a.isWorking && NativeAskImages.count(saved())==0 && saved().optString("question").isEmpty()};screenshot(s,"new-conversation-clears-image-references")
        }
    }
    @Test fun fourActualImagesStayInTheSameUnknownRequestAndCannotBeEdited(){
        open().use { s ->
            question(s,"Generated question with four original images")
            pick(s,(0..4).map(::image));ready(s,"Five selections are rejected before upload"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString()=="最多添加 4 张图片" }}
            assertEquals(0,control("state").getJSONArray("attachmentManifests").length())
            pick(s,(5..8).map(::image));ready(s,"Four original images are archived"){a -> !a.isWorking && saved().optJSONArray("attachments")?.length()==4}
            s.onActivity { a -> assertFalse(shown(a).single { it.contentDescription=="添加图片" }.isEnabled) };screenshot(s,"four-images-upper-limit")
            control("drop-ask-ack");control("hide-ask");click(s,"Send exact image question"){it.contentDescription=="发送"}
            ready(s,"Admission outcome remains unknown"){a -> !a.isWorking && saved().has("pending")}
            val pending=saved().getJSONObject("pending").toString();assertEquals(4,JSONObject(pending).getJSONObject("input").getJSONArray("attachmentIds").length())
            s.recreate();ready(s,"Unconfirmed image request restores"){a -> !a.isWorking && shown(a).filterIsInstance<TextView>().any { it.text.toString()=="重试同一请求" }}
            s.onActivity { a -> assertFalse(shown(a).single { it.contentDescription=="添加图片" }.isEnabled);assertTrue(shown(a).filter { it.tag?.toString()?.startsWith("ask-image-remove:")==true }.all { !it.isEnabled }) }
            assertEquals(pending,saved().getJSONObject("pending").toString());screenshot(s,"unknown-request-locks-exact-images")
            control("show-ask");click(s,"Check same request"){it is TextView && it.text.toString()=="检查结果"}
            until("Actual terminal image question"){saved().optString("runStatus")=="completed" && !saved().has("pending")};assertEquals(0,NativeAskImages.count(saved()))
        }
    }
    @Test fun authorizationChangeCleansPendingReferencesAndRejectsLateUploadConsumption(){
        open().use { s ->
            question(s,"Generated private text before sign-out");control("hold-attachment-commit");pick(s,listOf(image(9)));until("Commit held before owner transition"){control("state").getBoolean("attachmentCommitHeld")}
            CentralSession.get(context).signOut();s.recreate()
            ready(s,"Signed out page hides private image controls"){a -> shown(a).none { it.contentDescription=="你的问题" && it.isEnabled }}
            until("Pending URI references cleared under authorization fence"){NativeAskImages.pending(saved()).length()==0}
            control("release-attachment-commit");until("Old actual response released"){!control("state").getBoolean("attachmentCommitHeld")}
            assertEquals(0,NativeAskImages.count(saved()));assertEquals("Generated private text before sign-out",saved().getString("question"));assertEquals(0,control("state").getInt("queryCalls"));screenshot(s,"sign-out-fences-late-upload")
        }
    }
    @Test fun coarseComposerActionsKeepTheirActualHitAreaDraftAndRequestDisabling() {
        fun bottomPoint(s:ActivityScenario<CentralActivity>,description:String):FloatArray {
            ready(s,"Action layout "+description){a -> shown(a).any { it.contentDescription==description && it.isLaidOut }}
            var point=floatArrayOf();s.onActivity { a -> val view=shown(a).single { it.contentDescription==description };view.requestRectangleOnScreen(android.graphics.Rect(0,0,view.width,view.height),true)
                val bounds=android.graphics.Rect();assertTrue(view.getGlobalVisibleRect(bounds));assertEquals(view.height,bounds.height());point=floatArrayOf(bounds.exactCenterX(),bounds.bottom-2*context.resources.displayMetrics.density) }
            return point
        }
        fun tap(point:FloatArray) {
            val now=SystemClock.uptimeMillis();instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,point[0],point[1],0));instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,point[0],point[1],0));instrumentation.waitForIdleSync()
        }
        fun tapBottom(s:ActivityScenario<CentralActivity>,description:String) = tap(bottomPoint(s,description))
        open().use { s ->
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
                main { MoteAppearance.select(context,theme) }
                question(s,"")
                s.onActivity { a -> val send=views(a.window.decorView).single { it.contentDescription=="发送" };assertFalse(send.isShown);assertFalse(send.isEnabled) }
                screenshot(s,"coarse-compose-empty-"+theme.name.lowercase())
                question(s,"Generated coarse private draft")
                ready(s,"Coarse action dimensions after actual theme layout"){a -> listOf("添加图片","本次模型","发送").all { description ->
                    shown(a).singleOrNull { it.contentDescription==description }?.let { it.isLaidOut && it.width >= a.moteDp(48) && it.height >= a.moteDp(48) } == true
                }}
                s.onActivity { a -> assertTrue(shown(a).single { it.contentDescription=="发送" }.isEnabled) }
            }
            tapBottom(s,"本次模型")
            ready(s,"Bottom of coarse model control opens actual model fields"){a -> shown(a).filterIsInstance<EditText>().any { it.contentDescription?.toString()?.startsWith("模型 ID（")==true }}
            model(s,"generated-model-coarse");tapBottom(s,"本次模型");pick(s,null) { tapBottom(s,"添加图片") }
            assertEquals("Generated coarse private draft",saved().getString("question"));assertEquals("generated-model-coarse",saved().getString("modelOverride"));assertEquals(0,NativeAskImages.count(saved()))
            screenshot(s,"coarse-compose-draft-after-clicks-dark")
            control("hold-query");control("drop-ask-ack");control("hide-ask")
            try {
                val sendPoint=bottomPoint(s,"发送")
                var sendInset=floatArrayOf()
                s.onActivity { a -> val send=shown(a).single { it.contentDescription=="发送" };val bounds=android.graphics.Rect()
                    assertTrue((send.parent as View).getGlobalVisibleRect(bounds));sendInset=floatArrayOf(bounds.right-sendPoint[0],bounds.bottom-sendPoint[1]) }
                tap(sendPoint);ready(s,"Actual coarse send retains unknown original request"){a -> !a.isWorking && saved().has("pending")}
                val pending=saved().getJSONObject("pending").toString();assertEquals("Generated coarse private draft",JSONObject(pending).getJSONObject("input").getString("question"));assertEquals("generated-model-coarse",JSONObject(pending).getJSONObject("input").getString("modelOverride"))
                var lockedPoint=floatArrayOf()
                s.onActivity { a ->
                    for(description in listOf("添加图片","你的问题"))assertFalse(description,shown(a).single { it.contentDescription==description }.isEnabled)
                    val send=views(a.window.decorView).single { it.contentDescription=="发送" };assertFalse(send.isShown);assertFalse(send.isEnabled)
                    // The composer can move when recovery actions appear; probe the same area inside its current bounds.
                    val bounds=android.graphics.Rect();assertTrue((send.parent as View).getGlobalVisibleRect(bounds));lockedPoint=floatArrayOf(bounds.right-sendInset[0],bounds.bottom-sendInset[1])
                }
                val count=control("state").getJSONArray("seenAskRequests").length();tap(lockedPoint);assertEquals(count,control("state").getJSONArray("seenAskRequests").length());assertEquals(pending,saved().getJSONObject("pending").toString())
                screenshot(s,"coarse-compose-unknown-disabled-dark")
                control("release-query");control("show-ask");click(s,"Recheck same generated request"){it is TextView && it.text.toString()=="检查结果"}
                until("The actual terminal run confirms one request"){saved().optString("runStatus")=="completed" && !saved().has("pending")};assertEquals(1,control("state").getInt("queryCalls"))
            } finally { control("release-query");control("show-ask") }
        }
    }

}
