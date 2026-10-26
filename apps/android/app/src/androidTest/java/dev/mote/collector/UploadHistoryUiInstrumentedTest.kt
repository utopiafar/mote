package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.*
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Native views and durable SQLite with generated originals; no network/model. */
class UploadHistoryUiInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T { val result = AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }; return result.get().getOrThrow() }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun visible() = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun activityOrNull(): Activity? = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull { it.packageName == context.packageName }
    private fun activity(): Activity = requireNotNull(activityOrNull())
    private fun until(label: String, check: () -> Boolean) { val end = SystemClock.elapsedRealtime() + 15000; while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(100) }; fail(label) }
    private fun click(label: String, match: (View) -> Boolean) {
        until(label) { main { visible().any { it.isEnabled && it.isClickable && match(it) } } }
        main { visible().first { it.isEnabled && it.isClickable && match(it) }.let { it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true); assertTrue(it.performClick()) } }
    }
    private fun text(value: String) = main { visible().filterIsInstance<TextView>().any { it.text.toString().contains(value) } }
    @Test fun emptyHistoryDateBatchOriginalBackRecreationAndRetention() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("historyUiFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        ActivityScenario.launch<SyncQueueActivity>(Intent(context, SyncQueueActivity::class.java)).use { scenario ->
            click("history tab") { it.tag == "sync-history-tab" }
            until("empty history") { text(MoteI18n.text("暂无上传历史")) }
            val settings = Settings(context); val origin = settings.read().server
            assertTrue(origin.isNotBlank())
            val at = System.currentTimeMillis(); val event = JSONObject().put("id",UUID.randomUUID().toString()).put("deviceId",settings.deviceId)
                .put("source","note").put("capturedAt",java.time.Instant.ofEpochMilli(at).toString()).put("durationMs",0).put("ocrText","Generated history UI original").put("privacy",JSONObject().put("excluded",false))
            val batch = UUID.randomUUID().toString(); val store = context.captureUploadHistory()
            context.queue().enqueue(event,null,100000)
            val receipt = CaptureUploadReceipt.create(origin,settings.deviceId,event,event,batch,at,30)
            val attempt = CaptureUploadAttempt.create(batch,receipt.scope,LoginProcess.id,listOf(event),100,at)
            store.saveAttempt(attempt.copy(state="received",acknowledged=1,results=JSONObject().put(event.getString("id"),201)))
            CaptureReceiptFinalizer(store).received(context.queue(),receipt)
            val observed = JSONObject(event.toString()).put("id",UUID.randomUUID().toString()).put("source","activity").put("appId","generated.history").put("appName","Generated history").apply { remove("ocrText") }
                .put("durationMs",5000).put("privacy",JSONObject().put("excluded",false).put("collection","activity"))
                .put("metadata",JSONObject().put("version",1).put("state",JSONObject().put("idleSeconds",0)))
            context.queue().enqueue(observed,null,100000)
            val observedOriginal = context.queue().archiveRecord(observed.getString("id"))!!.first
            val observedReceipt = CaptureUploadReceipt.create(origin,settings.deviceId,observedOriginal,observedOriginal,batch,at,30)
            store.received(observedReceipt); store.completed(observedReceipt.itemKey)
            repeat(12) { n ->
                val pending = JSONObject(event.toString()).put("id",UUID.randomUUID().toString())
                store.saveAttempt(CaptureUploadAttempt.create(UUID.randomUUID().toString(),receipt.scope,LoginProcess.id,listOf(pending),100,at-1000-n).copy(state="unknown"))
            }
            click("refresh") { it is Button && it.text.toString()==MoteI18n.text("刷新") }
            click("expand date") { it.tag?.toString()?.startsWith("history-date-")==true }
            click("next whole batch page") { it is Button && it.text.toString()==MoteI18n.text("下一页") }
            until("later page excludes first batch") { main { visible().none { it.tag == "history-batch-$batch" } } }
            click("previous whole batch page") { it is Button && it.text.toString()==MoteI18n.text("上一页") }
            click("batch") { it.tag == "history-batch-$batch" }
            until("batch details") { text(MoteI18n.text("上传批次详情")) && text(MoteI18n.text("已确认 {0} · 未确认 {1}",2,0)) }
            click("original") { it.tag == "history-original-${event.getString("id")}" }
            until("original body") { text("Generated history UI original") }
            click("close original dialog") { it is Button && it.text.toString() == MoteI18n.text("关闭详情") }
            until("reader returned") { main { activityOrNull() is CaptureRecordsActivity } }
            main { activity().finish() }
            until("batch returned") { main { activityOrNull() is UploadBatchActivity } }
            val changed = JSONObject(observed.toString()).put("id",UUID.randomUUID().toString()).put("capturedAt",java.time.Instant.ofEpochMilli(at+5000).toString())
            changed.getJSONObject("metadata").getJSONObject("state").put("idleSeconds",5)
            context.queue().enqueue(changed,null,100000)
            assertEquals(2,context.queue().archiveRecord(observed.getString("id"))!!.first.getJSONObject("stateSeries").getJSONArray("samples").length())
            click("historical original after same-ID update") { it.tag == "history-original-${observed.getString("id")}" }
            until("historical version unavailable") { text(MoteI18n.text("历史版本不可用：本机原件已更新或清理，不能将当前内容作为这次上传的原文。")) }
            assertFalse(text(MoteI18n.text("相同状态合并为 {0} 次观察，最近一次：{1}。统计逐次使用实测时长，观察间隙不计为连续使用。",2,java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss").withZone(java.time.ZoneId.systemDefault()).format(java.time.Instant.ofEpochMilli(at+5000)))))
            main { activity().recreate() }
            until("historical version constraint restored") { text(MoteI18n.text("历史版本不可用：本机原件已更新或清理，不能将当前内容作为这次上传的原文。")) }
            assertFalse(text(MoteI18n.text("相同状态合并为 {0} 次观察，最近一次：{1}。统计逐次使用实测时长，观察间隙不计为连续使用。",2,java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss").withZone(java.time.ZoneId.systemDefault()).format(java.time.Instant.ofEpochMilli(at+5000)))))
            click("close unavailable original") { it is Button && it.text.toString() == MoteI18n.text("关闭详情") }
            main { activity().finish() }
            until("batch restored after unavailable original") { main { activityOrNull() is UploadBatchActivity } }
            main { activity().finish() }
            until("history returned") { main { activityOrNull() is SyncQueueActivity } }
            until("expanded date retained") { main { visible().any { it.tag == "history-batch-$batch" } } }
            val beforeScroll = main { val view = views(activity().window.decorView).filterIsInstance<ScrollView>().first(); view.scrollTo(0,240); view.scrollY }
            assertTrue(beforeScroll > 0)
            scenario.recreate()
            until("expanded date restored") { main { visible().any { it.tag == "history-batch-$batch" } } }
            until("scroll restored") { main { views(activity().window.decorView).filterIsInstance<ScrollView>().first().scrollY == beforeScroll } }
            main { (visible().single { it.tag == "history-result-filter" } as Spinner).setSelection(1) }
            until("result filter applied") { main { visible().count { it.tag?.toString()?.startsWith("history-batch-")==true } == 1 } }
            scenario.recreate()
            until("result filter restored") { main { visible().filterIsInstance<Spinner>().any { it.tag=="history-result-filter" && it.selectedItemPosition==1 } } }
            val database = File(context.noBackupFilesDir,"upload-history/received.sqlite")
            val backup = File(context.noBackupFilesDir,"upload-history/generated-recovery.sqlite")
            check(database.renameTo(backup)); check(database.mkdir())
            try {
                click("refresh unavailable history") { it is Button && it.text.toString()==MoteI18n.text("刷新") }
                until("history error visible") { text(MoteI18n.text("上传历史暂不可读取，请刷新重试。")) }
                assertNotNull(context.queue().capture(event.getString("id")))
            } finally { check(database.delete()); check(backup.renameTo(database)) }
            click("retry restored history") { it is Button && it.text.toString()==MoteI18n.text("刷新") }
            until("history recovered") { main { visible().any { it.tag == "history-batch-$batch" } } }
            main {
                val root = activity().window.decorView; val image = Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888); root.draw(Canvas(image))
                File(context.filesDir,"generated-history-ui.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }; image.recycle()
            }
            click("retention") { it is Button && it.text.toString()==MoteI18n.text("上传历史保存时长") }
            until("settings loaded") { main { visible().any { it.tag == "history-retention-save" && it.isEnabled } } }
            assertEquals(30,UploadHistoryRetention.read(context))
            main { (visible().single { it.tag == "history-retention-choice" } as Spinner).setSelection(0) }
            click("save duration") { it.tag == "history-retention-save" }
            until("duration persisted") { UploadHistoryRetention.read(context)==7 && text(MoteI18n.text("已保存")) }
            assertEquals("Generated history UI original",context.queue().capture(event.getString("id"))!!.getString("ocrText"))
            main { activity().finish() }
        }
    }
}
