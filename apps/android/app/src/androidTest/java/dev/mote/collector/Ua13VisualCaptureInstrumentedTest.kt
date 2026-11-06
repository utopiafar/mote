package dev.mote.collector

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
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
    private data class ProtectedPanel(val image: Bitmap, val x: Int, val y: Int, val dim: Float, val radius: Float)
    private fun screen(): Bitmap = android.os.ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand("screencap -p")
    ).use { BitmapFactory.decodeStream(it) } ?: error("screencap failed")
    private fun save(image: Bitmap, name: String) {
        File(context.getExternalFilesDir(null), "ua13-visual").apply { mkdirs() }
            .resolve("$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun shot(scenario: ActivityScenario<ShareRecordActivity>, name: String): ProtectedPanel {
        instrumentation.waitForIdleSync()
        val latch = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
        assertTrue(latch.await(5, java.util.concurrent.TimeUnit.SECONDS))
        // Preserve the unmodified compositor screenshot as evidence of protection.
        screen().also { try { save(it, "raw-$name") } finally { it.recycle() } }
        var dim = 0f
        var radius = 0f
        scenario.onActivity { activity ->
            assertTrue("Share stays protected during visual capture", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            dim = activity.window.attributes.dimAmount
            radius = activity.moteDp(MoteTheme.radiusPanelMobile).toFloat()
        }
        val window = GeneratedVisualScreencap.window(scenario)
        val panel = ProtectedPanel(window.bitmap, window.x, window.y, dim, radius)
        return panel
    }
    private fun composite(backdrop: ActivityScenario<FixtureActivity>, panel: ProtectedPanel, name: String) {
        try {
            // A non-sensitive one-pixel test window asks Android's compositor to apply
            // the exact dim amount read from the still-protected product window.
            backdrop.onActivity { it.showVisualScrim(panel.dim) }
            instrumentation.waitForIdleSync()
            val latch = java.util.concurrent.CountDownLatch(1)
            backdrop.onActivity { it.window.decorView.postOnAnimation { it.window.decorView.postOnAnimation { latch.countDown() } } }
            assertTrue(latch.await(5, java.util.concurrent.TimeUnit.SECONDS))
            val base = NativeColorRole.SURFACE_SUNKEN.color()
            var stable: Bitmap? = null
            until("System dim settled for $name") {
                val candidate = screen()
                val pixel = candidate.getPixel(candidate.width / 2, candidate.height / 3)
                val channels = listOf(android.graphics.Color.red(pixel) to android.graphics.Color.red(base),
                    android.graphics.Color.green(pixel) to android.graphics.Color.green(base),
                    android.graphics.Color.blue(pixel) to android.graphics.Color.blue(base))
                val matches = channels.all { (actual, source) -> kotlin.math.abs(actual - (source * (1f - panel.dim)).toInt()) <= 4 }
                if (matches) stable = candidate else candidate.recycle()
                matches
            }
            val raw = stable ?: error("No stable dimmed screenshot")
            try {
                save(raw, "backdrop-$name")
                val combined = raw.copy(Bitmap.Config.ARGB_8888, true)
                try {
                    Canvas(combined).apply {
                        val left = panel.x.toFloat(); val top = panel.y.toFloat()
                        val path = android.graphics.Path().apply {
                            addRoundRect(left, top, left + panel.image.width, top + panel.image.height,
                                floatArrayOf(panel.radius, panel.radius, panel.radius, panel.radius, 0f, 0f, 0f, 0f), android.graphics.Path.Direction.CW)
                        }
                        save(); clipPath(path); drawBitmap(panel.image, left, top, null); restore()
                    }
                    save(combined, name)
                } finally { combined.recycle() }
            } finally { raw.recycle() }
            backdrop.onActivity { it.dismissVisualScrim() }
        } finally { panel.image.recycle() }
    }
    private fun image(name: String, index: Int): android.net.Uri {
        val directory = File(context.cacheDir, "record-camera/ua13-visual").apply { mkdirs() }
        val file = File(directory, name)
        val bitmap = Bitmap.createBitmap(72, 72, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        fun fill(color: Long) { canvas.drawColor(color.toInt()) }
        fun rectangle(left: Float, top: Float, right: Float, bottom: Float, color: Long) {
            paint.color = color.toInt(); paint.style = android.graphics.Paint.Style.FILL
            canvas.drawRect(left, top, right, bottom, paint)
        }
        fun line(x: Float, y: Float, end: Float, color: Long, width: Float) {
            paint.color = color.toInt(); paint.strokeWidth = width; paint.strokeCap = android.graphics.Paint.Cap.ROUND
            paint.style = android.graphics.Paint.Style.STROKE; canvas.drawLine(x, y, end, y, paint)
        }
        when (index) {
            0 -> {
                fill(0xffe9e5dc); rectangle(8f, 8f, 64f, 64f, 0xfff8f7f3)
                line(16f, 22f, 44f, 0xff2f5d9e, 2f); line(16f, 32f, 56f, 0xff2f5d9e, 2f); line(16f, 42f, 36f, 0xff2f5d9e, 2f)
            }
            1 -> {
                fill(0xffd9d2c4); rectangle(22f, 8f, 50f, 64f, 0xfffbfaf6)
                line(27f, 18f, 45f, 0xff8b847a, 1.8f); line(27f, 26f, 39f, 0xff8b847a, 1.8f)
                line(27f, 34f, 45f, 0xff8b847a, 1.8f); line(27f, 42f, 36f, 0xff8b847a, 1.8f)
            }
            else -> {
                fill(0xffc9d3c2)
                val hill = android.graphics.Path().apply { moveTo(0f, 52f); lineTo(20f, 34f); lineTo(34f, 46f); lineTo(46f, 36f); lineTo(72f, 58f); lineTo(72f, 72f); lineTo(0f, 72f); close() }
                paint.color = 0xff8fa287.toInt(); paint.style = android.graphics.Paint.Style.FILL; canvas.drawPath(hill, paint)
                paint.color = 0xfff1e6c8.toInt(); canvas.drawCircle(52f, 20f, 7f, paint)
            }
        }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        return androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)
    }
    private fun fileUri(name: String): android.net.Uri {
        val directory = File(context.cacheDir, "record-camera/ua13-visual").apply { mkdirs() }
        val file = File(directory, name).apply { writeBytes(ByteArray(2_400_000)) }
        return androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)
    }

    @Test fun capturesEveryCanvasState() {
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.contains("emu64a"))
        val previous = MoteAppearance.preference()
        MoteI18n.select(context, "zh-CN")
        fun both(name: String, describe: Boolean = false, saved: Boolean = false, intent: () -> Intent) {
            capture("$name-light", AppearancePreference.LIGHT, intent(), describe, saved)
            capture("$name-dark", AppearancePreference.DARK, intent(), describe, saved)
        }
        try {
            both("link") { Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe") }
            both("images") { Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(image("one.png", 0), image("two.png", 1), image("three.png", 2))) }
            both("file") { Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("application/pdf")
                .putExtra(Intent.EXTRA_STREAM, fileUri("季度计划.pdf")) }
            both("answer") {
                val question = "怎样分摊费用？"
                val raw = question + "\n\n按实际用量分摊暖气费，月底前把账单照片发给房东；押金下个月退，需要收据。"
                Intent(context, AnswerRecordActivity::class.java).putExtra("recordText", raw).putExtra("conversationId", UUID.randomUUID().toString())
                    .putExtra("turnId", UUID.randomUUID().toString()).putExtra("quoteQuestion", question)
                    .putExtra("quoteOrigin", "http://127.0.0.1:54783").putStringArrayListExtra("quoteCitations", arrayListOf())
            }
            both("describe", describe = true) { Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe") }
            both("done", saved = true) { Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TITLE, "低温慢烤牛肋排的时间表").putExtra(Intent.EXTRA_TEXT, "https://seriouseats.com/generated-recipe") }
        } finally { MoteAppearance.select(context, previous) }
    }

    private fun capture(name: String, appearance: AppearancePreference, intent: Intent, describe: Boolean = false, saved: Boolean = false) {
        MoteAppearance.select(context, appearance)
        val answer = intent.component?.className == AnswerRecordActivity::class.java.name
        val queue = context.queue(); val before = queue.dedupeIds().toSet()
        val panel = ActivityScenario.launch<ShareRecordActivity>(intent).use { scenario ->
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
        ActivityScenario.launch<FixtureActivity>(Intent(context, FixtureActivity::class.java).putExtra("visualShareBackdrop", true)).use { backdrop ->
            composite(backdrop, panel, "ua13-$name")
        }
        if (saved) {
            QuickNotes.io.submit {}.get()
            for (id in queue.dedupeIds().toSet() - before) queue.resolveDedupe(id, "", null, null, null)
        }
    }
}
