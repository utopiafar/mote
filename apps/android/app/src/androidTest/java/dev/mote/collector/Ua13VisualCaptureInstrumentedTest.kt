package dev.mote.collector

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Captures the AND-Share canvas states on the generated Dev emulator. */
@RunWith(AndroidJUnit4::class)
class Ua13VisualCaptureInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun until(description: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(40) }
        fail(description)
    }
    private fun shot(scenario: ActivityScenario<ShareRecordActivity>, name: String) {
        instrumentation.waitForIdleSync()
        val latch = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5, java.util.concurrent.TimeUnit.SECONDS))
        scenario.onActivity { activity ->
            val root = activity.window.decorView
            val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            try {
                root.draw(Canvas(bitmap))
                File(context.getExternalFilesDir(null), "ua13-visual").apply { mkdirs() }
                    .resolve("$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        }
    }
    private fun image(name: String, color: Int): android.net.Uri {
        val directory = File(context.cacheDir, "record-camera/ua13-visual").apply { mkdirs() }
        val file = File(directory, name)
        val bitmap = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        return androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)
    }
    private fun fileUri(name: String): android.net.Uri {
        val directory = File(context.cacheDir, "record-camera/ua13-visual").apply { mkdirs() }
        val file = File(directory, name).apply { writeBytes(ByteArray(2_400_000)) }
        return androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)
    }

    @Test fun capturesEveryCanvasState() {
        MoteI18n.select(context, "zh-CN")
        capture("link-light", AppearancePreference.LIGHT, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe"))
        capture("link-dark", AppearancePreference.DARK, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe"))
        capture("images-light", AppearancePreference.LIGHT, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(
                image("one.png", 0xffd9d2c4.toInt()), image("two.png", 0xffc9d3c2.toInt()), image("three.png", 0xff8fa287.toInt()))))
        capture("file-light", AppearancePreference.LIGHT, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("application/pdf")
            .putExtra(Intent.EXTRA_STREAM, fileUri("季度计划.pdf")))
        capture("answer-light", AppearancePreference.LIGHT, Intent(context, AnswerRecordActivity::class.java).let { intent ->
            val question = "怎样分摊费用？"
            val raw = question + "\n\n按实际用量分摊暖气费，月底前把账单照片发给房东；押金下个月退，需要收据。"
            intent.putExtra("recordText", raw).putExtra("conversationId", UUID.randomUUID().toString())
                .putExtra("turnId", UUID.randomUUID().toString()).putExtra("quoteQuestion", question)
                .putExtra("quoteOrigin", "http://127.0.0.1:54783").putStringArrayListExtra("quoteCitations", arrayListOf())
        })
        capture("describe-light", AppearancePreference.LIGHT, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe"), describe = true)
        capture("done-light", AppearancePreference.LIGHT, Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe"), saved = true)
        MoteAppearance.select(context, AppearancePreference.LIGHT)
    }

    private fun capture(name: String, appearance: AppearancePreference, intent: Intent, describe: Boolean = false, saved: Boolean = false) {
        MoteAppearance.select(context, appearance)
        val answer = intent.component?.className == AnswerRecordActivity::class.java.name
        val queue = context.queue(); val before = queue.dedupeIds().toSet()
        ActivityScenario.launch<ShareRecordActivity>(intent).use { scenario ->
            until("$name panel ready") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).any { it.tag == "share-save" && it.isEnabled && it.isShown } }; ready }
            scenario.onActivity { activity ->
                views(activity.window.decorView).filterIsInstance<EditText>().single { it.tag == "share-note" }
                    .setText(if (answer) "周五前把账单照片发给房东。" else "周末试一下，6 小时那版。")
            }
            if (describe) {
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "share-description-toggle" }.performClick() }
                until("$name description expanded") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<EditText>().single { it.tag == "record-description" }.isShown }; ready }
            }
            if (saved) {
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "share-save" }.performClick() }
                until("$name saved overlay") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).any { it.tag == "share-done" && it.isShown } }; ready }
            }
            shot(scenario, "ua13-$name")
        }
        if (saved) {
            QuickNotes.io.submit {}.get()
            for (id in queue.dedupeIds().toSet() - before) queue.resolveDedupe(id, "", null, null, null)
        }
    }
}
