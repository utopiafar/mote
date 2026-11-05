package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.provider.CalendarContract
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inspector.WindowInspector
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Manually selected gaps only. Dedicated generated Dev profile, no collector start or model calls. */
@RunWith(AndroidJUnit4::class)
class RemainingFinalUiInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T { val value=AtomicReference<Result<T>>();instrumentation.runOnMainSync { value.set(runCatching(block)) };return value.get().getOrThrow() }
    private fun views(root:View):List<View> = listOf(root)+if(root is ViewGroup)(0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun visible()=WindowInspector.getGlobalWindowViews().filter { it.isShown&&it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+20_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(50)};fail(label)}
    private fun click(label:String) {
        fun matches(view:View)=view.isEnabled&&(view is TextView&&view.text.toString()==MoteI18n.text(label)||view.contentDescription?.toString()==MoteI18n.text(label))
        until(label) { main { visible().any(::matches) } }
        main {
            val selected=visible().first(::matches)
            var ancestor=selected.parent
            while(ancestor is View&&ancestor !is android.widget.AdapterView<*>)ancestor=ancestor.parent
            if(ancestor is android.widget.AdapterView<*>) { val position=ancestor.getPositionForView(selected);assertTrue(ancestor.performItemClick(selected,position,ancestor.getItemIdAtPosition(position))) }
            else { var target=selected;while(!target.isClickable&&target.parent is View)target=target.parent as View;target.requestRectangleOnScreen(android.graphics.Rect(0,0,target.width,target.height),true);assertTrue(target.performClick()) }
        }
    }
    private fun tag(value:String){until(value){main { visible().any { it.tag==value&&it.isEnabled } }};main { visible().single { it.tag==value }.performClick() }}
    private fun text(value:String)=main { visible().filterIsInstance<TextView>().any { it.text.toString().contains(MoteI18n.text(value)) } }
    private fun picture(activity:Activity,name:String){val root=activity.window.decorView;GeneratedWindowRendering.save(activity,File(context.filesDir,"ui-final-remaining").apply { mkdirs() },name,WindowInspector.getGlobalWindowViews().filter { it!==root&&it.isShown&&it.hasWindowFocus() }) }
    private fun settledFrames(scenario:ActivityScenario<out Activity>){val ready=java.util.concurrent.CountDownLatch(1);scenario.onActivity { a->a.window.decorView.postOnAnimation { a.window.decorView.postOnAnimation { ready.countDown() } } };assertTrue("Actual native frames must settle",ready.await(5,java.util.concurrent.TimeUnit.SECONDS))}
    private fun systemPicture(name:String){instrumentation.uiAutomation.takeScreenshot()?.let { bitmap->File(context.filesDir,"ui-final-remaining").apply { mkdirs() }.resolve("$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle() }?:fail("System screenshot unavailable")}
    private fun nodes(root:AccessibilityNodeInfo?):List<AccessibilityNodeInfo> = if(root==null) emptyList() else listOf(root)+(0 until root.childCount).flatMap { nodes(root.getChild(it)) }
    private fun systemClick(label:String,predicate:(AccessibilityNodeInfo)->Boolean) {
        var selected:AccessibilityNodeInfo?=null
        until(label) { selected=nodes(instrumentation.uiAutomation.rootInActiveWindow).firstOrNull(predicate);selected!=null }
        var node=selected!!
        while(!node.isClickable) { val parent=node.parent; if(parent==null)break;node=parent }
        assertTrue(label,node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun fixture(block:(File)->Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("remainingUiFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);require(!settings.enabled&&!ProjectionService.running&&!CaptureAccessibilityService.connected&&context.queue().inventory().records==0)
        val old=settings.read();val language=MoteI18n.preference();val appearance=MoteAppearance.preference();val draft=context.recordDraftStore().draft();val root=File(context.cacheDir,"record-camera/remaining-${UUID.randomUUID()}").apply { mkdirs() }
        try { MoteI18n.select(context,"zh-CN");main { MoteAppearance.select(context,AppearancePreference.DARK) };settings.save(old.copy(server="",token="",syncPaused=true,syncMode="manual"),confirmCentralEndpoint=true);return block(root) }
        finally { assertFalse(settings.enabled);context.recordDraftStore().edit(draft.optString("text"),draft.getJSONArray("attachments"),draft.getJSONObject("origin"),draft.optString("description"),draft.optJSONObject("originPresentation"));settings.save(old,confirmCentralEndpoint=true);MoteI18n.select(context,language);main { MoteAppearance.select(context,appearance) };root.deleteRecursively() }
    }
    @Test fun darkSharedDraftSurvivesRealMicrophoneAndCameraDenialsWithoutRecording() = fixture {
        require(context.checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED&&context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)
        val original="Generated shared original; retained byte-for-byte."
        ActivityScenario.launch<RecordEditorActivity>(Intent(context,RecordEditorActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,original)).use { scenario->
            until("shared draft ready"){main { visible().any { it.tag=="record-origin-fulltext" } }}
            main { (visible().filterIsInstance<EditText>().single { it.contentDescription=="正在想什么" }).setText("Generated retained personal supplement") }
            click("资料说明（选填）");main { (visible().single { it.tag=="record-description" } as EditText).setText("Generated independent explanation") };click("资料说明（选填）")
            for((label,permission)in listOf("录音" to Manifest.permission.RECORD_AUDIO,"拍照" to Manifest.permission.CAMERA)){
                main { visible().single { it.contentDescription==label&&it.isClickable }.performClick() }
                until("real Android permission dialog"){nodes(instrumentation.uiAutomation.rootInActiveWindow).any { it.viewIdResourceName?.endsWith(":id/permission_deny_button")==true }}
                systemPicture("p03-p06-${if(label=="录音")"microphone" else "camera"}-system-denial")
                systemClick("deny generated permission"){it.viewIdResourceName?.endsWith(":id/permission_deny_button")==true}
                until("permission denial returns to editor"){text("权限未授予")}
                assertNotEquals(PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(permission));assertEquals(0,context.recordDraftStore().pendingMedia().length());assertEquals(0,context.queue().inventory().records)
                scenario.onActivity { picture(it,"p06-${if(label=="录音")"microphone" else "camera"}-denied-dark") }
            }
            scenario.recreate();until("retained separate supplement"){main { visible().filterIsInstance<EditText>().any { it.text.toString()=="Generated retained personal supplement" } }}
            main { assertEquals(original,(visible().single { it.tag=="record-origin-fulltext" } as TextView).text.toString());assertTrue(visible().any { it.tag=="record-origin-fulltext" });assertFalse(visible().any { it.tag=="record-description" }) }
            assertEquals("Generated independent explanation",context.recordDraftStore().draft().getString("description"));scenario.onActivity { picture(it,"p06-dark-restored-quote-and-supplement") }
        }
    }
    @Test fun darkSettingsAndDeviceOptionsHaveCompleteVisibleContentWhileStopped() = fixture {
        for(page in listOf("SETTINGS","DEVICE_OPTIONS"))ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page",page)).awaitMainUi().use { scenario->
            scenario.onActivity { picture(it,"p24-${page.lowercase()}-top-dark");views(it.window.decorView).filterIsInstance<ScrollView>().firstOrNull()?.fullScroll(View.FOCUS_DOWN) };instrumentation.waitForIdleSync();scenario.onActivity { picture(it,"p24-${page.lowercase()}-bottom-dark") };assertFalse(Settings(context).enabled)
        }
    }
    @Test fun actualLocalCalendarPickerSavesItsScopeAndCancelKeepsItPaused() = fixture {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName,Manifest.permission.READ_CALENDAR);instrumentation.uiAutomation.grantRuntimePermission(context.packageName,Manifest.permission.WRITE_CALENDAR)
        val account="generated-final-${UUID.randomUUID()}";val label="Generated final picker calendar"
        val uri=CalendarContract.Calendars.CONTENT_URI.buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER,"true").appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME,account).appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL).build()
        val created=requireNotNull(context.contentResolver.insert(uri,ContentValues().apply { put(CalendarContract.Calendars.ACCOUNT_NAME,account);put(CalendarContract.Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL);put(CalendarContract.Calendars.NAME,account);put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,label);put(CalendarContract.Calendars.OWNER_ACCOUNT,account);put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,CalendarContract.Calendars.CAL_ACCESS_OWNER);put(CalendarContract.Calendars.VISIBLE,1);put(CalendarContract.Calendars.SYNC_EVENTS,1);put(CalendarContract.Calendars.CALENDAR_TIME_ZONE,"UTC") }))
        val id=ContentUris.parseId(created)
        try {
            ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("addCalendar",true)).use { scenario->
                until("actual CalendarProvider picker"){text(label)};scenario.onActivity { picture(it,"p31-real-generated-calendar-picker-dark") };click(label)
                until("selected generated calendar scope"){main { visible().any { it.tag=="calendar-description" } }}
                main { (visible().single { it.tag=="calendar-description" } as EditText).setText("Generated calendar scope, no event collection");visible().filterIsInstance<CheckBox>().single { it.text.toString()=="允许读取并按所选策略发送这个来源" }.isChecked=false }
                settledFrames(scenario);main { visible().filterIsInstance<CheckBox>().forEach { it.jumpDrawablesToCurrentState() } };scenario.onActivity { assertFalse(visible().filterIsInstance<CheckBox>().single { view->view.text.toString()=="允许读取并按所选策略发送这个来源" }.isChecked);picture(it,"p31-selected-calendar-scope-dark") };click("保存来源设置")
                until("exact chosen calendar saved"){context.localSources().sources().any { it.calendarId==id&&it.description=="Generated calendar scope, no event collection"&&!it.enabled }}
            }
            val source=context.localSources().sources().single { it.calendarId==id }
            ActivityScenario.launch<SourcesActivity>(Intent(context,SourcesActivity::class.java).putExtra("sourceId",source.id)).use { scenario->
                until("reopened source settings"){main { visible().any { it.tag=="calendar-description" } }};main { (visible().single { it.tag=="calendar-description" } as EditText).setText("Generated cancelled edit") };click("取消");assertEquals(source,context.localSources().sources().single { it.id==source.id });until("actual source refresh complete"){main { WindowInspector.getGlobalWindowViews().filter { it.isShown&&it.hasWindowFocus() }.all(GeneratedWindowRendering::hasNoPendingLabels) }};settledFrames(scenario);scenario.onActivity { picture(it,"p31-cancel-keeps-exact-calendar-dark") }
            }
        } finally { context.localSources().sources().filter { it.calendarId==id }.forEach { context.localSources().remove(it.id) };context.contentResolver.delete(uri.buildUpon().appendPath(id.toString()).build(),null,null) }
        assertEquals(0,context.queue().inventory().records)
    }
    private fun picker(action:String,file:File,block:()->Unit){val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult?=if(intent.action==action)Instrumentation.ActivityResult(Activity.RESULT_OK,Intent().setData(FileProvider.getUriForFile(context,"${context.packageName}.record-files",file)))else null};instrumentation.addMonitor(monitor);try{block()}finally{instrumentation.removeMonitor(monitor)}}
    @Test fun anotherCentralZipIsRejectedBeforeRestoreAndLocalMetadataExportKeepsOriginals() = fixture { root->
        val id=UUID.randomUUID().toString();val event=JSONObject().put("id",id).put("source","note").put("capturedAt","2026-10-29T01:00:00Z").put("durationMs",0).put("ocrText","Generated final backup note").put("privacy",JSONObject().put("excluded",false).put("redacted",false).put("mode","none"))
        context.queue().enqueue(event,null,16_000_000)
        try {
            val plain=object:ByteCipher{override fun seal(bytes:ByteArray)=bytes;override fun open(bytes:ByteArray)=bytes};val source=DurableQueue(File(root,"isolated-archive"),plain);source.enqueue(event,null,16_000_000)
            val zip=File(root,"other-central.zip");zip.outputStream().use { QueueArchive.export(source,"http://127.0.0.1:59998",it) };val before=context.queue().inventory()
            ActivityScenario.launch<BackupActivity>(Intent(context,BackupActivity::class.java)).use { scenario->
                tag("backup-restore-records");picker(Intent.ACTION_OPEN_DOCUMENT,zip){click("选择备份文件");until("another node ZIP rejected"){text("备份属于不同中央")}}
                assertFalse(text("导入到此手机"));assertEquals(before,context.queue().inventory());scenario.onActivity { picture(it,"p36-another-central-valid-zip-rejected-dark") };click("返回")
                tag("backup-scope");val output=File(root,"metadata.json")
                picker(Intent.ACTION_CREATE_DOCUMENT,output){click("导出本机元数据 JSON");until("real metadata JSON write"){text("导出文件已生成")}}
                val metadata=JSONObject(output.readText());assertEquals("mote-local-metadata",metadata.getString("format"));assertEquals(1,metadata.getInt("version"));assertEquals(id,metadata.getJSONArray("records").getJSONObject(0).getString("id"));assertEquals(before,context.queue().inventory());scenario.onActivity { picture(it,"p37-local-metadata-json-success-dark") };click("完成")
                val bad=File(root,"generated-unwritable-directory").apply { mkdirs() };picker(Intent.ACTION_CREATE_DOCUMENT,bad){click("导出本机元数据 JSON");until("actual provider write fails"){text("备份未能生成")}}
                assertEquals(before,context.queue().inventory());assertNotNull(context.queue().capture(id));scenario.onActivity { picture(it,"p37-local-metadata-json-write-failure-dark") };click("返回")
            }
        } finally { context.queue().acknowledge(id) }
    }
    @Test fun actualNotificationAndUsageGrantReturnNeverStartsCollection() = fixture {
        val appOps=requireNotNull(context.getSystemService(android.app.AppOpsManager::class.java));require(appOps.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,android.os.Process.myUid(),context.packageName)!=android.app.AppOpsManager.MODE_ALLOWED) { "Generated usage grant must start absent" }
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","PERMISSIONS")).awaitMainUi().use { scenario->
            until("permission statuses ready"){!text("正在检查系统权限…")}
            click("通知提醒：显示运行通知")
            until("real notification permission"){nodes(instrumentation.uiAutomation.rootInActiveWindow).any { it.viewIdResourceName?.endsWith(":id/permission_allow_button")==true }}
            systemPicture("p27-notification-permission-system")
            systemClick("allow notification on generated profile"){it.viewIdResourceName?.endsWith(":id/permission_allow_button")==true}
            until("notification permission granted"){context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED}
            assertFalse(Settings(context).enabled);assertEquals(0,context.queue().inventory().records);scenario.onActivity { picture(it,"p27-notification-granted-return-dark") }
            click("使用情况访问")
            val name=context.applicationInfo.loadLabel(context.packageManager).toString()
            systemClick("generated app usage row"){it.text?.toString()==name}
            until("actual generated usage detail"){nodes(instrumentation.uiAutomation.rootInActiveWindow).any { it.text?.toString()=="Permit access to app usage data" }}
            systemPicture("p27-usage-app-settings-system")
            systemClick("generated usage access switch"){it.packageName?.toString()=="com.android.settings"&&it.isCheckable&&!it.isChecked}
            until("usage AppOp granted"){val op=requireNotNull(context.getSystemService(android.app.AppOpsManager::class.java));op.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,android.os.Process.myUid(),context.packageName)==android.app.AppOpsManager.MODE_ALLOWED}
            assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
            until("actual OS usage list returned"){val rows=nodes(instrumentation.uiAutomation.rootInActiveWindow);rows.any { it.text?.toString()==name }&&rows.none { it.isCheckable||it.text?.toString()=="Permit access to app usage data" }}
            assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
            until("returned to app permissions"){text("通知提醒：显示运行通知")};assertFalse(Settings(context).enabled);assertEquals(0,context.queue().inventory().records);scenario.onActivity { picture(it,"p27-usage-granted-return-dark") }
        }
    }
    @Test fun disconnectedAndActualEmptyCentralPagesRemainReadableWithoutModelWork() = fixture {
        CentralSession.get(context).select("")
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","materials")).use { scenario->
            until("unconnected Central form"){text("连接中央")||text("中央地址")};scenario.onActivity { assertNull(it.client);picture(it,"p11-central-unconnected-dark") }
        }
        val origin=requireNotNull(InstrumentationRegistry.getArguments().getString("remainingEmptyOrigin"));require(Regex("http://127\\.0\\.0\\.1:[0-9]+").matches(origin))
        val session=CentralSession.get(context);ConnectionGuard.change(context,origin,bindLocal=true){Settings(context).saveConnection(origin,"generated-remaining-empty-owner-token-20261030","Generated empty Central",true)};session.select(origin)
        try { for(page in listOf("materials","memories"))ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page",page)).use { scenario->
            until("actual empty $page owner page"){var ready=false;scenario.onActivity { ready=it.client!=null&&!it.isWorking&&views(it.window.decorView).filterIsInstance<TextView>().any { view->view.isShown&&view.text.toString().contains(if(page=="memories")"当前筛选下没有匹配的记忆" else "当前范围内暂无条目") } };ready}
            if(page=="memories")main { assertFalse("Default memory browse must not expose management",visible().any { it is android.widget.Spinner&&it.contentDescription=="浏览维度" });assertFalse(visible().filterIsInstance<TextView>().any { it.text.toString()=="记忆设置" });assertTrue(visible().filterIsInstance<TextView>().any { it.text.toString()=="手动提取记忆" }) }
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){
                main { MoteAppearance.select(context,theme) };settledFrames(scenario)
                scenario.onActivity { picture(it,"p11-empty-$page-${theme.value}") }
            }
            scenario.onActivity { val marker=views(it.window.decorView).filterIsInstance<TextView>().single { view->view.text.toString().contains(if(page=="memories")"当前筛选下没有匹配的记忆" else "当前范围内暂无条目") };marker.requestRectangleOnScreen(android.graphics.Rect(0,0,marker.width,marker.height),true) };settledFrames(scenario)
            scenario.onActivity { a->val marker=views(a.window.decorView).filterIsInstance<TextView>().single { view->view.text.toString().contains(if(page=="memories")"当前筛选下没有匹配的记忆" else "当前范围内暂无条目") };val actual=android.graphics.Rect();assertTrue(marker.getGlobalVisibleRect(actual));assertEquals("Empty-state text must actually be visible in its evidence",marker.height,actual.height());picture(a,"p11-empty-$page-message-dark") }
            if(page=="memories"){
                click("更多  ›");until("actual More exposes existing memory management"){main { visible().any { it is android.widget.Spinner&&it.contentDescription=="浏览维度" } }}
                scenario.onActivity { picture(it,"p11-memory-management-more-dark") };click("更多  ›")
                main { assertFalse(visible().any { it is android.widget.Spinner&&it.contentDescription=="浏览维度" }) }
                click("手动提取记忆");until("existing memory jobs entry"){text("开始提取")};scenario.onActivity { picture(it,"p11-existing-extraction-entry-dark") }
                click("返回上级");until("return to concise same memory page"){text("手动提取记忆")&&text("当前筛选下没有匹配的记忆")}
                settledFrames(scenario);scenario.onActivity { a->val header=views(a.window.decorView).single { it.tag=="central-title" };val bounds=android.graphics.Rect();assertTrue(header.getGlobalVisibleRect(bounds));picture(a,"p11-memory-return-dark") }
            }
            assertEquals(0,context.queue().inventory().records)
        } } finally { session.select("") }
    }
    @Test fun localLibraryTabsKeepRealLocationsOriginalAndMemoryHandoff() = fixture {
        val id=UUID.randomUUID().toString();val original="Generated exact local library original"
        val event=JSONObject().put("id",id).put("source","note").put("appName","Generated library note").put("capturedAt","2026-10-29T12:00:00Z").put("durationMs",0).put("ocrText",original).put("privacy",JSONObject().put("excluded",false).put("redacted",false).put("mode","none"))
        context.queue().enqueue(event,null,16_000_000)
        try { ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","LIBRARY")).awaitMainUi().use { scenario->
            until("real local library row"){main{visible().any{it.tag=="library-record:"+id}}}
            main{assertTrue(visible().single{it.tag=="library-locations:local"}.isSelected);assertTrue(visible().single{it.tag=="library-primary-views:materials"}.isSelected);assertTrue(visible().single{it.tag=="library-primary-views:materials"} is TextView);assertFalse(visible().single{it.tag=="library-primary-views:materials"} is android.widget.Button)}
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){main{MoteAppearance.select(context,theme)};settledFrames(scenario);scenario.onActivity{picture(it,"gap-library-local-"+theme.value)}}
            tag("library-locations:central");main{assertTrue(visible().single{it.tag=="library-locations:central"}.isSelected);assertFalse(visible().any{it.tag=="library-record:"+id})};scenario.onActivity{picture(it,"gap-library-central-unavailable-dark")}
            tag("library-locations:local");until("same local original remains"){main{visible().any{it.tag=="library-record:"+id}}};tag("library-record:"+id)
            until("exact local record reader"){main{androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).any{it is CaptureRecordsActivity}&&visible().filterIsInstance<TextView>().any{it.text.toString().contains(original)}}}
            main{val a=androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).single();assertTrue(a is CaptureRecordsActivity);picture(a,"gap-library-exact-original-dark")};click("返回上一页")
            until("same location on return"){main{visible().any{it.tag=="library-locations:local"&&it.isSelected}}}
            tag("library-primary-views:memories");until("source memory handoff"){text("查看中心整理的记忆。")};scenario.onActivity{picture(it,"gap-library-memory-handoff-dark")}
            scenario.recreate();scenario.awaitMainUi();until("same memory tab after recreation"){main{visible().any{it.tag=="library-primary-views:memories"&&it.isSelected}}};click("查看我的记忆 ↗")
            until("existing Central memory route"){main{androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).any{it is CentralActivity&&it.intent.getStringExtra("page")=="memories"}}}
            main{androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).single{it is CentralActivity}.finish()}
            until("return to same handoff"){text("查看中心整理的记忆。")};assertNotNull(context.queue().capture(id));assertFalse(Settings(context).enabled)
        }}finally{context.queue().acknowledge(id)}
    }
    @Test fun processingAndDiagnosticsKeepRealAdvancedDraftsAndVisibleRange() = fixture {
        val settings=Settings(context);settings.save(settings.read().copy(imageDedupeMode="aggressive",captureMaxSide=1920),confirmCentralEndpoint=true)
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","PROCESSING")).awaitMainUi().use{scenario->
            main{assertFalse(visible().any{it.tag=="图片最长边 / px"});assertFalse(visible().any{it.tag=="imageDedupeMode"});assertTrue(visible().filterIsInstance<TextView>().any{it.text.toString().contains("近似画面 · 激进")})}
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){main{MoteAppearance.select(context,theme)};settledFrames(scenario);scenario.onActivity{picture(it,"gap-processing-default-"+theme.value)}}
            tag("image-dedupe-choice");click("近似画面");until("explicit native preset choice"){text("选择近似画面档位")};click("取消")
            assertEquals("aggressive",settings.read().imageDedupeMode)
            until("JPEG returns after picker cancellation"){main{visible().any{it.tag=="JPEG 质量"}}}
            main{val number=visible().single{it.tag=="JPEG 质量"} as EditText;assertNotNull(number.keyListener);assertTrue(number.isFocusableInTouchMode);number.requestFocus();assertTrue(number.hasFocus())}
            tag("image-processing-advanced")
            main{val root=visible();assertEquals("1920",(root.single{it.tag=="图片最长边 / px"} as EditText).text.toString());assertEquals(4,(root.single{it.tag=="imageDedupeMode"} as android.widget.Spinner).selectedItemPosition);(root.single{it.tag=="JPEG 质量"} as EditText).setText("81");(root.single{it.tag=="临时保留图片去重对比记录"} as CheckBox).isChecked=true;(root.single{it.tag=="imageDedupeMode"} as android.widget.Spinner).setSelection(1)}
            assertEquals("aggressive",settings.read().imageDedupeMode)
            for(language in listOf("en","zh-CN")){
                main{MoteI18n.select(context,language)};scenario.recreate();scenario.awaitMainUi();tag("image-processing-advanced")
                main{assertEquals("81",(visible().single{it.tag==MoteI18n.text("JPEG 质量")} as EditText).text.toString());assertTrue((visible().single{it.tag==MoteI18n.text("临时保留图片去重对比记录")} as CheckBox).isChecked);assertEquals("1920",(visible().single{it.tag==MoteI18n.text("图片最长边 / px")} as EditText).text.toString());assertEquals(1,(visible().single{it.tag=="imageDedupeMode"} as android.widget.Spinner).selectedItemPosition)}
                scenario.onActivity{picture(it,"gap-processing-language-$language")}
            }
            main{assertEquals("81",(visible().single{it.tag=="JPEG 质量"} as EditText).text.toString());assertEquals(1,(visible().single{it.tag=="imageDedupeMode"} as android.widget.Spinner).selectedItemPosition);assertEquals("1920",(visible().single{it.tag=="图片最长边 / px"} as EditText).text.toString())}
            click("保存设置");until("actual explicit processing save"){settings.read().jpegQuality==81&&settings.read().imageDedupeMode=="exact"&&settings.read().captureMaxSide==1920};assertFalse(settings.enabled)
        }
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","DIAGNOSTICS")).awaitMainUi().use{scenario->
            main{assertFalse(visible().any{it.tag=="诊断采样间隔 / 秒（15–3600）"});assertTrue(visible().filterIsInstance<TextView>().any{it.text.toString().contains("数值诊断导出保留的全部数值")})}
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){main{MoteAppearance.select(context,theme)};settledFrames(scenario);scenario.onActivity{picture(it,"gap-diagnostics-default-"+theme.value)}}
            tag("diagnostic-export-range");click("最近 7 天");until("actual selected range visible"){main{visible().filterIsInstance<TextView>().any{it.tag=="diagnostic-export-range"&&it.text.toString().contains("最近 7 天")}}}
            tag("diagnostic-details");main{(visible().single{it.tag=="诊断采样间隔 / 秒（15–3600）"} as EditText).setText("123")};scenario.recreate();scenario.awaitMainUi()
            main{assertTrue(visible().filterIsInstance<TextView>().single{it.tag=="diagnostic-export-range"}.text.toString().contains("最近 7 天"));assertFalse(visible().any{it.tag=="诊断采样间隔 / 秒（15–3600）"})};tag("diagnostic-details")
            for(language in listOf("en","zh-CN")){
                main{MoteI18n.select(context,language)};scenario.recreate();scenario.awaitMainUi();tag("diagnostic-details")
                main{assertEquals("123",(visible().single{it.tag==MoteI18n.text("诊断采样间隔 / 秒（15–3600）")} as EditText).text.toString());assertTrue(visible().filterIsInstance<TextView>().single{it.tag=="diagnostic-export-range"}.text.toString().contains(MoteI18n.text("最近 7 天")))}
            }
            main{assertEquals("123",(visible().single{it.tag=="诊断采样间隔 / 秒（15–3600）"} as EditText).text.toString())};assertEquals(60,settings.read().diagnosticsIntervalSeconds)
            scenario.onActivity{picture(it,"gap-diagnostics-advanced-draft-dark")};assertFalse(settings.enabled)
        }
    }
    @Test fun calendarAndTodoTabsReuseActualConsumerKeepDraftAndWithdrawOldSession() = fixture {
        val origin=requireNotNull(InstrumentationRegistry.getArguments().getString("remainingEmptyOrigin"));val token="generated-remaining-empty-owner-token-20261030"
        ConnectionGuard.change(context,origin,bindLocal=true){Settings(context).saveConnection(origin,token,"Generated action tabs",true)}
        try{ActivityScenario.launch<CalendarActionsActivity>(Intent(context,CalendarActionsActivity::class.java)).use{scenario->
            until("real calendar empty default"){text("尚未发现日程。")};main{assertTrue(visible().single{it.tag=="action-tabs:calendar"}.isSelected);assertFalse(visible().filterIsInstance<TextView>().any{it.text.toString()=="连接本机日历"})}
            for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){main{MoteAppearance.select(context,theme)};settledFrames(scenario);scenario.onActivity{picture(it,"gap-actions-calendar-"+theme.value)}}
            tag("action-tabs:todos");until("actual existing Todo consumer"){main{visible().any{it.tag=="todo-title"&&it.isEnabled}}};main{(visible().single{it.tag=="todo-title"} as EditText).setText("Generated retained Todo draft")}
            tag("action-tabs:calendar");tag("action-tabs:todos");until("same-owner tab draft retained"){main{visible().filterIsInstance<EditText>().any{it.tag=="todo-title"&&it.text.toString()=="Generated retained Todo draft"}}}
            scenario.recreate();until("same-owner recreated Todo draft"){main{visible().filterIsInstance<EditText>().any{it.tag=="todo-title"&&it.text.toString()=="Generated retained Todo draft"}}};scenario.onActivity{picture(it,"gap-actions-todo-draft-dark")}
            click("添加待办");val api=CentralClient(origin,token);until("real owner Todo saved"){val rows=api.get("/api/todos?limit=30").getJSONArray("items");(0 until rows.length()).any{rows.getJSONObject(it).getString("title")=="Generated retained Todo draft"}}
            until("Todo consumer refresh complete"){main{visible().filterIsInstance<EditText>().any{it.tag=="todo-title"&&it.text.isEmpty()}}};main{(visible().single{it.tag=="todo-title"} as EditText).setText("Generated former session private draft")};tag("action-tabs:calendar");Settings(context).signOut();tag("action-tabs:todos")
            until("new session removes previous draft before display"){main{visible().none{it is EditText&&it.text.toString()=="Generated former session private draft"}&&visible().none{it.tag=="todo-title"}&&visible().filterIsInstance<TextView>().any{it.text.toString()=="登录并继续"}}};scenario.onActivity{picture(it,"gap-actions-session-withdrawn-dark")};assertFalse(Settings(context).enabled)
        }}finally{CentralSession.get(context).select("")}
    }

    @Test fun calendarOwnerChangeWithdrawsOldCardsDialogsAndLateReads() = fixture {
        val listener=java.net.ServerSocket(0,10,java.net.InetAddress.getByName("127.0.0.1"))
        val origin="http://127.0.0.1:${listener.localPort}";val workers=java.util.concurrent.Executors.newCachedThreadPool()
        val reads=java.util.concurrent.atomic.AtomicInteger();val writes=java.util.concurrent.atomic.AtomicInteger()
        val held=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
        val tokenA="generated-calendar-owner-A-20261030";val tokenB="generated-calendar-owner-B-20261030"
        val secret="Generated former-owner calendar title";val actionId=UUID.randomUUID().toString()
        workers.submit{while(!listener.isClosed)runCatching{listener.accept()}.getOrNull()?.let{socket->workers.submit{socket.use{
            val input=it.getInputStream().bufferedReader();val first=input.readLine().orEmpty();val headers=mutableListOf<String>();while(true){val line=input.readLine();if(line.isNullOrEmpty())break;headers.add(line)}
            val path=first.split(' ').getOrElse(1){""};val a=headers.any{h->h.equals("Authorization: Bearer $tokenA",true)}
            if(!first.startsWith("GET "))writes.incrementAndGet()
            val nth=if(a&&path.startsWith("/api/actions?"))reads.incrementAndGet()else 0
            if(nth==3){held.countDown();check(release.await(20,java.util.concurrent.TimeUnit.SECONDS))}
            val event=JSONObject().put("title",secret).put("start","2026-11-01T10:00:00Z").put("end","2026-11-01T11:00:00Z").put("timeZone","UTC").put("location","")
            val item=JSONObject().put("id",actionId).put("version",1).put("kind","calendar.cancel").put("status","proposed").put("event",event).put("evidence",JSONArray())
            val body=(if(a&&path.startsWith("/api/actions?"))JSONObject().put("items",JSONArray().put(item)).put("targets",JSONArray()).put("nextCursor",123)else if(path.startsWith("/api/actions?"))JSONObject().put("error","forbidden")else JSONObject().put("items",JSONArray())).toString().toByteArray()
            val status=if(!a&&path.startsWith("/api/actions?"))"403 Forbidden"else"200 OK"
            it.getOutputStream().apply{write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray());write(body);flush()}
        }}}}
        val settings=Settings(context)
        try{
            until("generated fixture connection change reaches the existing idle boundary"){try{ConnectionGuard.change(context,origin,bindLocal=true){settings.saveConnection(origin,tokenA,"Generated owner calendar guard",true)};true}catch(error:ConnectionFailure){if(error.category!="busy")throw error;false}}
            ActivityScenario.launch<CalendarActionsActivity>(Intent(context,CalendarActionsActivity::class.java)).use{scenario->
                until("A real native card read from controlled HTTP"){text(secret)};click("核对变更");until("owned confirmation dialog"){text("确认变更")}
                val oldPositive=main{visible().filterIsInstance<android.widget.Button>().single{it.text.toString()=="确认变更"}}
                settings.signIn(origin,tokenB,86400000);scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                until("B denied never shows A card"){!text(secret)&&text("当前连接没有执行此操作的权限")}
                main{oldPositive.performClick()};assertEquals("Old dialog must never write under B",0,writes.get());scenario.onActivity{picture(it,"gap-actions-owner-denied-withdrawn-dark")}
                settings.signIn(origin,tokenA,86400000);tag("action-tabs:todos");tag("action-tabs:calendar")
                assertTrue("Explicitly held old A read",held.await(10,java.util.concurrent.TimeUnit.SECONDS))
                tag("action-tabs:todos");settings.signIn(origin,tokenB,86400000);tag("action-tabs:calendar")
                assertFalse("Old A card withdrawn synchronously",text(secret));release.countDown()
                until("B failure remains after A late response"){!text(secret)&&text("当前连接没有执行此操作的权限")}
                scenario.onActivity{picture(it,"gap-actions-owner-late-read-rejected-dark")};assertEquals(0,writes.get());assertFalse(settings.enabled)
            }
        }finally{release.countDown();listener.close();workers.shutdownNow();CentralSession.get(context).select("")}
    }

}
