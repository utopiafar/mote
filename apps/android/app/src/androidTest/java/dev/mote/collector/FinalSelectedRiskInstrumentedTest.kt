package dev.mote.collector

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Spinner
import androidx.core.content.FileProvider
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.system.Os
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Explicit, generated-only gaps. Keeps final collector, originals, private configs and calendar untouched. */
@RunWith(AndroidJUnit4::class)
class FinalSelectedRiskInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private fun <T> main(block:()->T):T { val r=AtomicReference<Result<T>>();instrumentation.runOnMainSync{r.set(runCatching(block))};return r.get().getOrThrow() }
    private fun views(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{views(v.getChildAt(it))}else emptyList()
    private fun shown()=WindowInspector.getGlobalWindowViews().filter{it.isShown&&it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+30_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(50)};fail(label)}
    private fun has(text:String)=main{shown().filterIsInstance<TextView>().any{it.text.toString().contains(text)}}
    private fun click(label:String){until("Action $label"){main{shown().filterIsInstance<TextView>().any{it.isClickable&&it.isEnabled&&(it.text.toString()==label||it.contentDescription==label)}}};main{shown().filterIsInstance<TextView>().first{it.isClickable&&it.isEnabled&&(it.text.toString()==label||it.contentDescription==label)}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}.performClick()}}
    private fun clickDisclosure(label:String){val key="disclosure:"+MoteI18n.text(label);until("Disclosure $label"){main{shown().any{it.isClickable&&it.isEnabled&&it.tag==key}}};main{shown().first{it.isClickable&&it.isEnabled&&it.tag==key}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}.performClick()}}
    private fun clickHomeMenu(){until("Home menu"){main{shown().any{it.tag=="home-m-action"&&it.isClickable}}};main{shown().single{it.tag=="home-m-action"&&it.isClickable}.performClick()}}
    private fun chooseNativeListItem(label:String){
        fun row(text:View):View?{var node=text;while(node.parent is View&&node.parent !is android.widget.AdapterView<*>)node=node.parent as View;return node.takeIf{it.parent is android.widget.AdapterView<*>}}
        until("Native dialog row $label"){main{shown().filterIsInstance<TextView>().any{it.text.toString()==label&&row(it)!=null}}}
        main{val text=shown().filterIsInstance<TextView>().single{it.text.toString()==label&&row(it)!=null};val item=requireNotNull(row(text));val list=item.parent as android.widget.AdapterView<*>;val position=list.getPositionForView(item);assertTrue(position>=0);assertTrue(list.performItemClick(item,position,list.adapter.getItemId(position)))}
    }
    private fun picture(name:String){instrumentation.waitForIdleSync();until("Focused native window before $name"){main{WindowInspector.getGlobalWindowViews().any{it.isShown&&it.hasWindowFocus()&&it.width>0&&it.height>0}}};val frames=java.util.concurrent.CountDownLatch(1);main{WindowInspector.getGlobalWindowViews().last{it.isShown&&it.hasWindowFocus()}.postOnAnimation{frames.countDown()}};assertTrue(frames.await(5,java.util.concurrent.TimeUnit.SECONDS));main{val root=WindowInspector.getGlobalWindowViews().last{it.isShown&&it.hasWindowFocus()};val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(image));File(context.filesDir,"final-selected-risk").apply{mkdirs()}.resolve("$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{image.recycle()}}}
    private fun png():ByteArray {val b=Bitmap.createBitmap(80,60,Bitmap.Config.ARGB_8888).apply{eraseColor(Color.LTGRAY)};return try{ByteArrayOutputStream().also{b.compress(Bitmap.CompressFormat.PNG,100,it)}.toByteArray()}finally{b.recycle()}}
    private fun connectGenerated(settings:Settings,http:HttpFixture,name:String) {
        until("Generated connection waits for background reads") {
            try { ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,name,true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)};true }
            catch(error:ConnectionFailure) { if(error.category=="busy")false else throw error }
        }
    }
    private fun fixture(block:()->Unit){
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeFinalSelectedRisk")=="true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);val before=settings.read();val device=settings.deviceId;require(!settings.enabled&&!CaptureAccessibilityService.connected&&!ProjectionService.running&&before.syncMode=="manual"&&before.syncPaused)
        val preferenceStore=context.getSharedPreferences("mote",0);val originalPreferenceValues=preferenceStore.all.toMap();val language=MoteI18n.preference();val appearance=MoteAppearance.preference();val ids=context.queue().dedupeIds().toSet();val originals=ids.associateWith{context.queue().capture(it)!!.toString()};val queueDirectory=File(QueueStorage(context).current().path);val queueBytes=queueDirectory.listFiles().orEmpty().filter{it.extension in setOf("event","blob")}.associate{it.name to it.readBytes()}
        val privateFiles=listOf(File(context.filesDir,"final-central-journey.json"),File(context.filesDir,"final-calendar-journey.json"),File(context.noBackupFilesDir,"final-calendar-journey-state.json"));val privateBytes=privateFiles.associateWith{if(it.exists())it.readBytes()else null}
        try{MoteI18n.select(context,"zh-CN");main{MoteAppearance.select(context,AppearancePreference.LIGHT)};until("Idle existing configuration"){!ConnectionGuard.changing()&&!QueueStorage.recovering};block()}
        finally{CentralDraftWrites.barrier{};until("Test operation released configuration"){!ConnectionGuard.changing()};settings.save(before,confirmCentralEndpoint=true);restorePreferences(preferenceStore,originalPreferenceValues);CentralSession.get(context).select(before.server);MoteI18n.select(context,language);main{MoteAppearance.select(context,appearance)};assertEquals(before,settings.read());assertEquals(device,settings.deviceId);assertFalse(settings.enabled);assertEquals(ids,context.queue().dedupeIds().toSet());originals.forEach{(id,value)->assertEquals("Existing original unchanged",value,context.queue().capture(id)!!.toString())};privateBytes.forEach{(file,value)->if(value==null)assertFalse(file.exists())else assertArrayEquals(value,file.readBytes())};val afterQueue=queueDirectory.listFiles().orEmpty().filter{it.extension in setOf("event","blob")}.associate{it.name to it.readBytes()};assertEquals(queueBytes.keys,afterQueue.keys);queueBytes.forEach{(name,bytes)->assertArrayEquals(bytes,afterQueue[name])}}
    }
    @Test fun expiredInvitationAndActualTransportFailureRetainInputAndReviewName()=fixture{
        val before=Settings(context).read();val pending=File(context.noBackupFilesDir,"connection-pending.enc");require(!pending.exists())
        HttpFixture().use{http->ActivityScenario.launch(ConnectionActivity::class.java).use{scenario->
            until("Invitation entry"){has("把记录接到一起")}
            fun invitation(expiry:Instant)=JSONObject().put("format","mote.connection").put("version",1).put("serverUrl",http.origin).put("code","B".repeat(43)).put("expiresAt",expiry.toString()).toString()
            val expired=invitation(Instant.ofEpochMilli(System.currentTimeMillis()-60_000));main{shown().filterIsInstance<EditText>().single().setText(expired)};click("核对连接")
            until("Expired invitation is readable"){has(ConnectionActivity.message("expired"))};assertEquals(0,http.redeems.get());picture("connection-expired-retains-input")
            scenario.recreate();until("Expired input retained on recreation"){main{shown().filterIsInstance<EditText>().singleOrNull()?.text.toString()==expired}};assertEquals(before,Settings(context).read())
            val valid=invitation(Instant.ofEpochMilli(System.currentTimeMillis()+600_000));main{shown().filterIsInstance<EditText>().single().setText(valid)};click("核对连接");until("Actual review"){has("这是你的 Mote 吗？")}
            val name="Generated retained connection review";main{shown().filterIsInstance<EditText>().single().setText(name)};click("确认连接")
            until("Actual HTTP EOF returns readable transport failure"){has(ConnectionActivity.message("network"))};assertEquals(1,http.redeems.get());assertEquals(before,Settings(context).read());assertFalse(pending.exists());picture("connection-transport-failure-retains-name")
            scenario.recreate();until("Review name survives actual failed attempt and recreation"){main{shown().filterIsInstance<EditText>().singleOrNull()?.text.toString()==name}};click("返回上一页")
            until("Back returns the same invitation"){main{shown().filterIsInstance<EditText>().singleOrNull()?.text.toString()==valid}};picture("connection-failure-back-retains-invitation");click("核对连接");until("Review name retained after Back"){main{shown().filterIsInstance<EditText>().singleOrNull()?.text.toString()==name}};assertEquals(1,http.redeems.get())
        }}
    }
    @Test fun conversationDeleteCancelAndHttpFailureKeepLaterDraftAndAttachment()=fixture{
        HttpFixture().use{http->
            val settings=Settings(context);ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,"Generated isolated deletion failure",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)}
            val dir=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(dir,"ask",context.secretBox());val attachment=JSONObject().put("id",UUID.randomUUID().toString()).put("name","generated-retained-image.png").put("mimeType","image/png");val draft="Generated later draft retained across delete failure"
            store.write(JSONObject().put("conversationId",http.conversation).put("question",draft).put("attachments",JSONArray().put(attachment)))
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{scenario->
                until("Own controlled conversation selected"){var yes=false;scenario.onActivity{yes=!it.isWorking&&it.selectedAskConversationId==http.conversation};yes};assertTrue(has("generated-retained-image.png"))
                fun checkDraft(){CentralDraftWrites.barrier{val s=store.read();assertEquals(http.conversation,s.getString("conversationId"));assertEquals(draft,s.getString("question"));assertEquals(JSONArray().put(attachment).toString(),s.getJSONArray("attachments").toString())}}
                click("对话更多");chooseNativeListItem("删除这段对话");until("Destructive confirmation"){has("删除整段对话？")};picture("conversation-delete-confirm");click("取消");checkDraft();assertEquals(0,http.deletes.get());picture("conversation-delete-cancel-retains-draft")
                click("对话更多");chooseNativeListItem("删除这段对话");click("删除对话");until("Controlled real HTTP503 delete completed"){var idle=false;scenario.onActivity{idle=!it.isWorking};http.deletes.get()==1&&idle&&has("未能确认删除完成。请刷新查看当前状态。")};checkDraft();assertFalse(has("generated_delete_unavailable"));picture("conversation-delete-http503-keeps-context");click("对话更多");chooseNativeListItem("查看详情");until("Full delete diagnostic remains explicitly readable"){has("generated_delete_unavailable")&&has("503")};picture("conversation-delete-http503-explicit-details");click("关闭")
                scenario.recreate();until("Failure recreation retains same conversation and attachment"){var yes=false;scenario.onActivity{yes=!it.isWorking&&it.selectedAskConversationId==http.conversation};yes&&has("generated-retained-image.png")};checkDraft();click("对话更多");chooseNativeListItem("查看详情");until("Same conversation diagnostics survive recreation"){has("generated_delete_unavailable")};click("关闭");assertEquals(0,http.queryPosts.get());assertEquals(1,http.deletes.get())
                click("对话更多");chooseNativeListItem("删除这段对话");until("Old owner confirmation exists"){has("删除整段对话？")}
                main{val stale=shown().filterIsInstance<TextView>().single{it.text.toString()=="删除对话"};Settings(context).signIn(http.origin,"generated-new-owner-revocation-token",86400000);stale.performClick()}
                instrumentation.waitForIdleSync();assertEquals("Old owner confirmation cannot issue a second DELETE",1,http.deletes.get());assertEquals(0,http.queryPosts.get())
            }}finally{CentralDraftWrites.barrier{};dir.deleteRecursively()}
        }
    }
    @Test fun disablingComparisonDiagnosticsThroughSaveErasesOnlyGeneratedSamples()=fixture{
        val settings=Settings(context);val before=settings.read();require(!before.imageDedupeDiagnosticsEnabled);val folder=File(context.noBackupFilesDir,"image-dedupe-diagnostics");require(folder.listFiles().orEmpty().isEmpty());val store=context.imageDedupeDiagnostics()
        settings.save(before.copy(imageDedupeDiagnosticsEnabled=true));val pixels=png();val features=BulkDedupeRules.features(pixels,ScreenshotDedupeHelper.Mode.EXACT);val metadata=ImageDedupeDiagnosticsDetails.metadata(ScreenshotDedupeHelper.Mode.EXACT,ScreenshotDedupeHelper.compareFeatures(features,features,ScreenshotDedupeHelper.Mode.EXACT),UUID.randomUUID().toString(),Instant.now().minusSeconds(2).toString(),UUID.randomUUID().toString(),Instant.now().toString(),"generated.final.cleanup",80,60,80,60)
        val id=requireNotNull(store.record(metadata,pixels,pixels));val file=File(folder,"$id.enc");assertTrue(file.isFile)
        try{ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","PROCESSING")).awaitMainUi().use{
            until("Existing diagnostic switch is on"){main{shown().filterIsInstance<CheckBox>().any{it.text.toString()=="临时保留图片去重对比记录"&&it.isChecked}}};picture("diagnostic-existing-sample-before-off")
            main{shown().filterIsInstance<CheckBox>().single{it.text.toString()=="临时保留图片去重对比记录"}.isChecked=false};assertTrue("Draft switch alone cannot erase",file.isFile);assertTrue(settings.read().imageDedupeDiagnosticsEnabled);click("保存设置")
            // Inspect files directly: calling store.list() while disabled would itself clear and mask a missing save effect.
            until("Actual saved off transition erased the existing encrypted sample"){!settings.read().imageDedupeDiagnosticsEnabled&&!file.exists()&&folder.listFiles().orEmpty().isEmpty()&&!ConnectionGuard.changing()};picture("diagnostic-off-save-cleared-samples")
            assertEquals(before,settings.read());assertEquals(0,store.list().size)
        }}finally{store.clear();ImageDedupeDiagnosticsMaintenance.configure(context,false)}
    }
    @Test fun generatedBulkDeleteSucceedsAndRealUnreadableRecordIsReportedRetained()=fixture{
        val queue=context.queue();val store=BulkDedupeStore(context);val report=store.read("report");val plan=store.read("plan");val manager=WorkManager.getInstance(context);require(manager.getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().all{it.state.isFinished});val ids=List(3){UUID.randomUUID().toString()};val folder=File(QueueStorage(context).current().path);var blocked:File?=null;var blockedMode=384
        Settings(context).save(Settings(context).read().copy(imageDedupeMode="exact"))
        fun enqueue(id:String,second:Boolean){queue.enqueue(JSONObject().put("id",id).put("source","screen").put("capturedAt",if(second)"2026-10-30T00:00:01Z"else"2026-10-30T00:00:00Z").put("appId","generated.final.bulk").put("appName","Generated final bulk").put("privacy",JSONObject().put("excluded",false)).put("ocr",JSONObject().put("status","disabled")),png(),64L*1024*1024)}
        fun finish(message:String){until(message){manager.getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().all{it.state.isFinished}&&has(message)}}
        try{enqueue(ids[0],false);enqueue(ids[1],true)
            ActivityScenario.launch(BulkDedupeActivity::class.java).use{
                until("Scan action"){has("扫描本机图片")};click("扫描本机图片");until("Actual generated candidate scan"){store.read("report").optBoolean("complete")&&has("候选 1 张")};val pair=store.read("report").getJSONArray("pairs");assertEquals(1,pair.length());assertEquals(ids[1],pair.getJSONObject(0).getJSONObject("candidate").getString("id"));assertEquals(ids[0],pair.getJSONObject(0).getJSONObject("reference").getString("id"))
                main{shown().filterIsInstance<CheckBox>().single().isChecked=true};click("删除候选副本");click("确认");finish("处理完成：成功 1，失效或失败 0");assertNull(queue.capture(ids[1]));assertNotNull(queue.capture(ids[0]));assertArrayEquals(png(),queue.image(ids[0]));picture("bulk-permanent-delete-success-reference-retained")
                enqueue(ids[2],true);click("扫描本机图片");until("Rebuilt real candidate"){has("候选 1 张")&&store.read("report").getJSONArray("pairs").length()==1&&manager.getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().all{it.state.isFinished}}
                main{shown().filterIsInstance<CheckBox>().single().isChecked=true};click("删除候选副本");until("Confirmation before actual IO failure"){has("确认永久删除本机记录及图片？")}
                blocked=File(folder,ids[2]+".event");blockedMode=Os.stat(blocked!!.path).st_mode and 511;Os.chmod(blocked!!.path,0);click("确认");finish("处理完成：成功 0，失效或失败 1");assertTrue(blocked!!.isFile);picture("bulk-real-io-failure-keeps-record")
                Os.chmod(blocked!!.path,blockedMode);blocked=null;assertNotNull(queue.capture(ids[2]));assertNotNull(queue.capture(ids[0]));assertArrayEquals(png(),queue.image(ids[0]));assertArrayEquals(png(),queue.image(ids[2]))
            }
        }finally{blocked?.let{Os.chmod(it.path,blockedMode)};manager.cancelUniqueWork(BulkDedupeWorker.NAME).result.get();until("Generated worker stopped"){manager.getWorkInfosForUniqueWork(BulkDedupeWorker.NAME).get().all{it.state.isFinished}};ids.forEach{id->queue.dedupeRow(id)?.let{queue.resolveDedupe(id,it.getString("blob"),null,null,null)}};store.write("report",report);store.write("plan",plan)}
    }

    /** The browser is real; only the external URL at the Intent boundary is redirected to generated loopback HTML. */
    @Test fun actualInstallDocumentViewReturnsToTheUnsentEditorDraft()=fixture{
        val store=context.recordDraftStore();require(!store.hasPrepared());val previous=store.draft()
        val text="Generated installation-return draft ${UUID.randomUUID()}";val description="Generated separate explanation retained across the browser"
        val originalUrl="https://github.com/utopiafar/mote/blob/main/docs/agent-install.md"
        HttpFixture().use{http->
            val seen=AtomicReference<String>();val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult?{
                if(intent.action==Intent.ACTION_VIEW&&intent.dataString==originalUrl){seen.set(intent.dataString);intent.data=Uri.parse(http.origin+"/generated-install-help")};return null
            }}
            instrumentation.addMonitor(monitor)
            try{ActivityScenario.launch(RecordEditorActivity::class.java).use{scenario->
                until("Editor ready"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="正在想什么"&&it.isEnabled}}}
                main{shown().filterIsInstance<EditText>().single{it.contentDescription=="正在想什么"}.setText(text)};click("资料说明");main{(shown().single{it.tag=="record-description"}as EditText).setText(description)}
                until("Actual draft persisted"){store.draft().optString("text")==text&&store.draft().optString("description")==description}
                scenario.onActivity{it.startActivity(Intent(it,StartUsingActivity::class.java))};until("Install help"){has("查看安装文档")};picture("install-document-before-browser");click("查看安装文档")
                until("Real browser loaded only generated loopback page"){
                    val nodes=systemNodes();nodes.firstOrNull{it.packageName?.toString()=="com.android.chrome"&&it.text?.toString()in setOf("Stay signed out","No thanks")}?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    if(nodes.any{it.packageName?.toString()=="com.android.chrome"&&it.text?.toString()=="Get the most out of Chrome"})nodes.firstOrNull{it.packageName?.toString()=="com.android.chrome"&&it.text?.toString()=="Close"}?.let { close ->
                        var target=close;while(!target.isClickable)target=target.parent?:break;target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    }
                    seen.get()==originalUrl&&http.helpReads.get()>0&&nodes.any{it.packageName?.toString()=="com.android.chrome"&&it.text?.toString()?.contains("Generated Mote installation help boundary")==true}
                }
                assertEquals(originalUrl,seen.get());assertTrue(systemNodes().any{it.text?.toString()?.contains(http.origin.removePrefix("http://"))==true});systemPicture("install-document-actual-browser")
                assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));until("Returned to exact help screen"){has("查看安装文档")};click("返回上一页")
                until("Same editor and full unsent draft returned"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="正在想什么"&&it.text.toString()==text}}};assertEquals(text,store.draft().getString("text"));assertEquals(description,store.draft().getString("description"));picture("install-document-back-same-editor-draft")
            }}finally{instrumentation.removeMonitor(monitor);store.edit(previous.getString("text"),previous.getJSONArray("attachments"),previous.getJSONObject("origin"),previous.optString("description"),previous.optJSONObject("originPresentation"))}
        }
    }
    private fun systemNodes():List<AccessibilityNodeInfo>{fun children(node:AccessibilityNodeInfo?):List<AccessibilityNodeInfo> = if(node==null)emptyList()else listOf(node)+(0 until node.childCount).flatMap{children(node.getChild(it))}
        return children(instrumentation.uiAutomation.rootInActiveWindow)}
    private fun systemPicture(name:String){SystemClock.sleep(500);instrumentation.uiAutomation.waitForIdle(100,3000);val image=requireNotNull(instrumentation.uiAutomation.takeScreenshot());try{File(context.filesDir,"final-selected-risk").apply{mkdirs()}.resolve("$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{image.recycle()}}

    @Test fun physicallyMissingLocalOriginalCannotBeReadOrResurrectedByExplicitRecovery()=fixture{
        require(context.localSources().sources().none{it.enabled})
        val id=UUID.randomUUID().toString();lateinit var queue:DurableQueue;val dir=File(QueueStorage(context).current().path);val eventFile=File(dir,"$id.event");val held=File(context.cacheDir,"generated-missing-$id.event")
        val recovery=context.getSharedPreferences("sync-recovery",0);val oldRecovery=recovery.all.toMap();val manager=WorkManager.getInstance(context)
        require(manager.getWorkInfosForUniqueWork("mote-sync-recovery").get().all{it.state.isFinished})
        HttpFixture().use{http->
            val settings=Settings(context)
            until("Generated recovery connection waits for any existing background read to finish"){
                try { ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,"Generated isolated missing-local recovery",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=false,wifiOnly=false,syncChargingOnly=false,syncBatteryNotLow=false),confirmCentralEndpoint=true)}; true }
                catch (error: ConnectionFailure) { if(error.category=="busy") false else throw error }
            }
            queue=context.queue()
            try{
                val body=JSONObject().put("id",id).put("deviceId",settings.deviceId).put("source","note").put("capturedAt",Instant.now().toString()).put("durationMs",0).put("ocrText","Generated local original physically removed before recovery").put("privacy",JSONObject().put("excluded",false))
                queue.enqueue(body,null,64L*1024*1024);val version=CaptureUploadVersion.of(requireNotNull(queue.archiveRecord(id)).first);assertNotNull(queue.capture(id));check(eventFile.renameTo(held));assertTrue(held.isFile);assertNull(queue.capture(id));assertFalse(eventFile.exists())
                ActivityScenario.launch<CaptureRecordsActivity>(Intent(context,CaptureRecordsActivity::class.java).putExtra("recordId",id).putExtra("historyOriginalVersion",version)).use{
                    until("Exact history reader reports local original unavailable"){has("历史版本不可用：本机原件已更新或清理")};assertFalse(has("中央不可用 / 已删除"));picture("recovery-missing-local-exact-reader")
                }
                assertTrue("Isolated origin must have no retained local originals",queue.syncIds().isEmpty())
                ActivityScenario.launch(SyncRecoveryActivity::class.java).use{
                    until("Recovery entry"){has("补传本机保留的记录")};main{shown().single{it.tag=="recovery-replay"}.performClick()};until("Explicit warning distinguishes cleaned local data"){has("已从手机清理的数据无法补传")};picture("recovery-missing-local-explicit-scope");click("开始补传")
                    until("Production recovery finishes with zero existing originals"){recovery.getString("message","")!!.startsWith("已安排补传 0 条本机采集记录及 0 个保留来源版本")&&manager.getWorkInfosForUniqueWork("mote-sync-recovery").get().all{it.state.isFinished}}
                    until("Actual zero replay result renders"){has("已安排补传 0 条本机采集记录")};assertFalse(eventFile.exists());assertNull(queue.capture(id));assertEquals(0,http.capturePosts.get());picture("recovery-missing-local-zero-not-restored")
                }
            }finally{
                manager.cancelUniqueWork("mote-sync-recovery").result.get();manager.cancelUniqueWork("mote-upload").result.get();until("Selected recovery/upload stopped"){listOf("mote-sync-recovery","mote-upload").all{name->manager.getWorkInfosForUniqueWork(name).get().all{it.state.isFinished}}}
                if(held.exists()){check(held.renameTo(eventFile));queue.resolveDedupe(id,"",null,null,null)}
                val edit=recovery.edit().clear();oldRecovery.forEach{(key,value)->when(value){is String->edit.putString(key,value);is Int->edit.putInt(key,value);is Long->edit.putLong(key,value);is Boolean->edit.putBoolean(key,value);else->error("Unsupported recovery preference")}};edit.commit()
            }
        }
    }

    @Test fun existingLocalCalendarRangeBoundariesAndAllNewSaveAndCancelNeverChangeProvider()=fixture{
        val resolver=context.contentResolver;fun rows(uri:Uri,projection:Array<String>,selection:String):String=resolver.query(uri,projection,selection,null,"_id")!!.use{c->JSONArray().apply{while(c.moveToNext())put(JSONArray().apply{for(i in projection.indices)put(if(c.isNull(i))JSONObject.NULL else c.getString(i))})}.toString()}
        val calendarBefore=rows(CalendarContract.Calendars.CONTENT_URI,arrayOf("_id","account_name","account_type","calendar_displayName"),"_id=1");require(JSONArray(calendarBefore).length()==1)
        val eventColumns=arrayOf("_id","calendar_id","title","description","dtstart","dtend","allDay","eventLocation","eventTimezone","deleted");val eventsBefore=rows(CalendarContract.Events.CONTENT_URI,eventColumns,"calendar_id=1")
        val store=context.localSources();val before=store.sources();require(before.none{it.enabled||it.calendarId==1L});var created:String?=null
        fun fields(values:Pair<String,String>){main{val edits=shown().filterIsInstance<EditText>();val form=edits.single{it.tag=="calendar-description"}.parent as ViewGroup;val children=(0 until form.childCount).map{form.getChildAt(it)};fun field(label:String):EditText { return children[children.indexOfFirst{it is TextView&&it.text.toString()==label}+1]as EditText }
            field("过去多少天（0–365）").setText(values.first);field("未来多少天（1–365）").setText(values.second)}}
        fun initial(position:Int){main{shown().filterIsInstance<Spinner>().single{it.adapter.count==2&&it.adapter.getItem(0).toString()=="已有内容分批导入（默认）"}.setSelection(position)}}
        try{
            ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("addCalendar",true)).use{
                until("Existing sole generated calendar picker"){main{shown().filterIsInstance<TextView>().any{it.text.toString().contains("Generated")}}};val label=resolver.query(CalendarContract.Calendars.CONTENT_URI,arrayOf(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME),"_id=1",null,null)!!.use{c->check(c.moveToFirst());c.getString(0)};chooseNativeListItem(label)
                until("Existing calendar scope form"){main{shown().any{it.tag=="calendar-description"}}};main{shown().filterIsInstance<CheckBox>().single{it.text.toString()=="允许读取并按所选策略发送这个来源"}.isChecked=false};fields("0" to "1");initial(0);picture("calendar-existing-minimum-all-before-save");click("保存来源设置")
                until("Real minimum all save"){store.sources().any{it.calendarId==1L&&!it.enabled&&it.daysBefore==0&&it.daysAfter==1&&it.initialSync=="all"}};created=store.sources().single{it.calendarId==1L}.id
            }
            fun reopen(block:(ActivityScenario<SourcesActivity>)->Unit){ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("sourceId",created)).use{scenario->until("Actual saved calendar scope reopens"){main{shown().any{it.tag=="calendar-description"}}};block(scenario)}}
            val minimum=store.sources().single{it.id==created}
            reopen{
                for(invalid in listOf("366" to "1","0" to "0","0" to "366")){fields(invalid);initial(1);click("保存来源设置");instrumentation.waitForIdleSync();assertEquals("Each independently invalid boundary must not persist",minimum,store.sources().single{it.id==created});assertTrue(main{shown().any{it.tag=="calendar-description"}})}
                picture("calendar-invalid-range-not-saved");click("取消")
            }
            reopen{fields("365" to "365");initial(1);click("保存来源设置");until("Real maximum new-only saved"){store.sources().any{it.id==created&&!it.enabled&&it.daysBefore==365&&it.daysAfter==365&&it.initialSync=="new_only"}}}
            val maximum=store.sources().single{it.id==created};reopen{picture("calendar-existing-maximum-new-saved");fields("0" to "1");initial(0);click("取消");assertEquals(maximum,store.sources().single{it.id==created})}
            reopen{picture("calendar-cancel-keeps-maximum-new");click("取消")}
            assertEquals(calendarBefore,rows(CalendarContract.Calendars.CONTENT_URI,arrayOf("_id","account_name","account_type","calendar_displayName"),"_id=1"));assertEquals(eventsBefore,rows(CalendarContract.Events.CONTENT_URI,eventColumns,"calendar_id=1"))
        }finally{created?.let{store.remove(it)};assertEquals(before,store.sources());assertEquals(eventsBefore,rows(CalendarContract.Events.CONTENT_URI,eventColumns,"calendar_id=1"))}
    }

    @Test fun actualSupportExportExcludesPlantedBodyKnownTokenAndGeneratedImage()=fixture{
        val settings=Settings(context);val config=settings.read();val knownToken=config.connectionToken();require(knownToken.length>=32)
        val marker="generated-sensitive-body-${UUID.randomUUID()}";val imageMarker="generated-sensitive-image-${UUID.randomUUID()}";val image=Bitmap.createBitmap(600,80,Bitmap.Config.ARGB_8888).apply{eraseColor(Color.WHITE);android.graphics.Canvas(this).drawText(imageMarker,5f,40f,android.graphics.Paint().apply{color=Color.BLACK;textSize=20f})};val bytes=try{ByteArrayOutputStream().also{image.compress(Bitmap.CompressFormat.PNG,100,it)}.toByteArray()}finally{image.recycle()}
        val id=UUID.randomUUID().toString();val event=JSONObject().put("id",id).put("deviceId",settings.deviceId).put("source","note").put("capturedAt",Instant.now().toString()).put("durationMs",0).put("ocrText",marker+"\n"+knownToken).put("metadata",JSONObject().put("ownerDescription",imageMarker)).put("privacy",JSONObject().put("excluded",false))
        val directory=File(context.cacheDir,"record-camera/generated-support-$id").apply{mkdirs()};val output=File(directory,"safe-support.json")
        val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult?=if(intent.action==Intent.ACTION_CREATE_DOCUMENT)Instrumentation.ActivityResult(Activity.RESULT_OK,Intent().setData(FileProvider.getUriForFile(context,"${context.packageName}.record-files",output)))else null}
        try{
            context.queue().enqueue(event,bytes,64L*1024*1024);assertTrue(context.queue().capture(id)!!.getString("ocrText").contains(marker));assertArrayEquals(bytes,context.queue().image(id))
            SupportEvents.failure(context,EventStage.SUPPORT,java.io.IOException(marker+" "+knownToken+" "+imageMarker));SupportEvents.record(context,EventStage.SUPPORT,EventCode.OK,errorName=knownToken,sourceId=marker)
            instrumentation.addMonitor(monitor)
            ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","DIAGNOSTICS")).awaitMainUi().use{
                click("导出安全支持包 JSON");until("Actual SAF provider output completed"){has("诊断包已导出")&&output.length()>0};val body=output.readText();val json=JSONObject(body);assertTrue(json.has("configuration")&&json.has("logs")&&json.has("events")&&json.has("samples"));assertFalse("Captured body excluded",body.contains(marker));assertFalse("Current generated token excluded",body.contains(knownToken));assertFalse("Independent explanation excluded",body.contains(imageMarker));assertFalse("Original image excluded",body.contains(java.util.Base64.getEncoder().encodeToString(bytes)));assertFalse(body.contains(java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}));assertNotNull(context.queue().capture(id));assertArrayEquals(bytes,context.queue().image(id));picture("support-real-export-sensitive-originals-excluded")
                val safe=File(context.filesDir,"final-selected-risk").apply{mkdirs()};File(safe,"support-absence-facts.json").writeText(JSONObject().put("schema",1).put("actualSupportBytes",output.length()).put("bodyAbsent",true).put("knownCurrentTokenAbsent",true).put("imageAndDescriptionAbsent",true).put("originalRetainedUntilTestCleanup",true).toString())
            }
        }finally{instrumentation.removeMonitor(monitor);context.queue().dedupeRow(id)?.let{context.queue().resolveDedupe(id,it.getString("blob"),null,null,null)};directory.deleteRecursively()}
    }


    @Test fun enabledExistingCalendarSavesAndActuallyScansLocallyWhileAllSendingStaysPaused()=fixture{
        val resolver=context.contentResolver;val manager=WorkManager.getInstance(context);val store=context.localSources();val before=store.sources();require(before.isEmpty())
        fun calendarRows(uri:Uri,projection:Array<String>,selection:String)=resolver.query(uri,projection,selection,null,"_id")!!.use{cursor->JSONArray().apply{while(cursor.moveToNext())put(JSONArray().apply{for(i in projection.indices)put(if(cursor.isNull(i))JSONObject.NULL else cursor.getString(i))})}.toString()}
        val calendars=calendarRows(CalendarContract.Calendars.CONTENT_URI,arrayOf("_id","account_name","account_type","calendar_displayName"),"_id=1");require(JSONArray(calendars).length()==1)
        val columns=arrayOf("_id","calendar_id","title","description","dtstart","dtend","allDay","eventLocation","eventTimezone","deleted");val events=calendarRows(CalendarContract.Events.CONTENT_URI,columns,"calendar_id=1")
        resolver.query(CalendarContract.Events.CONTENT_URI,arrayOf(CalendarContract.Events.DTSTART),"_id=7 AND calendar_id=1",null,null)!!.use{cursor->require(cursor.moveToFirst()&&cursor.getLong(0)>System.currentTimeMillis()+2*86400000L)}
        val network=AtomicInteger();val previousHook=HttpJson.onRequest;HttpJson.onRequest={network.incrementAndGet();previousHook?.invoke()};var sourceId:String?=null
        try{
            ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("addCalendar",true)).use{
                val label=resolver.query(CalendarContract.Calendars.CONTENT_URI,arrayOf(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME),"_id=1",null,null)!!.use{cursor->check(cursor.moveToFirst());cursor.getString(0)};chooseNativeListItem(label);until("Actual calendar form"){main{shown().any{it.tag=="calendar-description"}}}
                main{shown().filterIsInstance<CheckBox>().single{it.text.toString()=="允许读取并按所选策略发送这个来源"}.isChecked=true;val edits=shown().filterIsInstance<EditText>();val form=edits.single{it.tag=="calendar-description"}.parent as ViewGroup;val children=(0 until form.childCount).map{form.getChildAt(it)};for((label,value)in listOf("过去多少天（0–365）" to "0","未来多少天（1–365）" to "1")){(children[children.indexOfFirst{it is TextView&&it.text.toString()==label}+1]as EditText).setText(value)}}
                picture("calendar-enabled-current-range-before-save");click("保存来源设置");until("Real enabled local source persisted"){store.sources().any{it.calendarId==1L&&it.enabled&&it.daysBefore==0&&it.daysAfter==1}};sourceId=store.sources().single().id
                until("Production SourceScanWorker read exact current calendar scope"){store.state(requireNotNull(sourceId)).let{it.optBoolean("scanComplete")&&it.optString("lastScan").isNotBlank()&&it.optString("status")=="scanned"}}
                val state=store.state(requireNotNull(sourceId));assertEquals(0,state.getJSONObject("current").length());assertEquals(0,state.getJSONArray("pending").length());assertFalse(state.optBoolean("registered"));assertFalse(state.has("lastAcknowledgedAt"));assertTrue(Settings(context).read().syncPaused);assertEquals("manual",Settings(context).read().syncMode)
                until("Native source list reports scanned waiting, never Central acknowledgement"){has("已扫描，等待发送")};assertFalse(has("资料说明已获中央确认"));assertFalse(has("已同步"));assertEquals("Paused send gates every network request",0,network.get());picture("calendar-enabled-local-scan-waits-without-central-ack")
                val facts=JSONObject().put("sourceId",sourceId).put("calendarId",1).put("enabled",true).put("daysBefore",0).put("daysAfter",1).put("actualScanComplete",true).put("currentItems",0).put("pendingVersions",0).put("registered",false).put("networkRequests",network.get()).put("actionsConnectInvoked",false)
                File(context.filesDir,"final-selected-risk/calendar-enabled-local-facts.json").writeText(facts.toString())
            }
        }finally{
            sourceId?.let{store.setEnabled(it,false)};SourceWork.schedule(context);listOf("mote-source-scan","mote-source-periodic","mote-source-upload").forEach{manager.cancelUniqueWork(it).result.get()};until("Only temporary source work stopped"){listOf("mote-source-scan","mote-source-periodic","mote-source-upload").all{name->manager.getWorkInfosForUniqueWork(name).get().all{it.state.isFinished}}};sourceId?.let{store.remove(it)};HttpJson.onRequest=previousHook;assertEquals(before,store.sources());assertEquals(calendars,calendarRows(CalendarContract.Calendars.CONTENT_URI,arrayOf("_id","account_name","account_type","calendar_displayName"),"_id=1"));assertEquals(events,calendarRows(CalendarContract.Events.CONTENT_URI,columns,"calendar_id=1"))
        }
    }

    @Test fun oneAndTwentyFourHourSupportExportsFilterActualRuntimeLogsAndRetainAllNumericSamples()=fixture{
        val now=System.currentTimeMillis();val ages=listOf(30*60_000L,2*3600_000L,2*86400_000L);val ids=ages.map{UUID.randomUUID().toString()};val files=(0..6).map{File(context.noBackupFilesDir,if(it==0)"mote.log"else"mote.log.$it")};val sampleFile=File(context.noBackupFilesDir,"diagnostics.json");val originals=(files+sampleFile).associateWith{if(it.exists())it.readBytes()else null}
        val root=File(context.cacheDir,"record-camera/generated-range-${UUID.randomUUID()}").apply{mkdirs()};var target:File?=null
        val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult?=if(intent.action==Intent.ACTION_CREATE_DOCUMENT)Instrumentation.ActivityResult(Activity.RESULT_OK,Intent().setData(FileProvider.getUriForFile(context,"${context.packageName}.record-files",requireNotNull(target))))else null}
        try{
            // Current-format generated past timestamps are fixture input; the actual UI and production exporter decide range membership.
            files.forEach{it.delete()};files.first().writeText(ages.indices.joinToString("\n",postfix="\n"){i->"${Instant.ofEpochMilli(now-ages[i])} INFO  [thread-0] SUPPORT - OK sourceId=${ids[i]} elapsedMs=0"})
            sampleFile.writeText(JSONArray(ages.indices.map{i->JSONObject().put("atMs",now-ages[i]).put("capturedCount",901+i).put("queueDepth",0)}).toString())
            instrumentation.addMonitor(monitor)
            ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","DIAGNOSTICS")).awaitMainUi().use{scenario->
                for((hours,count)in listOf(1 to 1,24 to 2)){
                    click("导出时间范围");chooseNativeListItem(if(hours==1)"最近 1 小时"else"最近 24 小时");until("Actual selected $hours-hour range visible after dialog closes"){main{shown().filterIsInstance<TextView>().any{it.tag=="diagnostic-export-range"&&it.text.toString().contains(if(hours==1)"最近 1 小时"else"最近 24 小时")}}};target=File(root,"support-$hours.json");click("导出安全支持包 JSON");until("Actual $hours-hour support file written"){requireNotNull(target).length()>0&&has("诊断包已导出")}
                    val result=JSONObject(requireNotNull(target).readText());val logs=result.getJSONObject("logs");val text=logs.getString("text");ids.forEachIndexed{i,id->assertEquals("Actual runtime timestamp membership",i<count,text.contains(id))};val after=Instant.parse(logs.getString("after")).toEpochMilli();val end=Instant.parse(logs.getString("before")).toEpochMilli();assertTrue(kotlin.math.abs(end-after-hours*3600_000L)<1000)
                    val samples=result.getJSONArray("samples");val seededTimes=ages.map{now-it}.toSet();val seeded=(0 until samples.length()).map{samples.getJSONObject(it)}.filter{it.getLong("atMs")in seededTimes};assertEquals("All three planted ages survive; Main may add current numeric samples",3,seeded.size);assertEquals(seededTimes,seeded.map{it.getLong("atMs")}.toSet());assertEquals(setOf(901,902,903),seeded.map{it.getInt("capturedCount")}.toSet());picture("support-actual-${hours}h-range-and-success")
                }
                scenario.recreate();until("Actual 24h selected range retained after rebuild"){has("导出时间范围 · 最近 24 小时")};picture("support-24h-range-restored")
            }
        }finally{instrumentation.removeMonitor(monitor);originals.forEach{(file,bytes)->if(bytes==null)file.delete()else file.writeBytes(bytes)};root.deleteRecursively()}
    }

    /** Uses a normal short-lived owner login, public citation route and persisted H04 results only. */
    @Test fun persistedExactDerivedMediaCitationsReadNaturallyAndReturnWithoutNewInference()=fixture{
        val settings=Settings(context);val before=settings.read();val preferences=context.getSharedPreferences("mote",0);val originalPreferences=preferences.all.toMap()
        val privateConfig=JSONObject(File(context.filesDir,"final-calendar-journey.json").readText());require(privateConfig.getBoolean("generatedOnly")&&privateConfig.getString("origin")==before.server&&privateConfig.getString("deviceId")==settings.deviceId)
        val origin=before.server;val vaultOwner=privateConfig.getString("ownerToken");val conversation="b0230e1a-fa9b-4e71-8581-102b16b4dae6";val turnId="f7f6a4a1-9dfa-4843-ba29-97243bb1b4ea"
        val ids=listOf("5469611e-ea55-5e4e-acd0-9924840b7427","97f5258a-dbb7-55a2-a757-6fed4b5601b6","7e6797e0-aa66-57f4-a163-fdcc3c76b2b5")
        val expected=listOf("MOTE GENERATED TEST","Tomorrow at nine."," This is a generated mode test. The project meeting starts tomorrow at 9. Please bring the blue notebook.")
        val draftFile=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(origin)+"/ask.enc");CentralDraftWrites.barrier{};val originalDraft=if(draftFile.exists())draftFile.readBytes()else null
        val queueDirectory=File(QueueStorage(context).current().path);val queueOriginals=queueDirectory.listFiles().orEmpty().filter{it.extension in setOf("event","blob")}.associate{it.name to it.readBytes()}
        var temporaryOwner:String?=null
        try{
            settings.signOut() // Local login state only. Never call logout with the retained collector credential.
            ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask")).use{
                until("Normal product owner login form"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="中央管理令牌"}}};main{shown().filterIsInstance<EditText>().single{it.contentDescription=="中央管理令牌"}.setText(vaultOwner)};click("登录并继续")
                until("Owner login session applied"){val token=settings.read().connectionToken();token.isNotBlank()&&token!=before.connectionToken()&&token!=vaultOwner};temporaryOwner=settings.read().connectionToken()
                until("Actual owner page idle"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.isEnabled}}}
            }
            val api=CentralAccess.requireClient(context);assertEquals("owner",api.get("/api/connections/self").getJSONObject("credential").getString("scope"));val snapshot=api.get("/api/conversations/$conversation?limit=50");val turns=snapshot.getJSONArray("turns");require(turns.length()==1&&turns.getJSONObject(0).getString("id")==turnId);val turn=turns.getJSONObject(0);val citations=turn.getJSONObject("result").getJSONArray("citations");assertEquals(ids,(0 until citations.length()).map{citations.getJSONObject(it).getString("id")})
            val originals=ids.map{api.get("/api/capture-browser/$it")};originals.forEachIndexed{i,row->assertTrue(row.getString("ocrText").endsWith("\n"+expected[i]));assertEquals("file",row.getString("source"));assertEquals(row.getString("libraryVersion"),row.getJSONObject("provenance").getString("uri"))}
            val draft="Generated H04 exact-derived reference return draft"
            ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",conversation)).use{scenario->
                until("Actual H04 parent conversation selected"){if(has("还有未发送的内容"))click("舍弃并切换");var selected=false;scenario.onActivity{selected=!it.isWorking&&it.selectedAskConversationId==conversation};selected&&has(turn.getString("question"))}
                main{shown().filterIsInstance<EditText>().single{it.contentDescription=="你的问题"}.setText(draft)}
                for(i in ids.indices){
                    main{MoteAppearance.select(context,if(i==0)AppearancePreference.LIGHT else AppearancePreference.DARK)}
                    val label="查看引用 ${i+1} · ";until("Exact H04 turn citation row"){main{shown().any{it.contentDescription?.toString()?.startsWith(label)==true}}};main{shown().single{it.contentDescription?.toString()?.startsWith(label)==true}.performClick()}
                    until("Public reader shows full exact typed text"){main{shown().filterIsInstance<TextView>().any{it.tag=="capture-reference-text"&&it.text.toString()==expected[i]}}}
                    assertFalse(has("imageLocation"));assertFalse(has("{\"speaker\""));assertFalse(main{shown().any{it.tag=="capture-reference-canonical"}});picture("h04-citation-${i+1}-readable-default")
                    clickDisclosure("更多");until("Complete exact canonical remains explicitly readable"){main{shown().filterIsInstance<TextView>().any{it.tag=="capture-reference-canonical"&&it.text.toString()==originals[i].getString("ocrText")}}};picture("h04-citation-${i+1}-canonical-more");click("返回上级")
                    until("Same actual parent and full later draft returned"){var selected=false;scenario.onActivity{selected=!it.isWorking&&it.selectedAskConversationId==conversation};selected&&main{shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.text.toString()==draft}}};picture("h04-citation-${i+1}-same-parent-return")
                }
            }
            assertEquals(turns.toString(),api.get("/api/conversations/$conversation?limit=50").getJSONArray("turns").toString())
            File(context.filesDir,"final-selected-risk/h04-derived-reader-facts.json").writeText(JSONObject().put("conversationId",conversation).put("turnId",turnId).put("evidenceIds",JSONArray(ids)).put("pins",JSONArray(originals.map{it.getString("libraryVersion")})).put("newInference",false).put("fullCanonicalPreserved",true).put("sameParentAndDraft",true).toString())
        }finally{
            var logoutConfirmed=false
            temporaryOwner?.takeIf{it!=before.connectionToken()&&it!=vaultOwner}?.let{token->
                logoutConfirmed=runCatching { val api=CentralClient(origin,token);api.post("/api/login/logout",JSONObject());val rejected=runCatching{api.get("/api/connections/self")}.exceptionOrNull();rejected is CentralFailure && rejected.status==401 }.getOrDefault(false)
            }
            CentralDraftWrites.barrier{if(originalDraft==null)draftFile.delete()else draftFile.writeBytes(originalDraft)}
            val edit=preferences.edit().clear();originalPreferences.forEach{(key,value)->when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);is Int->edit.putInt(key,value);is Long->edit.putLong(key,value);is Float->edit.putFloat(key,value);is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet());else->error("Unsupported preference")}};check(edit.commit());CentralSession.get(context).select(origin);assertEquals(before,settings.read());assertEquals(originalPreferences,preferences.all)
            assertEquals("collector",CentralAccess.requireClient(context).get("/api/connections/self").getJSONObject("credential").getString("scope"));if(temporaryOwner!=null)assertTrue("Only new owner session must be revoked",logoutConfirmed)
            File(context.filesDir,"final-selected-risk/h04-derived-reader-facts.json").takeIf{it.isFile}?.let{file->file.writeText(JSONObject(file.readText()).put("newOwnerSessionLoggedOut",logoutConfirmed).put("collectorRoleRestored",true).put("originalCredentialStoredValuesRestored",true).toString())}
            val after=queueDirectory.listFiles().orEmpty().filter{it.extension in setOf("event","blob")}.associate{it.name to it.readBytes()};assertEquals(queueOriginals.keys,after.keys);queueOriginals.forEach{(name,bytes)->assertArrayEquals(bytes,after[name])}
        }
    }

    private fun restorePreferences(prefs:android.content.SharedPreferences,values:Map<String,*>) {val edit=prefs.edit().clear();values.forEach{(key,value)->when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);is Int->edit.putInt(key,value);is Long->edit.putLong(key,value);is Float->edit.putFloat(key,value);is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet());else->error("Unsupported preference")}};check(edit.commit());assertEquals(values,prefs.all)}
    private fun clickRow(label:String){until("Native row $label"){main{shown().filterIsInstance<TextView>().any{it.text.toString()==label}}};main{var row:View=shown().filterIsInstance<TextView>().first{it.text.toString()==label};while(!row.isClickable&&row.parent is View)row=row.parent as View;assertTrue(row.isClickable);row.performClick()}}
    private fun centralIdle()=main{ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<CentralActivity>().singleOrNull()?.let{!it.isWorking}==true}
    private fun backActivity(){until("Current app Activity is resumed before Back"){main{ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any{it.packageName==context.packageName&&!it.isFinishing}}};main{ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single{it.packageName==context.packageName&&!it.isFinishing}.onBackPressed()};instrumentation.waitForIdleSync();until("Previous app window is resumed after its Back callback"){main{ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any{it.packageName==context.packageName&&!it.isFinishing}&&WindowInspector.getGlobalWindowViews().any{it.isShown&&it.hasWindowFocus()}}}}
    private fun withFinalOwner(block:(CentralClient)->Unit){
        val settings=Settings(context);val before=settings.read();val prefs=context.getSharedPreferences("mote",0);val values=prefs.all.toMap();val cfg=JSONObject(File(context.filesDir,"final-calendar-journey.json").readText());require(cfg.getBoolean("generatedOnly")&&cfg.getString("origin")==before.server);val owner=cfg.getString("ownerToken")
        val ask=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(before.server)+"/ask.enc");CentralDraftWrites.barrier{};val askBytes=if(ask.exists())ask.readBytes()else null;var temporary:String?=null
        try{
            settings.signOut();ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask")).use{
                until("Normal owner login"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="中央管理令牌"}}};main{shown().filterIsInstance<EditText>().single{it.contentDescription=="中央管理令牌"}.setText(owner)};click("登录并继续");until("Normal short owner session"){settings.read().connectionToken().let{it.isNotBlank()&&it!=owner&&it!=before.connectionToken()}};temporary=settings.read().connectionToken();until("Actual owner composer"){main{shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.isEnabled}}}
            };val api=CentralAccess.requireClient(context);assertEquals("owner",api.get("/api/connections/self").getJSONObject("credential").getString("scope"));block(api)
        }finally{
            var revoked=temporary==null;temporary?.let{token->revoked=runCatching{val client=CentralClient(before.server,token);client.post("/api/login/logout",JSONObject());val error=runCatching{client.get("/api/connections/self")}.exceptionOrNull();error is CentralFailure&&error.status==401}.getOrDefault(false)}
            CentralDraftWrites.barrier{if(askBytes==null)ask.delete()else ask.writeBytes(askBytes)};restorePreferences(prefs,values);CentralSession.get(context).select(before.server);assertEquals(before,settings.read());assertEquals("collector",CentralAccess.requireClient(context).get("/api/connections/self").getJSONObject("credential").getString("scope"));assertTrue("Only this short owner session revoked",revoked)
        }
    }
    @Test fun finalHomeOfflineDraftAttentionAndDarkHistoricalPagingUseControlledReadOnlyHttp()=fixture{
        val draftStore=context.recordDraftStore();require(!draftStore.hasPrepared());val old=draftStore.draft();val settings=Settings(context)
        HttpFixture().use{http->ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,"Generated final navigation",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)}
            try{
                draftStore.edit("Generated final home offline draft",old.getJSONArray("attachments"),JSONObject().put("kind","manual"),"Generated retained home context");http.failReads=true;main{MoteAppearance.select(context,AppearancePreference.DARK)}
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{scenario->
                    until("Actual failed feed keeps local record action"){has("暂不可读取")&&main{shown().any{it.tag=="home-record-action"}}};assertTrue(main{shown().any{it.contentDescription=="继续草稿"||it is TextView&&it.text.toString().contains("继续草稿")}});assertFalse(main{shown().any{it.tag?.toString()?.startsWith("home-discovery:")==true}});picture("final-home-dark-offline-draft")
                    settings.status("permission_required","Generated controlled permission interruption");until("Actionable capture issue is visible without starting capture"){main{shown().any{it.tag=="home-notice-needs-action"}}};main{shown().single{it.tag=="home-notice-needs-action"}.performClick()};until("The amber line opens the capture status panel (D36)"){main{shown().any{it.tag=="capture-status-screen"}}};main{shown().single{it.tag=="capture-status-screen"}.performClick()};until("Actual recovery scope page"){main{shown().any{it.tag=="local-back:PRIVACY"}}};scenario.onActivity{it.onBackPressed()};assertEquals("Generated final home offline draft",draftStore.draft().getString("text"));picture("final-home-dark-actionable-return")
                }
                http.failReads=false;http.pagedHistory=true
                val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());store.write(JSONObject().put("conversationId",http.conversation).put("question","Generated dark historical later draft"))
                try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{scenario->
                    until("Actual first controlled dark history page"){has("Generated history answer 29")&&has("加载更早的对话")};assertEquals(20,main{shown().filterIsInstance<TextView>().count{it.text.toString().startsWith("Generated history answer ")}});picture("final-dark-history-latest-page");click("加载更早的对话");until("All nine older controlled turns replace the first 20-turn page"){main{shown().filterIsInstance<TextView>().count{it.text.toString().startsWith("Generated history answer ")}==9}};assertTrue(has("Generated history answer 1"));assertTrue(has("这是历史版本，当前资料已更新。"));picture("final-dark-history-older-page")
                    scenario.recreate();until("Same controlled history and later draft after recreation"){has("Generated history answer 29")&&main{shown().filterIsInstance<EditText>().any{it.text.toString()=="Generated dark historical later draft"}}};picture("final-dark-history-recreated");assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());assertTrue(http.olderReads.get()>0)
                }}finally{CentralDraftWrites.barrier{};directory.deleteRecursively()}
            }finally{draftStore.edit(old.getString("text"),old.getJSONArray("attachments"),old.getJSONObject("origin"),old.optString("description"),old.optJSONObject("originPresentation"))}
        }
    }
    @Test fun olderConversationFileCitationReturnsToSamePagePositionAndDraft()=fixture{
        HttpFixture().use{http->
            http.pagedHistory=true;http.pagedFileReference=true
            val settings=Settings(context);connectGenerated(settings,http,"Generated paged citation")
            val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());val draft="Generated older page unsent draft"
            store.write(JSONObject().put("conversationId",http.conversation).put("question",draft))
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{scenario->
                until("Latest page loaded"){has("Generated history answer 29")&&has("加载更早的对话")};click("加载更早的对话")
                until("Earlier page contains its exact file citation"){has("Generated history answer 1")&&main{shown().any{it.contentDescription?.toString()?.startsWith("查看引用 1 · ")==true}}}
                val row=main{shown().single{it.contentDescription?.toString()?.startsWith("查看引用 1 · ")==true}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}};instrumentation.waitForIdleSync()
                fun scroll()=main{shown().filterIsInstance<android.widget.ScrollView>().first().scrollY}
                val before=scroll();http.fileAvailable=false;main{row.performClick()};until("Deleted citation remains unavailable"){has("引用不可用")};click("返回原对话")
                until("Unavailable citation leaves the same earlier page and draft"){has("Generated history answer 1")&&main{shown().filterIsInstance<EditText>().any{it.text.toString()==draft}}};assertEquals(before,scroll());assertEquals(0,http.fileReads.get())
                http.fileAvailable=true;main{row.performClick()};until("Exact generated file original opened"){has("Generated exact file original")};assertEquals(1,http.fileReads.get())
                click("返回上级");until("Same earlier page, exact position and unsent draft return"){has("Generated history answer 1")&&!has("Generated history answer 29")&&main{shown().filterIsInstance<EditText>().any{it.text.toString()==draft}}&&scroll()==before}
                assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());picture("earlier-file-citation-return")
            }}finally{CentralDraftWrites.barrier{};directory.deleteRecursively()}
        }
    }
    @Test fun inlineUnavailableAndEarlierFileReturnPreservePhysicalTapPosition()=fixture{
        HttpFixture().use{http->
            http.pagedHistory=true;http.pagedFileReference=true
            val settings=Settings(context);connectGenerated(settings,http,"Generated inline position")
            val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());val draft="Generated inline position draft"
            store.write(JSONObject().put("conversationId",http.conversation).put("question",draft))
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{
                until("Latest page loaded"){has("Generated history answer 29")&&has("加载更早的对话")};click("加载更早的对话")
                val first=UUID.nameUUIDFromBytes((http.conversation+":1").toByteArray()).toString()
                until("Earlier page has the inline file citation"){main{shown().any{it.tag=="ask-answer:$first"}}}
                fun linkPoint(request: Boolean):FloatArray=main {
                    val view=shown().filterIsInstance<TextView>().single{it.tag=="ask-answer:$first"};val text=view.text as android.text.Spanned
                    val link=text.getSpans(0,text.length,android.text.style.ClickableSpan::class.java).single();val start=text.getSpanStart(link);val end=text.getSpanEnd(link);val layout=view.layout
                    val line=layout.getLineForOffset(start);val x=(layout.getPrimaryHorizontal(start)+layout.getPrimaryHorizontal(end))/2+view.totalPaddingLeft;val y=(layout.getLineTop(line)+layout.getLineBottom(line))/2f+view.totalPaddingTop
                    if(request)view.requestRectangleOnScreen(android.graphics.Rect(x.toInt(),y.toInt(),x.toInt()+1,y.toInt()+1),true)
                    val where=IntArray(2);view.getLocationOnScreen(where);floatArrayOf(where[0]+x,where[1]+y)
                }
                fun position():Pair<Int,Int> = main {
                    val question=shown().filterIsInstance<TextView>().single{it.text.toString()=="Generated history question 1"};val where=IntArray(2);question.getLocationOnScreen(where)
                    shown().filterIsInstance<android.widget.ScrollView>().first().scrollY to where[1]
                }
                fun tapLink(){val point=linkPoint(false);val down=SystemClock.uptimeMillis();instrumentation.sendPointerSync(android.view.MotionEvent.obtain(down,down,android.view.MotionEvent.ACTION_DOWN,point[0],point[1],0));instrumentation.sendPointerSync(android.view.MotionEvent.obtain(down,down+50,android.view.MotionEvent.ACTION_UP,point[0],point[1],0))}
                linkPoint(true);Thread.sleep(500);instrumentation.waitForIdleSync();val before=position()
                http.fileAvailable=false;tapLink();until("A physical inline tap shows the unavailable dialog"){has("引用不可用")};click("返回原对话")
                until("Unavailable returns to the older turn and draft"){has("Generated history answer 1")&&main{shown().filterIsInstance<EditText>().any{it.text.toString()==draft}}};Thread.sleep(500);instrumentation.waitForIdleSync();val unavailable=position()
                assertEquals("Unavailable inline reference keeps its scroll",before.first,unavailable.first);assertTrue("Unavailable returns the same turn to the same screen position",kotlin.math.abs(before.second-unavailable.second)<=2);assertEquals(0,http.fileReads.get())
                http.fileAvailable=true;tapLink();until("The exact earlier file opens"){has("Generated exact file original")};click("返回上级")
                until("File reader returns to the same earlier turn and draft"){has("Generated history answer 1")&&!has("Generated history answer 29")&&main{shown().filterIsInstance<EditText>().any{it.text.toString()==draft}}};Thread.sleep(500);instrumentation.waitForIdleSync();val returned=position()
                assertEquals("File reference keeps the older page scroll",before.first,returned.first);assertTrue("File reference returns the same turn to the same screen position",kotlin.math.abs(before.second-returned.second)<=2)
                assertEquals(1,http.fileReads.get());assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());picture("inline-earlier-file-return-position")
                File(context.filesDir,"final-selected-risk").apply{mkdirs()}.resolve("inline-position-facts.json").writeText(JSONObject().put("beforeScroll",before.first).put("beforeQuestionY",before.second).put("unavailableScroll",unavailable.first).put("unavailableQuestionY",unavailable.second).put("returnedScroll",returned.first).put("returnedQuestionY",returned.second).put("queries",http.queryPosts.get()).put("captureWrites",http.capturePosts.get()).toString(2))
            }}finally{CentralDraftWrites.barrier{};directory.deleteRecursively()}
        }
    }
    @Test fun runningConversationResumesPollingAfterNativeCitationReader()=fixture{
        HttpFixture().use{http->
            http.pagedHistory=true;http.pagedFileReference=true;http.nativeReference=true;http.runningFixture=true
            val settings=Settings(context)
            until("Generated connection waits for any existing background read to finish"){
                try { ConnectionGuard.change(context,http.origin,bindLocal=true){settings.saveConnection(http.origin,http.token,"Generated running reader",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)}; true }
                catch (error: ConnectionFailure) { if(error.category=="busy") false else throw error }
            }
            val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());val draft="Generated later unsent draft while another run finishes"
            store.write(JSONObject().put("conversationId",http.conversation).put("question",draft).put("runId",http.runId).put("runStatus","running"))
            fun saved()=CentralDraftWrites.barrier { store.read() }
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{scenario->
                until("The running conversation and its older citation are visible"){has("Generated history answer 29")&&main{shown().any{it.contentDescription?.toString()?.startsWith("查看引用 1 · ")==true}}}
                until("The same running request is polled"){http.runReads.get()>0&&saved().optString("runStatus")=="running"}
                until("The citation row can be opened while the run remains active"){var idle=false;scenario.onActivity{idle=!it.isWorking};idle}
                main{shown().single{it.contentDescription?.toString()?.startsWith("查看引用 1 · ")==true}.performClick()}
                until("The separate native reader shows the exact cited original"){has("Generated exact file original")&&main{WindowInspector.getGlobalWindowViews().any{it.hasWindowFocus()&&it.isShown}}}
                val readsWhileOpen=http.runReads.get();http.runCompleted=true;Thread.sleep(1900);assertEquals("The paused conversation does not poll behind the reader",readsWhileOpen,http.runReads.get())
                click("返回上一页")
                until("Return polls the same request and observes its completion"){saved().optString("runId")==http.runId&&saved().optString("runStatus")=="completed"&&http.runReads.get()>readsWhileOpen}
                until("The same conversation and independent draft remain"){var selected=false;scenario.onActivity{selected=!it.isWorking&&it.selectedAskConversationId==http.conversation};selected&&main{shown().filterIsInstance<EditText>().any{it.contentDescription=="你的问题"&&it.text.toString()==draft}}}
                assertEquals(draft,saved().getString("question"));assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());picture("running-native-citation-resumed")
                File(context.filesDir,"final-selected-risk").apply{mkdirs()}.resolve("running-reader-facts.json").writeText(JSONObject().put("runId",http.runId).put("readsWhileReaderOpen",readsWhileOpen).put("readsAfterReturn",http.runReads.get()).put("statusAfterReturn",saved().getString("runStatus")).put("draftRetained",true).put("queryWrites",http.queryPosts.get()).put("captureWrites",http.capturePosts.get()).toString(2))
            }}finally{CentralDraftWrites.barrier{};directory.deleteRecursively()}
        }
    }
    @Test fun unreadableLocalDraftJournalDoesNotBlockAuthorizedRemoteNote()=fixture{
        HttpFixture().use{http->
            val settings=Settings(context);connectGenerated(settings,http,"Generated remote note")
            val journal=File(context.noBackupFilesDir,"record-draft/record.enc");val before=if(journal.exists())journal.readBytes()else null
            try{
                journal.parentFile!!.mkdirs();journal.writeText("generated-invalid-encrypted-journal")
                val intent=Intent(context,CaptureRecordsActivity::class.java).putExtra("recordId",http.noteId).putExtra("recordRemote",true).putExtra("recordOrigin",http.origin).putExtra("directReader",true)
                ActivityScenario.launch<CaptureRecordsActivity>(intent).use {
                    until("Authorized remote note is readable despite unavailable local preview cache"){has("Generated remote note original")}
                    assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());picture("remote-note-with-unreadable-local-cache")
                }
            }finally{if(before==null)journal.delete()else journal.writeBytes(before)}
        }
    }
    @Test fun staleInlineCitationCannotOpenAfterNavigationOrSessionChange()=fixture{
        HttpFixture().use{http->
            http.pagedHistory=true;http.pagedFileReference=true
            val settings=Settings(context);connectGenerated(settings,http,"Generated stale citation")
            val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());store.write(JSONObject().put("conversationId",http.conversation).put("question","Generated retained citation draft"))
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{scenario->
                fun olderInline():Pair<TextView,android.text.style.ClickableSpan>{
                    until("Latest page"){has("Generated history answer 29")&&has("加载更早的对话")};click("加载更早的对话")
                    lateinit var result:Pair<TextView,android.text.style.ClickableSpan>
                    until("Earlier verified inline citation"){main{val view=shown().filterIsInstance<TextView>().firstOrNull{it.text.toString().startsWith("Generated history answer 1 ")};val text=view?.text as? android.text.Spanned;val span=text?.getSpans(0,text.length,android.text.style.ClickableSpan::class.java)?.firstOrNull();if(view!=null&&span!=null){result=view to span;true}else false}}
                    return result
                }
                val old=olderInline();scenario.onActivity{it.navigate("overview")};until("Other page is idle"){var idle=false;scenario.onActivity{idle=!it.isWorking};idle}
                main{old.second.onClick(old.first)};instrumentation.waitForIdleSync();assertEquals(0,http.referenceReads.get());assertEquals(0,http.fileReads.get())
                scenario.onActivity{it.navigate("ask")};val current=olderInline();http.holdReference=true
                main{current.second.onClick(current.first)};assertTrue("Reference request reached controlled server",http.referenceEntered.await(5,java.util.concurrent.TimeUnit.SECONDS))
                settings.signIn(http.origin,"generated-replacement-owner-token",86400000);http.referenceRelease.countDown()
                until("Late reference result has settled"){var idle=false;scenario.onActivity{idle=!it.isWorking};idle};instrumentation.waitForIdleSync()
                assertEquals(1,http.referenceReads.get());assertEquals("Old owner response cannot open a file",0,http.fileReads.get());assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get())
            }}finally{http.referenceRelease.countDown();CentralDraftWrites.barrier{};directory.deleteRecursively()}
        }
    }
    @Test fun erasedTurnCannotOpenEvidenceStillReferencedByAnotherTurn()=fixture{
        HttpFixture().use{http->
            http.pagedHistory=true;http.pagedFileReference=true;http.twoCitations=true
            val settings=Settings(context);connectGenerated(settings,http,"Generated erased turn")
            val directory=File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(http.origin));val store=CentralStateFile(directory,"ask",context.secretBox());store.write(JSONObject().put("conversationId",http.conversation).put("question","Generated retained erasure draft"))
            try{ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",http.conversation)).use{
                until("Latest page loaded"){has("Generated history answer 29")&&has("加载更早的对话")};click("加载更早的对话")
                val first=UUID.nameUUIDFromBytes((http.conversation+":1").toByteArray()).toString();lateinit var view:TextView;lateinit var span:android.text.style.ClickableSpan
                until("Original first turn displays its own citation"){main{val found=shown().filterIsInstance<TextView>().firstOrNull{it.tag=="ask-answer:$first"};val text=found?.text as? android.text.Spanned;val link=text?.getSpans(0,text.length,android.text.style.ClickableSpan::class.java)?.firstOrNull();if(found!=null&&link!=null){view=found;span=link;true}else false}}
                http.erasedFirstTurn=true;main{span.onClick(view)};until("Erased turn does not open another turn's still available evidence"){has("引用不可用")}
                assertEquals(0,http.fileReads.get());assertEquals(0,http.referenceReads.get());assertEquals(0,http.queryPosts.get());assertEquals(0,http.capturePosts.get());click("返回原对话")
                until("Unsent draft still present"){main{shown().filterIsInstance<EditText>().any{it.text.toString()=="Generated retained erasure draft"}}}
            }}finally{CentralDraftWrites.barrier{};directory.deleteRecursively()}
        }
    }
    @Test fun finalHomeMenuSourceArchiveAndRegisteredCentralConsumersReturnWithoutWrites()=fixture{withFinalOwner{api->
        val draft=context.recordDraftStore();require(!draft.hasPrepared());val old=draft.draft();val local=LocalSource(name="Generated final source return",kind="local-calendar",calendarId=1,enabled=false,description="Generated local-only source return draft");val sources=context.localSources();require(sources.sources().isEmpty());sources.save(local)
        try{
            draft.edit("Generated menu retained local draft",old.getJSONArray("attachments"),JSONObject().put("kind","manual"),old.optString("description"))
            val reports=api.get("/api/insights?limit=30").getJSONArray("items");val finding=requireNotNull(InsightPresentation.featured(reports));val reportId=InsightPresentation.id(finding)!!
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use{scenario->
                until("Actual existing archived report card on home"){main{shown().any{it.tag=="home-discovery:$reportId"}}};picture("final-home-light-existing-result");if(InstrumentationRegistry.getArguments().getString("nativeFinalHomeOnly")=="true"){main{MoteAppearance.select(context,AppearancePreference.DARK)};until("Same archived report remains available after native dark appearance replay"){main{shown().any{it.tag=="home-discovery:$reportId"}}};picture("final-home-dark-existing-result");return@withFinalOwner};main{shown().single{it.tag=="home-discovery:$reportId"}.performClick()};until("Exact existing report opened without generation"){main{shown().any{it.tag=="insight-content"}}&&has(InsightPresentation.title(finding))};picture("final-home-exact-result")
                backActivity();until("Report returns through its existing history"){centralIdle()&&has("发现历史")};backActivity();until("Exact home restored"){main{shown().any{it.tag=="home-record-action"}}}
                for(label in if(InstrumentationRegistry.getArguments().getString("nativeFinalConsumersFrom")==null)listOf("资料与记忆","发现历史","日程与待办","采集与同步","设置","中央工作台")else emptyList()){
                    clickHomeMenu();until("Registered light menu"){main{shown().any{it.tag=="menu:$label"}}};if(label=="资料与记忆")picture("final-light-secondary-menu");main{shown().single{it.tag=="menu:$label"}.performClick()}
                    until("Selected secondary destination $label"){!main{shown().any{it.tag=="home-record-action"}||shown().any{it.tag=="menu:中央工作台"}}};picture("final-menu-"+label)
                    repeat(4){if(!main{shown().any{it.tag=="home-record-action"}})backActivity()};until("Menu destination returns to same home"){main{shown().any{it.tag=="home-record-action"}}};assertEquals("Generated menu retained local draft",draft.draft().getString("text"))
                }
                val visited=JSONArray();val resumeAt=InstrumentationRegistry.getArguments().getString("nativeFinalConsumersFrom");var reached=resumeAt==null
                for(group in MoteNavigation.groups)for(page in group.pages){
                    if(page==resumeAt)reached=true;if(!reached)continue
                    clickHomeMenu();main{shown().single{it.tag=="menu:中央工作台"}.performClick()};until("Actual Central overview idle"){centralIdle()&&main{shown().filterIsInstance<TextView>().any{it.tag=="central-title"}}};click("更多");chooseNativeListItem(group.titleKey);chooseNativeListItem(CentralScreens.pages.single{it.first==page}.second)
                    until("Registered current consumer $page has real readable page or error"){centralIdle()&&main{val title=shown().filterIsInstance<TextView>().firstOrNull{it.tag=="central-title"};val container=shown().filterIsInstance<ViewGroup>().firstOrNull{it.tag=="central-body"};title!=null&&container!=null&&container.childCount>0&&!(shown().filterIsInstance<TextView>().any{it.text.toString().startsWith("正在读取")})}}
                    val details=main{JSONObject().put("route",page).put("header",shown().filterIsInstance<TextView>().first{it.tag=="central-title"}.text.toString()).put("visibleTextCount",shown().filterIsInstance<TextView>().count())};visited.put(details);picture("final-consumer-$page")
                    repeat(6){if(!main{shown().any{it.tag=="home-record-action"}})backActivity()};until("Consumer $page returns exact home"){main{shown().any{it.tag=="home-record-action"}}};assertEquals("Generated menu retained local draft",draft.draft().getString("text"))
                }
                File(context.filesDir,"final-selected-risk/final-native-menu-consumers.json").writeText(JSONObject().put("visited",visited).put("existingReportId",reportId).put("resumedAt",resumeAt?:JSONObject.NULL).put("queryOrSaveActions",0).toString())
            }
            ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("detailSourceId",local.id)).use{
                until("Actual same local source detail"){has(local.name)&&has("资料库")};picture("final-source-before-central");clickRow("资料库");val catalog=api.get("/api/library/catalog?limit=24").getJSONArray("items");require(catalog.length()>0);until("Actual generic same-origin Central archive"){has(catalog.getJSONObject(0).getString("title"))&&has("全部资料")};picture("final-source-central-generic-archive");backActivity();until("Return same local source identity and description"){has(local.name)&&main{shown().any{it.tag=="source-primary-status"}}};assertEquals(local,sources.sources().single());picture("final-source-return-same-local-detail")
            }
        }finally{sources.remove(local.id);draft.edit(old.getString("text"),old.getJSONArray("attachments"),old.getJSONObject("origin"),old.optString("description"),old.optJSONObject("originPresentation"))}
    }}
    private class HttpFixture:AutoCloseable{
        val token="generated-only-local-risk-owner-token";val conversation=UUID.randomUUID().toString();val fileId=UUID.randomUUID().toString();val noteId=UUID.randomUUID().toString();val runId=UUID.randomUUID().toString();val redeems=AtomicInteger();val deletes=AtomicInteger();val queryPosts=AtomicInteger();val capturePosts=AtomicInteger();val helpReads=AtomicInteger();val olderReads=AtomicInteger();val fileReads=AtomicInteger();val referenceReads=AtomicInteger();val runReads=AtomicInteger();val referenceEntered=java.util.concurrent.CountDownLatch(1);val referenceRelease=java.util.concurrent.CountDownLatch(1);@Volatile var failReads=false;@Volatile var pagedHistory=false;@Volatile var pagedFileReference=false;@Volatile var nativeReference=false;@Volatile var runningFixture=false;@Volatile var runCompleted=false;@Volatile var twoCitations=false;@Volatile var erasedFirstTurn=false;@Volatile var fileAvailable=true;@Volatile var holdReference=false;private val server=ServerSocket(0,10,InetAddress.getByName("127.0.0.1"));val origin="http://127.0.0.1:${server.localPort}";private val threads=Executors.newCachedThreadPool()
        init{threads.submit{while(!server.isClosed)runCatching{server.accept()}.getOrNull()?.let{socket->threads.submit{socket.use{
            val input=it.getInputStream().bufferedReader();val first=input.readLine().orEmpty();val path=first.split(' ').getOrElse(1){""};val headers=mutableListOf<String>();while(true){val h=input.readLine();if(h.isNullOrEmpty())break;headers.add(h)};val size=headers.firstOrNull{h->h.startsWith("Content-Length:",true)}?.substringAfter(':')?.trim()?.toInt()?:0;val body=CharArray(size);var n=0;while(n<size){val x=input.read(body,n,size-n);if(x<0)break;n+=x}
            if(path=="/generated-install-help"){helpReads.incrementAndGet();val bytes="<!doctype html><title>Generated Mote help</title><h1>Generated Mote installation help boundary</h1><p>Generated local documentation only. No sign in or installation.</p>".toByteArray();it.getOutputStream().apply{write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush()};return@use}
            if(first.startsWith("POST ")&&path=="/api/captures")capturePosts.incrementAndGet()
            if(path=="/api/connections/redeem"){redeems.incrementAndGet();return@use}
            var status="200 OK";val response=when{
                failReads&&first.startsWith("GET ")->{status="503 Service Unavailable";JSONObject().put("error","config_unavailable")}
                runningFixture&&path=="/api/query-runs/$runId"->{runReads.incrementAndGet();JSONObject().put("id",runId).put("status",if(runCompleted)"completed" else "running").put("conversationId",conversation).put("events",JSONArray())}
                pagedFileReference&&path=="/api/conversations/$conversation/references/$fileId"->{referenceReads.incrementAndGet();if(holdReference){referenceEntered.countDown();referenceRelease.await(10,java.util.concurrent.TimeUnit.SECONDS)};JSONObject().put("id",fileId).put("available",fileAvailable)}
                pagedFileReference&&path=="/api/capture-browser/$fileId"->{fileReads.incrementAndGet();JSONObject().put("id",fileId).put("source",if(nativeReference)"screen"else"file").put("deviceId","generated-device").put("libraryVersion","generated-version").put("appName","Generated file").put("capturedAt","2026-10-30T00:00:00Z").put("ocrText","Generated exact file original").put("metadata",JSONObject())}
                path=="/api/capture-browser/$noteId"->JSONObject().put("id",noteId).put("deviceId","generated-device").put("source","note").put("appName","Generated note").put("capturedAt","2026-10-30T00:00:00Z").put("ocrText","Generated remote note original").put("metadata",JSONObject().put("version",1))
                pagedHistory&&path.startsWith("/api/conversations/$conversation")-> {
                    val older=path.contains("cursor=");if(older)olderReads.incrementAndGet()
                    val numbers=if(older)1..9 else 10..29
                    JSONObject().put("id",conversation).put("scope",JSONObject()).put("turns",JSONArray(numbers.map{n->
                        val cites=pagedFileReference&&(n==1||(twoCitations&&n==2)||(nativeReference&&n==29));val erased=erasedFirstTurn&&n==1
                        JSONObject().put("id",UUID.nameUUIDFromBytes((conversation+":"+n).toByteArray()).toString()).put("status","completed").put("question","Generated history question $n").put("evidenceStale",true).also { if(erased)it.put("evidenceDeleted",true) }.put("result",JSONObject().put("answer","Generated history answer $n" + if(pagedFileReference)" " + "generated detail ".repeat(18) + if(cites)" [$fileId]"else "" else "").put("citations",if(cites)JSONArray().put(JSONObject().put("id",fileId).put("title","Generated file"))else JSONArray()))
                    })).put("nextCursor",if(older)JSONObject.NULL else "generated-earlier-page")
                }
                first.startsWith("DELETE ")&&path=="/api/conversations/$conversation"->{deletes.incrementAndGet();status="503 Service Unavailable";JSONObject().put("error","generated_delete_unavailable")}
                first.startsWith("POST ")&&path.startsWith("/api/query-runs")->{queryPosts.incrementAndGet();status="503 Service Unavailable";JSONObject().put("error","query_not_allowed")}
                path.startsWith("/api/conversations/$conversation")->JSONObject().put("id",conversation).put("scope",JSONObject()).put("turns",JSONArray().put(JSONObject().put("id",UUID.randomUUID().toString()).put("status","completed").put("question","Generated isolated history").put("result",JSONObject().put("answer","Generated controlled existing answer").put("citations",JSONArray()))))
                path.startsWith("/api/conversations?")->JSONObject().put("items",JSONArray().put(JSONObject().put("id",conversation).put("title","Generated isolated history").put("turnCount",1).put("updatedAt","2026-10-30T00:00:00Z")))
                path.startsWith("/api/model-settings")->JSONObject().put("profiles",JSONArray())
                else->JSONObject().put("items",JSONArray())
            };val bytes=response.toString().toByteArray();it.getOutputStream().apply{write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush()}
        }}}}}
        override fun close(){server.close();threads.shutdownNow()}
    }
}
