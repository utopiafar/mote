package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Captures the AND-Editor canvas states in both themes on the generated Dev emulator. */
@RunWith(AndroidJUnit4::class)
class EditorVisualEvidenceInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun until(description: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(30) }; fail(description)
    }
    private fun shot(scenario: ActivityScenario<RecordEditorActivity>, name: String) {
        instrumentation.waitForIdleSync()
        val latch = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5, java.util.concurrent.TimeUnit.SECONDS))
        scenario.onActivity { activity ->
            val root = activity.window.decorView
            val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            try { root.draw(Canvas(bitmap)); File(context.filesDir, "ui-v1-evidence").apply { mkdirs() }.resolve("$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } } finally { bitmap.recycle() }
        }
    }
    private fun both(scenario: ActivityScenario<RecordEditorActivity>, state: String) {
        for (theme in listOf(AppearancePreference.LIGHT, AppearancePreference.DARK)) {
            MoteAppearance.select(context, theme); instrumentation.waitForIdleSync()
            shot(scenario, "editor-canvas-$state-" + theme.name.lowercase())
        }
    }
    private fun generatedPhoto(): ByteArray {
        val image = Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(image)
        canvas.drawColor(0xffe9e5dc.toInt())
        canvas.drawRoundRect(RectF(80f, 80f, 1120f, 820f), 16f, 16f, Paint().apply { color = 0xfff8f7f3.toInt() })
        val line = Paint().apply { color = 0xff3a3632.toInt(); strokeWidth = 9f; strokeCap = Paint.Cap.ROUND }
        canvas.drawLine(176f, 240f, 576f, 240f, line); canvas.drawLine(176f, 336f, 736f, 336f, line)
        canvas.drawLine(176f, 432f, 464f, 432f, line); canvas.drawLine(176f, 592f, 528f, 592f, line)
        val check = Paint().apply { color = 0xffb5432f.toInt(); strokeWidth = 10f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; style = Paint.Style.STROKE }
        canvas.drawLine(784f, 528f, 856f, 600f, check); canvas.drawLine(856f, 600f, 992f, 448f, check)
        val out = java.io.ByteArrayOutputStream(); image.compress(Bitmap.CompressFormat.JPEG, 95, out); image.recycle(); return out.toByteArray()
    }
    private fun generatedAudio(): ByteArray {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.RECORD_AUDIO)
        val file = File(context.cacheDir, "generated-evidence-audio.m4a")
        val recorder = MediaRecorder().apply { setAudioSource(MediaRecorder.AudioSource.MIC); setOutputFormat(MediaRecorder.OutputFormat.MPEG_4); setAudioEncoder(MediaRecorder.AudioEncoder.AAC); setOutputFile(file.absolutePath); prepare(); start() }
        Thread.sleep(1400); recorder.stop(); recorder.release()
        return file.readBytes().also { file.delete() }
    }
    private fun staged(name: String, bytes: ByteArray, mime: String) =
        context.recordDraftStore().stage(bytes, name, mime, UUID.nameUUIDFromBytes(name.toByteArray()).toString())

    @Test fun seededDraftCapturesEveryCanvasStateInBothThemes() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("recordEditorFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev")) { "Canvas evidence requires the isolated generated Dev emulator" }
        val settings = Settings(context); require(!settings.enabled && context.queue().depth() == 0) { "Canvas evidence requires collection disabled and an empty queue" }
        settings.save(settings.read().copy(server = "", token = "", syncMode = "manual"), confirmCentralEndpoint = true)
        MoteI18n.select(context, "zh-CN")
        val store = context.recordDraftStore()
        val text = "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。\n押金下个月退，记得要收据。"
        val manual = JSONObject().put("kind", "manual")
        try {
            val photo = staged("photo-generated-evidence.jpg", generatedPhoto(), "image/jpeg")
            val audio = staged("record-microphone-generated-evidence.m4a", generatedAudio(), "audio/mp4")
            store.clear()
            ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
                until("Empty editor ready") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == "正在想什么" }?.isEnabled == true }; ready }
                both(scenario, "content-empty")

                store.edit(text, JSONArray().put(photo), JSONObject(manual.toString()), "")
                scenario.recreate(); until("Photo draft restored") { store.draft().getJSONArray("attachments").length() == 1 }
                until("Photo tile drawn") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).any { it.contentDescription == MoteI18n.text("照片") } }; ready }
                both(scenario, "audio-false")

                store.edit(text, JSONArray().put(photo).put(audio), JSONObject(manual.toString()), "")
                scenario.recreate(); until("Audio row drawn") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).any { it.contentDescription == MoteI18n.text("播放") } }; ready }
                both(scenario, "editor")

                scenario.onActivity { views(it.window.decorView).single { it.tag == "record-describe-toggle" }.performClick() }
                until("Description expanded") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().single { it.tag == "record-description" }.isShown }; ready }
                both(scenario, "describe-true")

                scenario.onActivity { views(it.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "清空" }.performClick() }
                until("已清空 undo toast visible") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == "已清空" && it.isShown } }; ready }
                until("Durable draft cleared") { store.draft().getJSONArray("attachments").length() == 0 && store.draft().getString("text").isEmpty() }
                both(scenario, "content-cleared")
            }
        } finally { store.clear(); MoteAppearance.select(context, AppearancePreference.LIGHT) }
    }
}
