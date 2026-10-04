package dev.mote.collector

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.TimeUnit

class CaptureOcr(private val context: Context) : AutoCloseable {
    private val latin = lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val chinese = lazy { TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) }
    fun recognize(bitmap: Bitmap, config: CollectorConfig = Settings(context).read(), appId: String? = null, canContinue: () -> Boolean = { true }): String {
        val started = SystemClock.elapsedRealtime()
        val input = InputImage.fromBitmap(bitmap, 0)
        if (!canContinue()) throw java.util.concurrent.CancellationException()
        val texts = OcrPolicy.engines(config.ocrMode, config.ocrAppModes, appId).map { engine ->
            if (!canContinue()) throw java.util.concurrent.CancellationException()
            Diagnostics(context).add("ocrCalls")
            val client = if (engine == "latin") latin.value else chinese.value
            Tasks.await(client.process(input), 30, TimeUnit.SECONDS).text
        }
        if (!canContinue()) throw java.util.concurrent.CancellationException()
        Diagnostics(context).timing("ocrMs", SystemClock.elapsedRealtime() - started)
        return texts.filter(String::isNotBlank).distinct().joinToString("\n").take(100_000)
    }
    override fun close() { if (latin.isInitialized()) latin.value.close(); if (chinese.isInitialized()) chinese.value.close() }
}
