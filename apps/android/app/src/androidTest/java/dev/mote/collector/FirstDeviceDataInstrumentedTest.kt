package dev.mote.collector

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.CheckBox
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
import java.net.URI
import java.util.concurrent.atomic.AtomicReference

/** Generated, opt-in native UI → real WorkManager → real Central acceptance, without a model.
 * Push a private connection.json into this disposable Dev app's files directory first.
 * The host owns the real Central process, adb reverse and generated profile cleanup.
 */
@RunWith(AndroidJUnit4::class)
class FirstDeviceDataInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val text = "Generated Android first-data original: blue notebook, 26 October."
    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun visible() = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun activityOrNull(): Activity? = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull { it.packageName == context.packageName }
    private fun activity(): Activity = requireNotNull(activityOrNull())
    private fun until(description: String, timeout: Long = 25000, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(100) }
        val labels = main { visible().filterIsInstance<TextView>().filterNot { it is EditText }.joinToString(" | ") { it.text.toString().take(180) } }
        fail("$description. Native UI: $labels")
    }
    private fun click(description: String, predicate: (View) -> Boolean) {
        until(description) { main { visible().any { it.isEnabled && it.isClickable && predicate(it) } } }
        main { visible().first { it.isEnabled && it.isClickable && predicate(it) }.let {
            it.requestRectangleOnScreen(android.graphics.Rect(0, 0, it.width, it.height), true)
            assertTrue(description, it.performClick())
        } }
        instrumentation.waitForIdleSync()
    }
    private fun clickText(label: String) = click("Reach native action $label") { it is TextView && it.text.toString() == label }
    private fun screenshot(name: String) = main {
        val roots = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() && it.width > 0 && it.height > 0 }
        val root = roots.firstOrNull { views(it).filterIsInstance<TextView>().any { label -> label.isShown && label.text.toString() == "基于这条记录提问" } } ?: activity().window.decorView
        val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(image)) // Keep FLAG_SECURE; render only our generated app views.
        File(context.filesDir, "first-data-evidence").apply { mkdirs() }.resolve("$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
    private fun owner(): CentralClient {
        assumeTrue(InstrumentationRegistry.getArguments().getString("firstDataFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val fixture = JSONObject(File(context.filesDir, "first-data-connection.json").readText())
        val endpoint = URI(fixture.getString("url"))
        require(endpoint.scheme == "http" && endpoint.host == "127.0.0.1" && endpoint.port > 1024)
        return CentralClient(fixture.getString("url"), fixture.getString("token"))
    }
    private fun openOriginal(id: String) {
        click("Open Library") { it.tag == "primary:LIBRARY" }
        click("Open the exact saved record") { it.tag == "library-record:$id" }
        until("The native original reader shows the saved text") { main {
            WindowInspector.getGlobalWindowViews().filter { it.hasWindowFocus() }.any { root ->
                val labels = views(root).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                "原文" in labels && "基于这条记录提问" in labels && text in labels
            }
        } }
    }
    private fun returnFromOriginal() {
        clickText("关闭详情")
        until("Return to the focused record list") { main { activityOrNull() is CaptureRecordsActivity && activity().window.decorView.hasWindowFocus() } }
        instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        until("Return to the original main Activity before closing its scenario") { main { activityOrNull() is MainActivity && activity().window.decorView.hasWindowFocus() } }
    }

    @Test fun connectSaveSendAndConfirmSameOriginal() {
        val owner = owner(); val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && context.recordDraftStore().draft().getString("text").isBlank())
        require(context.recordDraftStore().draft().getJSONArray("attachments").length() == 0)
        settings.save(settings.read().copy(server = "", token = "", debugHttp = true, deviceName = "Generated Android 5580", syncMode = "manual", wifiOnly = false, uploadedRetentionDays = 7), confirmCentralEndpoint = true)
        MoteI18n.select(context, "zh-CN")
        assertEquals("waiting", owner.get("/api/devices/first-data").getString("state"))
        val invitation = owner.post("/api/connections/invitations", JSONObject().put("serverUrl", owner.server).put("label", "Generated Android native acceptance")).getJSONObject("invitation")
        ActivityScenario.launch(ConnectionActivity::class.java).use {
            until("Invitation entry loads") { main { visible().filterIsInstance<EditText>().any { it.hint.toString() == "粘贴 JSON 或 mote://connect…" } } }
            main {
                visible().filterIsInstance<EditText>().single { it.hint.toString() == "粘贴 JSON 或 mote://connect…" }.setText(invitation.toString())
                visible().filterIsInstance<CheckBox>().single().isChecked = true
            }
            clickText("解析并核对节点"); clickText("确认连接此节点"); clickText("取消")
            assertFalse("Cancelling confirmation must leave the device unconnected", settings.read().hasSyncConnection())
            clickText("确认连接此节点"); clickText("连接")
            until("Actual invitation exchange saves this device connection") { settings.read().hasSyncConnection() }
            until("The connection UI confirms completion") { main { visible().filterIsInstance<TextView>().any { it.text.toString().startsWith("连接成功：") } } }
            screenshot("connected")
        }
        assertEquals(owner.server, settings.read().server)
        ActivityScenario.launch(MainActivity::class.java).use {
            click("Global new record action") { it.tag == "global-record-action" }
            until("Native editor loads") { main { activityOrNull() is RecordEditorActivity && visible().filterIsInstance<EditText>().singleOrNull()?.isEnabled == true } }
            main { visible().filterIsInstance<EditText>().single().setText(text) }
            until("Draft survives privately before Save") { context.recordDraftStore().draft().getString("text") == text }
            val originalEditor = main { activity() }
            main { originalEditor.recreate() }
            until("Draft restores after Activity recreation") { main { activityOrNull() is RecordEditorActivity && activityOrNull() !== originalEditor && visible().filterIsInstance<EditText>().any { it.isEnabled && it.text.toString() == text } } }
            assertEquals("Opening/recreating the editor must not create a record", 0, context.queue().depth())
            screenshot("draft-restored"); clickText("保存")
            until("Explicit Save creates one pending record and returns home") { context.queue().pendingSync().count == 1 && main { activityOrNull() is MainActivity } }
            val record = context.queue().peek()!!; val id = record.getString("id")
            assertEquals(text, record.getString("ocrText")); assertEquals(settings.deviceId, record.getString("deviceId"))
            assertEquals("waiting", owner.get("/api/devices/first-data").getString("state"))
            openOriginal(id); screenshot("local-original")
            returnFromOriginal()
            click("Return home") { it.tag == "primary:HOME" }
            clickText("查看状态与操作"); clickText("立即同步")
            until("Real WorkManager receives a valid upload acknowledgement", 120000) { context.queue().pendingSync().count == 0 }
            val state = owner.get("/api/devices/first-data")
            assertEquals("ready", state.getString("state")); assertTrue(state.getBoolean("originalAvailable"))
            val candidate = state.getJSONObject("candidate")
            assertEquals(id, candidate.getString("id")); assertEquals(settings.deviceId, candidate.getString("deviceId"))
            assertEquals("note", candidate.getString("source")); assertTrue(candidate.getString("receivedAt").isNotBlank())
            val remote = owner.get("/api/capture-browser/$id")
            assertEquals(id, remote.getString("id")); assertEquals(text, remote.getString("ocrText"))
            assertEquals("The retained local original survives successful upload", text, context.queue().capture(id)!!.getString("ocrText"))
            openOriginal(id); screenshot("confirmed-original")
            File(context.filesDir, "first-data-result.json").writeText(JSONObject().put("id", id).put("deviceId", settings.deviceId).put("text", text).put("candidate", candidate).toString())
            returnFromOriginal()
        }
    }

    /** Run as a second instrumentation invocation after host force-stop, using the same fixture. */
    @Test fun sameOriginalAfterProcessRestart() {
        val owner = owner()
        val saved = JSONObject(File(context.filesDir, "first-data-result.json").readText()); val id = saved.getString("id")
        assertEquals(0, context.queue().pendingSync().count)
        assertEquals(text, context.queue().capture(id)!!.getString("ocrText"))
        assertEquals(saved.getJSONObject("candidate").getString("receivedAt"), owner.get("/api/devices/first-data").getJSONObject("candidate").getString("receivedAt"))
        ActivityScenario.launch(MainActivity::class.java).use { openOriginal(id); screenshot("restarted-original"); returnFromOriginal() }
    }
}
