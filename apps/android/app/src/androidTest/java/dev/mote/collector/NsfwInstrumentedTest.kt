package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Requires the verified public model; tests generated diagrams only, never real screenshots. */
@RunWith(AndroidJUnit4::class)
class NsfwInstrumentedTest {
    @Test fun actualModelRunsOfflineAndReloadsAfterProcessReset() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = NsfwModelStore(context)
        assumeTrue("Pass the pinned model into the dedicated fixture emulator first", store.hasFile())
        assertEquals(2, store.verifiedFiles().size)
        val bitmap = Bitmap.createBitmap(640, 400, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(23, 110, 98); textSize = 38f }
        canvas.drawText("MOTE GENERATED FIXTURE", 24f, 100f, paint)
        canvas.drawRect(30f, 180f, 280f, 320f, paint)
        File(context.filesDir, "qwen-cross.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val client = NsfwClient(context)
        try {
            val config = Settings(context).read().nsfw.copy(timeoutMs = 180000)
            val first = client.check(bitmap, config)
            File(context.filesDir, "qwen-fixture-result.txt").writeText("first=$first; ${store.inferenceStatus()}\n")
            assertTrue("Generated non-explicit diagram must pass shared default policy", first.allow)
            client.reset()
            val second = client.check(bitmap, config)
            File(context.filesDir, "qwen-fixture-result.txt").appendText("second=$second; ${store.inferenceStatus()}\n")
            assertEquals("Same generated pixels after native process recreation", first.allow, second.allow)
            assertEquals("NSFW only test does not queue pictures", 0, context.queue().depth())
            println("MOTE_NSFW_FIXTURE decision=$first; resetDecision=$second; ${store.inferenceStatus()}")
        } finally { client.close(); bitmap.recycle() }
    }
    @Test fun wrongModelImportPreservesVerifiedFileAndFailsClosed() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = NsfwModelStore(context)
        assumeTrue(store.hasFile())
        assertThrows(IllegalStateException::class.java) { store.importModel("generated invalid model fixture".byteInputStream()) }
        assertEquals(2, store.verifiedFiles().size)
        assertFalse(File(store.directory, "import.part").exists())
    }
}
