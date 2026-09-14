package dev.mote.collector

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import androidx.work.*
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.TimeUnit

class CaptureOcr(private val context: Context) : AutoCloseable {
    private val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    fun recognize(bitmap: Bitmap, canContinue: () -> Boolean = { true }): String {
        val started = SystemClock.elapsedRealtime()
        val input = InputImage.fromBitmap(bitmap, 0)
        if (!canContinue()) throw java.util.concurrent.CancellationException()
        val chineseText = Tasks.await(chinese.process(input), 30, TimeUnit.SECONDS).text
        if (!canContinue()) throw java.util.concurrent.CancellationException()
        val latinText = Tasks.await(latin.process(input), 30, TimeUnit.SECONDS).text
        if (!canContinue()) throw java.util.concurrent.CancellationException()
        Diagnostics(context).timing("ocrMs", SystemClock.elapsedRealtime() - started)
        return listOf(chineseText, latinText).filter(String::isNotBlank).distinct().joinToString("\n").take(100_000)
    }
    override fun close() { latin.close(); chinese.close() }
}

/** Reads only already masked, encrypted queue images. It never requests a screen capture. */
class CaptureOcrWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (!workerLock.tryLock()) return Result.retry()
        return try { work() } finally { workerLock.unlock() }
    }
    private fun work(): Result = ConnectionGuard.sync {
        val settings = Settings(applicationContext)
        val queue = applicationContext.queue()
        try {
            if (queue.pendingOcr() == null) return@sync Result.success()
            CaptureOcr(applicationContext).use { ocr ->
                repeat(20) {
                    val config = settings.read()
                    if (isStopped || (config.ocrChargingOnly && !Diagnostics.battery(applicationContext).second)) return@sync Result.retry()
                    val event = queue.pendingOcr() ?: return@sync Result.success()
                    val id = event.getString("id")
                    try {
                        val bytes = queue.image(id) ?: return@repeat
                        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("Invalid stored image")
                        val text = try { ocr.recognize(bitmap) { !isStopped && (!settings.read().ocrChargingOnly || Diagnostics.battery(applicationContext).second) } } finally { bitmap.recycle() }
                        if (isStopped || (settings.read().ocrChargingOnly && !Diagnostics.battery(applicationContext).second)) return@sync Result.retry()
                        queue.completeOcr(id, text, "completed", config.maxQueueMiB * 1024L * 1024L)
                    } catch (error: Exception) {
                        if (error is java.util.concurrent.CancellationException || isStopped) return@sync Result.retry()
                        SupportEvents.record(applicationContext, EventStage.OCR, EventJournal.failure(error, EventStage.OCR))
                        if (error is QueueFull || queue.recordOcrFailure(id) < 3) return@sync Result.retry()
                        queue.completeOcr(id, "", "failed", config.maxQueueMiB * 1024L * 1024L)
                    }
                    UploadWorker.schedule(applicationContext, settings.read())
                }
            }
            if (queue.pendingOcr() == null) Result.success() else Result.retry()
        } catch (_: Exception) { Result.retry() }
    } ?: Result.retry()

    companion object {
        private val workerLock = java.util.concurrent.locks.ReentrantLock()
        fun schedule(context: Context, config: CollectorConfig, replace: Boolean = false) {
            val constraints = Constraints.Builder().setRequiresCharging(config.ocrChargingOnly).build()
            val recovery = PeriodicWorkRequestBuilder<CaptureOcrWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("mote-capture-ocr-recovery", ExistingPeriodicWorkPolicy.UPDATE, recovery)
            val request = OneTimeWorkRequestBuilder<CaptureOcrWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("mote-capture-ocr", if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
        }
    }
}
