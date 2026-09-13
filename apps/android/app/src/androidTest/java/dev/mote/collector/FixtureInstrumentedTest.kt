package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Generated bitmaps only. Does not request capture, read a screen, or upload any user data. */
@RunWith(AndroidJUnit4::class)
class FixtureInstrumentedTest {
    @Test fun keystoreQueueSurvivesRecreationAndAcknowledgement() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.noBackupFilesDir, "fixture-${UUID.randomUUID()}")
        try {
            val event = JSONObject().put("id", UUID.randomUUID().toString()).put("privacy", JSONObject().put("excluded", false))
                .put("ocrText", "GENERATED FIXTURE ONLY")
            DurableQueue(dir, SecretBox()).enqueue(event, "synthetic pixels".toByteArray(), 10000)
            val reopened = DurableQueue(dir, SecretBox())
            assertEquals("GENERATED FIXTURE ONLY", reopened.peek()!!.getString("ocrText"))
            assertFalse(dir.listFiles()!!.any { String(it.readBytes()).contains("GENERATED FIXTURE ONLY") })
            reopened.acknowledge(event.getString("id"))
            assertEquals(0, reopened.depth())
        } finally { dir.deleteRecursively() }
    }
    @Test fun bundledOcrReadsOnlyUnmaskedSyntheticText() {
        val bitmap = Bitmap.createBitmap(1000, 400, Bitmap.Config.ARGB_8888)
        val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        try {
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 64f }
            canvas.drawText("MOTE FIXTURE 2048", 35f, 95f, paint)
            canvas.drawText("SECRET 998877", 35f, 290f, paint)
            ImagePrivacy.applyMasks(bitmap, listOf(Mask(0f, .45f, 1f, 1f)))
            assertEquals(Color.BLACK, bitmap.getPixel(500, 300))
            val input = InputImage.fromBitmap(bitmap, 0)
            val text = Tasks.await(latin.process(input), 45, TimeUnit.SECONDS).text
            assertTrue(text.contains("MOTE"))
            assertFalse(text.contains("SECRET"))
            assertFalse(text.contains("998877"))
            val chineseText = Tasks.await(chinese.process(input), 45, TimeUnit.SECONDS).text
            assertFalse(chineseText.contains("SECRET"))
        } finally { bitmap.recycle(); latin.close(); chinese.close() }
    }
}
