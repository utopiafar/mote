package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Prevents relocation cancellation or failed copies from losing generated originals or private state. */
class StorageJourneyInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private val output get()=File(context.filesDir,"storage-final").apply{mkdirs()}
    private fun <T> main(action:()->T):T { val value=AtomicReference<Result<T>>();instrumentation.runOnMainSync{value.set(runCatching(action))};return value.get().getOrThrow() }
    private fun views(root:View):List<View> = listOf(root)+if(root is ViewGroup)(0 until root.childCount).flatMap{views(root.getChildAt(it))}else emptyList()
    private fun shown()=android.view.inspector.WindowInspector.getGlobalWindowViews().filter{it.isShown && it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+30_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(50)};fail(label)}
    private fun click(label:String,predicate:(View)->Boolean){until(label){main{shown().any{it.isEnabled && it.isClickable && predicate(it)}}};main{shown().first{it.isEnabled && it.isClickable && predicate(it)}.apply{requestRectangleOnScreen(android.graphics.Rect(0,0,width,height),true);assertTrue(performClick())}}}
    private fun clickText(label:String)=click(label){it is TextView && it.text.toString()==label}
    private fun clickTag(tag:String)=click(tag){it.tag==tag}
    private fun labels()=main{shown().filterIsInstance<TextView>().map{it.text.toString()}}
    private fun capture(s:ActivityScenario<StorageActivity>,name:String){val before=MoteAppearance.preference();try{for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)){
        main{MoteAppearance.select(context,theme)};instrumentation.waitForIdleSync();val frame=CountDownLatch(1);s.onActivity{a->a.window.decorView.postOnAnimation{a.window.decorView.postOnAnimation{frame.countDown()}}};assertTrue(frame.await(5,TimeUnit.SECONDS))
        until("App-owned focused screenshot window"){main{android.view.inspector.WindowInspector.getGlobalWindowViews().any{it.isShown && it.hasWindowFocus()}}}
        main{if(name=="migration-draining-no-fake-cancel")assertEquals(MoteUi.ink,(shown().single{it.tag=="storage-migration-progress"} as TextView).currentTextColor);val root=android.view.inspector.WindowInspector.getGlobalWindowViews().last{it.isShown && it.hasWindowFocus()};val bitmap=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);try{root.draw(Canvas(bitmap));output.resolve(name+"-"+theme.value+".png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{bitmap.recycle()}}
    }}finally{main{MoteAppearance.select(context,before)}}}
    private fun dataFiles(location:QueueLocation)=File(location.path).listFiles()!!.filter{it.extension in setOf("event","blob")}.associate{it.name to it.readBytes().toList()}
    private fun targets(choice:QueueStorageChoice)=choice.base.listFiles().orEmpty().filter{it.isDirectory && it.name.startsWith("mote-queue-")}.map{it.name}.toSet()
    private fun apply(change:()->Unit):Result<RuntimeSettings.Applied>{val done=CountDownLatch(1);val result=AtomicReference<Result<RuntimeSettings.Applied>>();main{RuntimeSettings.apply(context,Settings(context).read(),change=change){result.set(it);done.countDown()}};assertTrue(done.await(30,TimeUnit.SECONDS));return result.get()}
    @Test fun actualLocationCancellationCopyVerificationRollbackAndReturnPreserveCurrentPrivateState(){
        assumeTrue(InstrumentationRegistry.getArguments().getString("secondaryUiFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected && context.queue().depth()==0)
        WorkManager.getInstance(context).cancelAllWork().result.get(20,TimeUnit.SECONDS)
        MoteI18n.select(context,"zh-CN");val originalConfig=settings.read();val storage=QueueStorage(context);val initial=storage.current();require(initial.baseId=="internal")
        val target=storage.choices().first{it.id!="internal"};val previousTargets=targets(target);val generated=mutableListOf<String>()
        val draft=context.recordDraftStore();require(draft.draft().getString("text").isBlank() && draft.draft().getJSONArray("attachments").length()==0)
        val attachmentBytes="Generated private draft attachment, never a migration credential".toByteArray();val attachment=draft.stage(attachmentBytes,"generated-storage.txt","text/plain")
        draft.edit("Generated retained migration draft",JSONArray().put(attachment),JSONObject().put("kind","manual"),"Generated independent migration description")
        val draftBefore=draft.draft().toString();val draftFiles=File(context.noBackupFilesDir,"record-draft").listFiles()!!.associate{it.name to it.readBytes().toList()}
        val key=DevCredentialFormat.keyFile(context.noBackupFilesDir);val keyBytes=key.readBytes();val secret=context.secretBox();val privateProbe="Generated secret readability probe".toByteArray();val sealed=secret.seal(privateProbe)
        fun assertPrivate(){assertArrayEquals(keyBytes,key.readBytes());assertArrayEquals(privateProbe,context.secretBox().open(sealed));assertEquals(draftBefore,draft.draft().toString());assertArrayEquals(attachmentBytes,draft.bytes(attachment.getString("id")));assertEquals(draftFiles,File(context.noBackupFilesDir,"record-draft").listFiles()!!.associate{it.name to it.readBytes().toList()});assertEquals(originalConfig,settings.read());assertFalse(settings.enabled);assertTrue(File(context.noBackupFilesDir,".mote-local-format").readText()==LocalDataFormat.VERSION.toString());assertEquals("1",File(context.noBackupFilesDir,".mote-dev-file-credentials").readText())}
        val bitmap=Bitmap.createBitmap(24,24,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.CYAN)};val image=try{ByteArrayOutputStream().also{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}.toByteArray()}finally{bitmap.recycle()}
        fun event(source:String)=JSONObject().put("id",UUID.randomUUID().toString()).put("deviceId",settings.deviceId).put("source",source).put("capturedAt","2026-10-29T01:38:00Z").put("privacy",JSONObject().put("excluded",false)).apply{if(source=="screen"){put("imageMime","image/png");put("ocr",JSONObject().put("status","completed"))};put("ocrText","Generated P38 original "+source)}
        val screen=event("screen");val note=event("note");listOf(screen,note).forEach{generated.add(it.getString("id"))};context.queue().enqueue(screen,image);context.queue().enqueue(note,null)
        val originals=dataFiles(initial);val stale=context.queue()
        try {
            ActivityScenario.launch(StorageActivity::class.java).use{s->
                until("Actual system-owned storage choices"){main{shown().any{it.tag=="storage-choice:"+target.id && it.isEnabled}}};capture(s,"location-before")
                clickTag("storage-choice:"+target.id);until("Migration confirmation"){labels().contains("迁移本机保存位置")};capture(s,"migration-confirm");clickText("取消")
                assertEquals(initial,storage.current());assertEquals(originals,dataFiles(initial));assertEquals(previousTargets,targets(target));assertFalse(File(context.noBackupFilesDir,"queue-migration.json").exists());assertPrivate();capture(s,"migration-cancelled-original-kept")
                // Model one actual in-flight producer at RuntimeSettings' existing drain boundary.
                ConnectionGuard.processing.incrementAndGet()
                try{clickTag("storage-choice:"+target.id);clickText("迁移并应用");until("Real migration drains the existing producer"){labels().any{it.contains("正在等待后台处理结束")}};assertFalse(main{shown().any{it is TextView && it.text.toString()=="取消" && it.isEnabled}});capture(s,"migration-draining-no-fake-cancel")}
                finally{ConnectionGuard.processing.decrementAndGet()}
                until("Actual copy commits the chosen target"){storage.current().baseId==target.id && !ConnectionGuard.reconfiguring()}
                val moved=storage.current();assertEquals(originals,dataFiles(moved));assertArrayEquals(image,context.queue().image(screen.getString("id")));context.queue().verifyIntegrity();assertFalse(File(initial.path).exists());assertFalse(File(context.noBackupFilesDir,"queue-migration.json").exists());assertFalse(File(moved.path,"dev-secrets").exists());assertFalse(File(moved.path,"record-draft").exists());assertPrivate()
                assertThrows(IllegalStateException::class.java){stale.peek()}
                until("Current target UI restored"){main{shown().any{it.tag=="storage-choice:internal" && it.isEnabled}}};clickTag("storage-current-path");until("Actual target path disclosed"){labels().contains(moved.path)};capture(s,"migration-committed-target")
                s.recreate();until("Recreated selected target"){main{shown().any{it.tag=="storage-choice:internal" && it.isEnabled}}};clickTag("storage-current-path");until("Recreated actual target path"){labels().contains(moved.path)};capture(s,"migration-target-recreated")
                clickTag("storage-choice:internal");clickText("迁移并应用");until("Copy back into allowed internal application space"){storage.current().baseId=="internal" && !ConnectionGuard.reconfiguring()};assertEquals(originals,dataFiles(storage.current()));assertFalse(File(moved.path).exists());assertPrivate()
            }
            // A real unsupported directory makes the production UI copy fail after the target journal is created.
            val current=storage.current();val bad=File(current.path,"generated-unsupported-entry");check(bad.mkdir())
            try{ActivityScenario.launch(StorageActivity::class.java).use{s->until("Failure target choice"){main{shown().any{it.tag=="storage-choice:"+target.id && it.isEnabled}}};clickTag("storage-choice:"+target.id);clickText("迁移并应用");until("Actual copy failure dialog"){labels().contains("迁移未完成")};capture(s,"copy-failed-original-preserved");assertEquals(current,storage.selected());assertEquals(originals,dataFiles(current));assertEquals(previousTargets,targets(target));assertFalse(File(context.noBackupFilesDir,"queue-migration.json").exists());assertPrivate();clickText("关闭")}}
            finally{check(bad.delete())}
            // Exercise the actual target checksum guard through the existing domain progress callback.
            // Only a generated target blob is altered; no physical-unplug claim or product hook.
            var corrupted=false
            val beforeChecksum=storage.current();val result=apply{
                val store=QueueLocationStore(context.noBackupFilesDir,File(context.noBackupFilesDir,"queue"),context.localContentCipher(),syncDirectory={directory->val fd=android.system.Os.open(directory.path,android.system.OsConstants.O_RDONLY,0);try{android.system.Os.fsync(fd)}finally{android.system.Os.close(fd)}})
                store.migrate(target.id,target.base){message->RuntimeSettings.reportProgress(message);if(message==MoteI18n.text("正在验证目标记录与图片")){
                    val journal=JSONObject(File(context.noBackupFilesDir,"queue-migration.json").readText());val path=File(journal.getJSONObject("target").getString("path"));check(path.parentFile!!.canonicalFile==target.base.canonicalFile)
                    val blob=path.listFiles()!!.single{it.extension=="blob"};val bytes=blob.readBytes();bytes[bytes.lastIndex]=(bytes.last().toInt() xor 1).toByte();blob.writeBytes(bytes);corrupted=true
                }}
            }
            assertTrue(corrupted);assertTrue(result.isFailure);assertTrue(result.exceptionOrNull()!!.message!!.contains("校验失败"));assertEquals(beforeChecksum,storage.current());assertEquals(originals,dataFiles(beforeChecksum));assertEquals(previousTargets,targets(target));assertFalse(File(context.noBackupFilesDir,"queue-migration.json").exists());context.queue().verifyIntegrity();assertPrivate()
            ActivityScenario.launch(StorageActivity::class.java).use{s->until("Original storage remains after checksum rollback"){main{shown().any{it.tag=="storage-choice:"+target.id && it.isEnabled}}};clickTag("storage-current-path");until("Original path after checksum rollback"){labels().contains(beforeChecksum.path)};capture(s,"checksum-rollback-original-readable")}
            ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","STORAGE")).awaitMainUi().use{assertPrivate()}
            output.resolve("storage-result.json").writeText(JSONObject().put("generatedOnly",true).put("realAllowedAppExternalStorage",true).put("cancelPreserved",true).put("copiedOriginalFiles",originals.size).put("exactOriginalBytesVerified",true).put("copyFailureRolledBack",true).put("targetChecksumFaultInjectedViaDomainProgress",true).put("targetChecksumFailureRolledBack",true).put("targetCleanupVerified",true).put("currentSecretAndPrivateDraftRetainedInternally",true).put("physicalUnplugTested",false).toString(2))
        }finally{
            if(storage.current().baseId!="internal")apply{storage.migrate("internal")}.getOrThrow()
            generated.forEach{id->context.queue().dedupeRow(id)?.let{check(context.queue().resolveDedupe(id,it.optString("blob"),null,null,null))}}
            draft.edit("",JSONArray(),JSONObject().put("kind","manual"));File(context.noBackupFilesDir,"record-draft/"+attachment.getString("id")+".enc").delete()
            WorkManager.getInstance(context).cancelAllWork().result.get(20,TimeUnit.SECONDS)
        }
    }
}
