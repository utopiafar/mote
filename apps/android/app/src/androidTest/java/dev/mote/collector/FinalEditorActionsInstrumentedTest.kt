package dev.mote.collector

import dev.mote.collector.plugins.NativeRecordReceipt
import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Selected final gaps only. Generated AVD audio input has host microphone explicitly OFF in the runner. */
class FinalEditorActionsInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private fun <T> main(block:()->T):T{val result=AtomicReference<Result<T>>();instrumentation.runOnMainSync{result.set(runCatching(block))};return result.get().getOrThrow()}
    private fun views(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{views(v.getChildAt(it))}else emptyList()
    private fun shown()=WindowInspector.getGlobalWindowViews().filter{it.isShown&&it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+30_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(50)};fail(label)}
    private fun has(text:String)=main{shown().filterIsInstance<TextView>().any{it.text.toString().contains(text)}}
    private fun hasTag(tag:String)=main{shown().any{it.tag==tag}}
    private fun click(label:String){until("Action $label"){main{shown().filterIsInstance<TextView>().any{it.isEnabled&&it.isClickable&&(it.text.toString()==label||it.contentDescription==label)}}};main{shown().filterIsInstance<TextView>().first{it.isEnabled&&it.isClickable&&(it.text.toString()==label||it.contentDescription==label)}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}.performClick()}}
    private fun tag(label:String)=main{shown().single{it.tag==label}.performClick()}
    private fun picture(name:String){instrumentation.waitForIdleSync();until("Focused native window before $name"){main{WindowInspector.getGlobalWindowViews().any{it.isShown&&it.hasWindowFocus()&&it.width>0&&it.height>0}}};val frame=CountDownLatch(1);main{WindowInspector.getGlobalWindowViews().last{it.isShown&&it.hasWindowFocus()}.postOnAnimation{frame.countDown()}};check(frame.await(5,TimeUnit.SECONDS));until("Focused native window after frame for $name"){main{WindowInspector.getGlobalWindowViews().any{it.isShown&&it.hasWindowFocus()&&it.width>0&&it.height>0}}};main{val root=WindowInspector.getGlobalWindowViews().last{it.isShown&&it.hasWindowFocus()};val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(image));File(context.filesDir,"final-editor-actions").apply{mkdirs()}.resolve("$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{image.recycle()}}}
    private data class Saved(val bytes:ByteArray,val mtime:Long)
    private fun snapshot(dir:File)=dir.listFiles().orEmpty().also{require(it.all(File::isFile))}.associate{it.name to Saved(it.readBytes(),it.lastModified())}
    private fun restore(dir:File,files:Map<String,Saved>){dir.mkdirs();dir.listFiles().orEmpty().forEach{check(it.delete())};files.forEach{(name,value)->dir.resolve(name).apply{writeBytes(value.bytes);setLastModified(value.mtime)}}}
    private fun fixture(block:()->Unit){
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeFinalEditorActions")=="true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);val config=settings.read();require(!settings.enabled&&!ProjectionService.running&&!CaptureAccessibilityService.connected&&config.syncMode=="manual"&&config.syncPaused)
        require(settings.deviceId=="95732268-d52d-474e-91f1-ac266cabe93e")
        val prefs=context.getSharedPreferences("mote",0);val values=prefs.all.toMap();val language=MoteI18n.preference();val appearance=MoteAppearance.preference();val location=QueueStorage(context).current();val queue=File(location.path);val queueFiles=snapshot(queue);val pointer=File(context.noBackupFilesDir,"queue-location.json").readBytes();val drafts=File(context.noBackupFilesDir,"record-draft");val draftFiles=snapshot(drafts);val pending=File(context.filesDir,"record-pending");val pendingFiles=snapshot(pending)
        val privateFiles=listOf(File(context.filesDir,"final-central-journey.json"),File(context.filesDir,"final-calendar-journey.json"),File(context.noBackupFilesDir,"final-calendar-journey-state.json"));val privateBytes=privateFiles.associateWith{it.readBytes()};val receipt=NativeRecordReceipt.recordId;val firstReceipt=NativeRecordReceipt.fromFirstUse
        // Runtime grants are restored by the external sole-ADB runner after this instrumentation exits.
        try{MoteI18n.select(context,"zh-CN");main{MoteAppearance.select(context,AppearancePreference.DARK)};block()}
        finally{
            main{ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).toList().forEach{it.finish()}};instrumentation.waitForIdleSync();val drained=CountDownLatch(1);QuickNotes.io.execute{drained.countDown()};check(drained.await(20,TimeUnit.SECONDS));CentralDraftWrites.barrier{}
            until("No pending configuration change"){!ConnectionGuard.changing()};settings.save(config,confirmCentralEndpoint=true)
            DurableQueue.exclusive{restore(queue,queueFiles);restore(drafts,draftFiles);restore(pending,pendingFiles)}
            val edit=prefs.edit().clear();values.forEach{(k,v)->when(v){is String->edit.putString(k,v);is Boolean->edit.putBoolean(k,v);is Int->edit.putInt(k,v);is Long->edit.putLong(k,v);is Float->edit.putFloat(k,v);is Set<*>->edit.putStringSet(k,v.filterIsInstance<String>().toSet());else->error("Unexpected preference")}};check(edit.commit());CentralSession.get(context).select(config.server);MoteI18n.select(context,language);main{MoteAppearance.select(context,appearance)};NativeRecordReceipt.recordId=receipt;NativeRecordReceipt.fromFirstUse=firstReceipt;LocalStateChanges.changed(records=true,immediate=true)
            assertEquals(values,prefs.all);assertEquals(config,settings.read());assertFalse(settings.enabled);assertArrayEquals(pointer,File(context.noBackupFilesDir,"queue-location.json").readBytes());assertEquals(queueFiles.keys,snapshot(queue).keys);queueFiles.forEach{(name,old)->assertArrayEquals(old.bytes,queue.resolve(name).readBytes())};privateBytes.forEach{(file,bytes)->assertArrayEquals(bytes,file.readBytes())}
        }
    }
    @Test fun firstUsePhotoAndMicrophoneRoutesKeepDarkFocusedDraftAndDisableSaveUntilAudioStops()=fixture{
        require(InstrumentationRegistry.getArguments().getString("hostMicrophoneDisabled")=="true")
        val settings=Settings(context);val store=context.recordDraftStore();require(!store.hasPrepared()&&store.pendingMedia().length()==0)
        // Temporarily expose actual first-use state; every original queue/draft byte is restored by the outer fixture.
        DurableQueue.exclusive{File(QueueStorage(context).current().path).listFiles().orEmpty().filter{it.extension in setOf("event","blob","thumb")}.forEach{check(it.delete())}}
        store.edit("",JSONArray(),JSONObject().put("kind","manual"));settings.save(settings.read().copy(server="",token="",syncMode="manual",syncPaused=true),confirmCentralEndpoint=true);context.getSharedPreferences("mote",0).edit().remove("lastCapture").commit();NativeRecordReceipt.recordId=null;LocalStateChanges.changed(records=true,immediate=true)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName,Manifest.permission.CAMERA);instrumentation.uiAutomation.grantRuntimePermission(context.packageName,Manifest.permission.RECORD_AUDIO)
        val cameraCalls=AtomicInteger();val camera=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult?=if(intent.action==MediaStore.ACTION_IMAGE_CAPTURE){assertNotNull(intent.getParcelableExtra<android.net.Uri>(MediaStore.EXTRA_OUTPUT));cameraCalls.incrementAndGet();Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null)}else null}
        instrumentation.addMonitor(camera)
        val requests=AtomicInteger();val hook=HttpJson.onRequest;HttpJson.onRequest={requests.incrementAndGet()}
        try{ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{scenario->
            until("Actual first-use home"){hasTag("home-first-use-guide")};assertTrue(main{(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single() as MainActivity).isFirstUseRecordEntry()});picture("first-use-dark-entry")
            tag("home-record-action");until("First-use editor ready"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="正在想什么"&&it.isEnabled}}};main{assertFalse(shown().filterIsInstance<TextView>().single{it.text.toString()=="保存"}.isEnabled)};picture("editor-dark-empty-save-disabled")
            click("拍照");until("Actual camera ACTION_IMAGE_CAPTURE returned cancelled"){cameraCalls.get()==1&&context.recordDraftStore().pendingMedia().length()==0};assertEquals(0,store.draft().getJSONArray("attachments").length());click("返回上一页");until("Camera cancel returns first-use home"){hasTag("home-first-use-guide")};tag("home-record-action");until("Actual first-use mic route"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="正在想什么"&&it.isEnabled}}}
            main{shown().filterIsInstance<EditText>().single{it.contentDescription=="正在想什么"}.apply{requestFocus();setText("Generated AVD silent audio draft");setSelection(text.length)}};picture("editor-dark-focused-text")
            click("录音");until("Actual MediaRecorder running with disabled competing tools"){main{shown().any{it.contentDescription=="停止录音"}&&shown().single{it.tag=="record-leave-notice"}.isShown}};main{assertFalse(shown().filterIsInstance<TextView>().single{it.text.toString()=="保存"}.isEnabled);for(label in listOf("拍照","相册","文件"))assertFalse(label,shown().single{it.contentDescription==label}.isEnabled)};picture("editor-dark-recording-save-and-tools-disabled");assertEquals(0,context.queue().depth());Thread.sleep(1300);click("停止录音")
            until("Actual AAC attachment staged"){store.draft().getJSONArray("attachments").length()==1&&main{shown().filterIsInstance<TextView>().any{it.text.toString()=="保存"&&it.isEnabled}}};val attachment=store.draft().getJSONArray("attachments").getJSONObject(0);val bytes=store.bytes(attachment.getString("id"));val file=File(context.cacheDir,"selected-silent-avd.m4a").apply{writeBytes(bytes)};val metadata=MediaMetadataRetriever();try{metadata.setDataSource(file.absolutePath);assertTrue(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()>0)}finally{metadata.release();file.delete()};picture("editor-dark-generated-aac-ready")
            click("保存");until("First-use real local receipt"){has("• 本机已保存")};val id=requireNotNull(NativeRecordReceipt.recordId);assertEquals("Generated AVD silent audio draft",context.queue().capture(id)!!.getString("ocrText"));val saved=store.record(id)!!.getJSONArray("attachments").getJSONObject(0);assertEquals(attachment.getString("id"),saved.getString("id"));assertArrayEquals(bytes,store.bytes(saved.getString("id")));assertTrue(NativeRecordReceipt.fromFirstUse);picture("first-use-dark-audio-local-receipt");assertEquals(0,requests.get())
        }}finally{HttpJson.onRequest=hook;instrumentation.removeMonitor(camera)}
    }
    @Test fun firstUseRealEmulatedCameraKeepsFullOriginalThroughLocalSave()=fixture{
        require(InstrumentationRegistry.getArguments().getString("emulatedCameraOnly")=="true")
        val settings=Settings(context);val store=context.recordDraftStore();require(!store.hasPrepared()&&store.pendingMedia().length()==0)
        DurableQueue.exclusive{File(QueueStorage(context).current().path).listFiles().orEmpty().filter{it.extension in setOf("event","blob","thumb")}.forEach{check(it.delete())}}
        store.edit("",JSONArray(),JSONObject().put("kind","manual"));settings.save(settings.read().copy(server="",token="",syncMode="manual",syncPaused=true),confirmCentralEndpoint=true);context.getSharedPreferences("mote",0).edit().remove("lastCapture").commit();NativeRecordReceipt.recordId=null;LocalStateChanges.changed(records=true,immediate=true)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName,Manifest.permission.CAMERA)
        val requests=AtomicInteger();val hook=HttpJson.onRequest;HttpJson.onRequest={requests.incrementAndGet()}
        try{ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{
            until("Actual first-use home before the system camera"){hasTag("home-first-use-guide")} ;tag("home-record-action")
            until("First-use editor is ready for a photo"){main{shown().any{it.contentDescription=="拍照"&&it.isEnabled}}};click("拍照")
            until("The private full-size camera destination is journaled"){store.pendingMedia().length()==1}
            instrumentation.sendStatus(0,android.os.Bundle().apply{putString("stream","FIRST_USE_CAMERA_READY_FOR_DRIVER\n")})
            val deadline=SystemClock.elapsedRealtime()+120_000
            while(SystemClock.elapsedRealtime()<deadline&&(store.pendingMedia().length()!=0||store.draft().getJSONArray("attachments").length()!=1))Thread.sleep(100)
            assertEquals("The real system camera must return its original",0,store.pendingMedia().length());assertEquals(1,store.draft().getJSONArray("attachments").length())
            val attachment=store.draft().getJSONArray("attachments").getJSONObject(0);assertEquals("image/jpeg",attachment.getString("mime"));val bytes=store.bytes(attachment.getString("id"))
            val bitmap=android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size);assertNotNull(bitmap);val width=bitmap!!.width;val height=bitmap.height;bitmap.recycle();assertTrue("System camera returns an original, not a thumbnail",minOf(width,height)>=480&&maxOf(width,height)>=640)
            assertEquals(0,context.queue().depth());until("Photo is ready to save explicitly"){main{shown().filterIsInstance<TextView>().any{it.text.toString()=="保存"&&it.isEnabled}}};picture("first-use-camera-original-ready");click("保存")
            until("First-use photo has a local receipt"){has("• 本机已保存")};val id=requireNotNull(NativeRecordReceipt.recordId);val saved=store.record(id)!!.getJSONArray("attachments").getJSONObject(0)
            assertEquals(attachment.getString("id"),saved.getString("id"));assertArrayEquals(bytes,store.bytes(saved.getString("id")));assertTrue(NativeRecordReceipt.fromFirstUse);assertEquals(0,requests.get());picture("first-use-camera-local-receipt")
            File(context.filesDir,"final-editor-actions").apply{mkdirs()}.resolve("first-use-camera-facts.json").writeText(JSONObject().put("actualSystemCamera",true).put("emulatedCamera",true).put("width",width).put("height",height).put("originalBytes",bytes.size).put("sha256",java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}).put("sameSavedBytes",true).put("localReceipt",true).put("networkRequests",requests.get()).toString(2))
        }}finally{HttpJson.onRequest=hook}
    }
    @Test fun firstUseHomeHelpCopiesAndReturnsThroughTheSavedLocalOriginal()=fixture{
        val settings=Settings(context);val store=context.recordDraftStore();require(!store.hasPrepared()&&store.pendingMedia().length()==0)
        DurableQueue.exclusive{File(QueueStorage(context).current().path).listFiles().orEmpty().filter{it.extension in setOf("event","blob","thumb")}.forEach{check(it.delete())}}
        store.edit("",JSONArray(),JSONObject().put("kind","manual"));settings.save(settings.read().copy(server="",token="",syncMode="manual",syncPaused=true),confirmCentralEndpoint=true);context.getSharedPreferences("mote",0).edit().remove("lastCapture").commit();NativeRecordReceipt.recordId=null;LocalStateChanges.changed(records=true,immediate=true)
        val clipboard=context.getSystemService(android.content.ClipboardManager::class.java);var previous:android.content.ClipData?=null;var clipboardRead=false
        val requests=AtomicInteger();val hook=HttpJson.onRequest;HttpJson.onRequest={requests.incrementAndGet()}
        try{ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{
            until("Actual first-use home opens installation help"){hasTag("home-first-use-guide")};click("还没有自己的 Mote？");until("Home opens the real installation help"){has("先准备你的中央档案")}
            previous=main{clipboard.primaryClip?.let{android.content.ClipData(it)}};clipboardRead=true
            click("复制给安装助手");assertEquals(StartUsingActivity.INSTALL_PROMPT,main{clipboard.primaryClip!!.getItemAt(0).text.toString()});click("查看安装提示词");until("The copied installation prompt is visible"){has(StartUsingActivity.INSTALL_PROMPT)};picture("first-home-help-prompt")
            click("现在先记下来");until("The local first-use editor opens"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="正在想什么"&&it.isEnabled}}}
            val body="Generated first-use installation-help thought";val description="Generated independent first-use explanation"
            main{shown().filterIsInstance<EditText>().single{it.contentDescription=="正在想什么"}.setText(body)};click("资料说明（选填）");main{(shown().single{it.tag=="record-description"}as EditText).setText(description)}
            click("保存");until("The local first-use receipt is visible"){has("• 本机已保存")};val id=requireNotNull(NativeRecordReceipt.recordId);val saved=requireNotNull(context.queue().capture(id))
            assertEquals(body,saved.getString("ocrText"));assertEquals(description,saved.getJSONObject("metadata").getString("ownerDescription"));assertTrue(NativeRecordReceipt.fromFirstUse);picture("first-home-help-local-receipt")
            click("查看原文");until("The same saved original is readable"){has(body)};picture("first-home-help-exact-original");click("返回上一页");until("The same local receipt returns"){has("• 本机已保存")};assertEquals(id,NativeRecordReceipt.recordId);assertEquals(0,requests.get())
        }}finally{HttpJson.onRequest=hook;main{if(clipboardRead){if(previous==null)clipboard.clearPrimaryClip()else clipboard.setPrimaryClip(previous!!)}}}
    }
    @Test fun connectionPageHelpReturnsToTheSameInvitationAndLocalDraft()=fixture{
        val settings=Settings(context);val store=context.recordDraftStore();require(!store.hasPrepared()&&store.pendingMedia().length()==0)
        DurableQueue.exclusive{File(QueueStorage(context).current().path).listFiles().orEmpty().filter{it.extension in setOf("event","blob","thumb")}.forEach{check(it.delete())}}
        val draft="Generated local draft before connection help";val explanation="Generated independent connection explanation"
        store.edit(draft,JSONArray(),JSONObject().put("kind","manual"),explanation);settings.save(settings.read().copy(server="",token="",syncMode="manual",syncPaused=true),confirmCentralEndpoint=true);context.getSharedPreferences("mote",0).edit().remove("lastCapture").commit();NativeRecordReceipt.recordId=null;LocalStateChanges.changed(records=true,immediate=true)
        val requests=AtomicInteger();val hook=HttpJson.onRequest;HttpJson.onRequest={requests.incrementAndGet()}
        try{ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{
            until("Actual first-use home offers connection"){hasTag("home-first-use-guide")};click("连接");until("The actual connection entry loads"){has("把记录接到一起")}
            val invitation="Generated incomplete invitation retained across help";main{shown().filterIsInstance<EditText>().single{it.isShown}.setText(invitation)}
            click("还没有自己的 Mote？");until("Connection opens its real installation help"){has("先准备你的中央档案")};picture("connection-help-open")
            click("返回上一页");until("The exact invitation returns"){main{shown().filterIsInstance<EditText>().any{it.isShown&&it.text.toString()==invitation}}};picture("connection-help-same-invitation")
            click("稍后连接");until("The original home returns"){hasTag("home-first-use-guide")} ;assertEquals(draft,store.draft().getString("text"));assertEquals(explanation,store.draft().getString("description"));assertEquals(0,context.queue().depth());assertEquals(0,requests.get())
        }}finally{HttpJson.onRequest=hook}
    }
    @Test fun isolatedEmptyQueueBulkComparisonAndRestoreKeepsOriginalProfile()=fixture{
        DurableQueue.exclusive{File(QueueStorage(context).current().path).listFiles().orEmpty().filter{it.extension in setOf("event","blob","thumb")}.forEach{check(it.delete())}}
        LocalStateChanges.changed(records=true,immediate=true)
        MaintenanceScreensInstrumentedTest().bulkScanCompareCancelMoveAndRestoreUseRealWorkerAndPreserveReference()
    }
    @Test fun darkTodoOpenCompletedAndManagedIntermediateReceiptsStayReadOnly()=fixture{
        val settings=Settings(context)
        HttpFixture().use{http->ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,"Generated final states",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)}
            try{ActivityScenario.launch(CalendarActionsActivity::class.java).use{
                until("Only actual waiting-device fixture card"){has(http.title("waiting_device"))&&has("等待已授权设备")};picture("managed-waiting-device-dark")
                for((state,label)in listOf("executing" to "等待保存回执","cancel_requested" to "已请求取消，写入结果仍待核实","cancelled" to "已取消等待执行")){
                    http.state=state;tag("calendar-tools");click("最新建议");until("Actual HTTP $state state consumed"){has(http.title(state))&&has(label)};main{assertEquals("Only one actual state label",1,shown().filterIsInstance<TextView>().count{it.text.toString()==label})};tag("calendar-tools");picture("managed-$state-dark")
                }
                tag("action-tabs:todos");until("Actual open Todo read"){has(http.todoTitle)&&has("未完成")};picture("todo-open-full-dark");click("标记完成");until("Actual same Todo PATCH completion"){http.patches.get()==1&&has(http.todoTitle)&&has("已完成")};picture("todo-completed-full-dark");assertEquals(1,http.writes.get());assertEquals(0,http.calendarWrites.get())
            }}finally{CentralDraftWrites.barrier{};File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin)).deleteRecursively()}
        }
    }
    private class HttpFixture:AutoCloseable{
        val token="generated-final-state-owner-token";val todo=UUID.randomUUID().toString();val action=UUID.randomUUID().toString();val todoTitle="Generated open-to-completed Todo";@Volatile var state="waiting_device";@Volatile var completed=false;val patches=AtomicInteger();val writes=AtomicInteger();val calendarWrites=AtomicInteger();private val server=ServerSocket(0,10,InetAddress.getByName("127.0.0.1"));val origin="http://127.0.0.1:${server.localPort}";private val threads=Executors.newCachedThreadPool();fun title(state:String)="Generated controlled managed $state"
        init{threads.submit{while(!server.isClosed)runCatching{server.accept()}.getOrNull()?.let{socket->threads.submit{socket.use{val input=it.getInputStream().bufferedReader();val first=input.readLine().orEmpty();val method=first.substringBefore(' ');val path=first.split(' ').getOrElse(1){""};var size=0;while(true){val h=input.readLine();if(h.isNullOrEmpty())break;if(h.startsWith("Content-Length:",true))size=h.substringAfter(':').trim().toInt()};val chars=CharArray(size);var read=0;while(read<size){val count=input.read(chars,read,size-read);if(count<0)break;read+=count};if(method!="GET")writes.incrementAndGet();var status="200 OK"
            val response=when{
                method=="PATCH"&&path=="/api/todos/$todo"->{val body=JSONObject(String(chars));require(body.getInt("version")==1&&body.getString("status")=="completed");patches.incrementAndGet();completed=true;JSONObject().put("id",todo).put("version",2).put("status","completed")}
                method!="GET"->{calendarWrites.incrementAndGet();status="409 Conflict";JSONObject().put("error","generated_read_only_fixture")}
                path.startsWith("/api/actions?")->{val actual=state;JSONObject().put("items",JSONArray().put(JSONObject().put("id",action).put("version",1).put("kind","calendar.create").put("status",if(actual=="executing"||actual=="cancel_requested")"executing"else if(actual=="cancelled")"dismissed"else"approved").put("managed",JSONObject().put("state",actual)).put("event",JSONObject().put("title",title(actual)).put("start","2031-02-03T15:00:00Z").put("end","2031-02-03T16:00:00Z").put("timeZone","UTC").put("location","Generated room")).put("target",JSONObject().put("deviceId",UUID.randomUUID().toString()).put("calendarId","generated-no-device-write")).put("evidence",JSONArray()))).put("nextCursor",JSONObject.NULL)}
                path.startsWith("/api/todos?")->JSONObject().put("items",JSONArray().put(JSONObject().put("id",todo).put("title",todoTitle).put("description","Generated controlled owner Todo").put("status",if(completed)"completed"else"open").put("version",if(completed)2 else 1).put("evidenceIds",JSONArray()))).put("nextCursor",JSONObject.NULL)
                path.startsWith("/api/connections/self")->JSONObject().put("credential",JSONObject().put("scope","owner"))
                else->JSONObject().put("items",JSONArray())
            };val bytes=response.toString().toByteArray();it.getOutputStream().apply{write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush()}
        }}}}}
        override fun close(){server.close();threads.shutdownNow()}
    }
}
