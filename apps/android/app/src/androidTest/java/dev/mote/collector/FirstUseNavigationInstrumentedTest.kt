package dev.mote.collector

import android.app.Activity
import android.content.ClipboardManager
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
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Prevents first-use installation help from losing the first offline record or its exact reader return. */
@RunWith(AndroidJUnit4::class)
class FirstUseNavigationInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T { val result=AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }; return result.get().getOrThrow() }
    private fun views(root: View): List<View> = listOf(root)+if(root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun activity(): Activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single()
    private fun shown() = views(activity().window.decorView).filter { it.isShown }
    private fun until(label: String, check: () -> Boolean) { val end=SystemClock.elapsedRealtime()+20_000; while(SystemClock.elapsedRealtime()<end) { if(main { if(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).isEmpty()) false else check() }) return; Thread.sleep(50) }; fail(label+": "+main { shown().filterIsInstance<TextView>().joinToString(" | ") { it.text.toString() } }) }
    private fun View.named(label: String) = isEnabled && isClickable && (this is TextView && text.toString()==label || contentDescription?.toString()==label)
    private fun click(label: String) { until(label) { shown().any { it.named(label) } }; main { shown().first { it.named(label) }.performClick() } }
    private fun screenshot(name: String) {
        val frames=java.util.concurrent.CountDownLatch(1); main { activity().window.decorView.postOnAnimation { activity().window.decorView.postOnAnimation { frames.countDown() } } }; assertTrue(frames.await(5,java.util.concurrent.TimeUnit.SECONDS))
        main { val a=activity(); assertTrue(a.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0); val root=a.window.decorView
            assertTrue(GeneratedWindowRendering.hasNoPendingLabels(root)); val image=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888)
            try { root.draw(android.graphics.Canvas(image)); File(context.filesDir,"first-use-final").apply { mkdirs() }.resolve("$name.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } } finally { image.recycle() }
        }
    }
    @Test fun firstOfflineRecordSurvivesInstallHelpAndOpensItsSameLocalOriginal() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("uiFinalFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context); require(!settings.enabled && context.queue().depth()==0 && !settings.read().hasSyncConnection())
        settings.save(settings.read().copy(server="",token="",syncMode="manual"),confirmCentralEndpoint=true)
        MoteI18n.select(context,"zh-CN"); MoteAppearance.select(context,AppearancePreference.LIGHT)
        val original="Generated first offline thought: leave the afternoon unplanned."
        val description="Generated diary context; no Central or model is required."
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use {
            until("Actual empty first use") { shown().any { it.tag == "home-notice-connect" } }; screenshot("first-open")
            click("连接"); until("Connection entry") { activity() is ConnectionActivity }
            click("还没有自己的 Mote？"); until("Install help") { activity() is StartUsingActivity }; screenshot("install-help")
            click("复制给安装助手")
            assertEquals(StartUsingActivity.INSTALL_PROMPT,main { context.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString() })
            click("查看安装提示词"); screenshot("install-prompt")
            click("现在先记下来"); until("Offline editor") { activity() is RecordEditorActivity && shown().filterIsInstance<EditText>().any { it.contentDescription=="正在想什么" && it.isEnabled } }
            main { shown().filterIsInstance<EditText>().single { it.contentDescription=="正在想什么" }.setText(original) }; click("资料说明")
            main { shown().filterIsInstance<EditText>().single { it.tag=="record-description" }.setText(description) }; screenshot("first-editor")
            assertEquals(0,context.queue().depth()); click("保存")
            until("Saved editor returns to the connection entry") { activity() is ConnectionActivity }
            click("稍后连接")
            val row=context.queue().peek()!!
            until("Saved record is an ordinary home row") { activity() is MainActivity && shown().any { it.tag=="home-original:${row.getString("id")}" && it.contentDescription?.contains("已保存")==true } }; screenshot("home-saved-row-light")
            main { MoteAppearance.select(context,AppearancePreference.DARK) }; screenshot("home-saved-row-dark")
            main { MoteAppearance.select(context,AppearancePreference.LIGHT) }
            main {
                assertFalse(shown().filterIsInstance<TextView>().any { it.text.toString() in setOf("先留下，再慢慢想。", "最近留下的内容") })
                assertFalse(shown().any { it.tag == "home-record-receipt" })
                assertTrue(shown().single { it.tag=="home-original:${row.getString("id")}" }.contentDescription.toString().contains(original))
            }
            assertEquals(original,row.getString("ocrText")); assertEquals(description,row.getJSONObject("metadata").getString("ownerDescription")); assertFalse(row.optBoolean("uploaded")); assertFalse(settings.read().hasSyncConnection())
            main { shown().single { it.tag=="home-original:${row.getString("id")}" }.performClick() }; until("Exact full-page local original") { activity() is CaptureRecordsActivity && shown().filterIsInstance<TextView>().any { it.text.toString()==original } }; screenshot("first-local-original")
            main { assertEquals("原文",shown().filterIsInstance<TextView>().single { it.tag=="detail-title" }.text.toString()); assertTrue(shown().filterIsInstance<android.widget.Spinner>().isEmpty()) }
            click("返回上一页"); until("Return to the same saved home row") { activity() is MainActivity && shown().any { it.tag=="home-original:${row.getString("id")}" && it.contentDescription?.contains("已保存")==true } }
            assertEquals(row.getString("id"),context.queue().peek()!!.getString("id")); assertEquals(1,context.queue().depth()); assertFalse(settings.enabled); assertFalse(ProjectionService.running)
        }
    }
    @Test fun installHelpCopiesItsPromptAndKeepsAnExistingLocalDraft() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("uiFinalFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a")&&!Settings(context).enabled)
        val store=context.recordDraftStore();require(!store.hasPrepared());val old=store.draft();val before=context.queue().dedupeIds().toSet()
        val text="Generated installation-help draft";val description="Generated independent local description"
        val clipboard=context.getSystemService(ClipboardManager::class.java);var previous:android.content.ClipData?=null;var clipboardRead=false
        try {
            store.edit(text,org.json.JSONArray(),org.json.JSONObject().put("kind","manual"),description)
            ActivityScenario.launch(StartUsingActivity::class.java).use {
                until("Install help is active"){activity() is StartUsingActivity&&shown().any{it.contentDescription=="查看安装提示词"}}
                previous=main { clipboard.primaryClip?.let { android.content.ClipData(it) } };clipboardRead=true
                click("复制给安装助手");assertEquals(StartUsingActivity.INSTALL_PROMPT,main{clipboard.primaryClip!!.getItemAt(0).text.toString()})
                click("查看安装提示词");until("The full copied prompt is explicitly visible"){shown().filterIsInstance<TextView>().any{it.isShown&&it.text.toString()==StartUsingActivity.INSTALL_PROMPT}}
                screenshot("install-help-copied-prompt");click("现在先记下来")
                until("The existing draft opens without a connection"){activity() is RecordEditorActivity&&shown().filterIsInstance<EditText>().any{it.isEnabled&&it.text.toString()==text}}
                assertEquals(description,store.draft().getString("description"));assertEquals(before,context.queue().dedupeIds().toSet());screenshot("install-help-existing-draft")
            }
        } finally {
            main { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<RecordEditorActivity>().forEach{it.finish()};if(clipboardRead){if(previous==null)clipboard.clearPrimaryClip()else clipboard.setPrimaryClip(previous!!)} }
            store.edit(old.getString("text"),old.getJSONArray("attachments"),old.getJSONObject("origin"),old.optString("description"),old.optJSONObject("originPresentation"))
            assertEquals(before,context.queue().dedupeIds().toSet())
        }
    }
}
