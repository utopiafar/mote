package dev.mote.collector

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.util.concurrent.TimeUnit

/** Separate from the upload queue, export, support bundle and shared image gallery. */
fun Context.imageDedupeDiagnostics() = ImageDedupeDiagnosticsStore(
    File(noBackupFilesDir, "image-dedupe-diagnostics"), localContentCipher(),
    enabled = { Settings(this).read().imageDedupeDiagnosticsEnabled }
)

object ImageDedupeDiagnosticsMaintenance {
    private const val WORK = "mote-image-dedupe-diagnostics-cleanup"
    fun configure(context: Context, enabled: Boolean) {
        val work = WorkManager.getInstance(context)
        if (enabled) work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ImageDedupeDiagnosticsCleanupWorker>(15, TimeUnit.MINUTES).build())
        else work.cancelUniqueWork(WORK)
    }
}

/** Android may defer background work; every viewer/capture read also enforces the 24-hour expiry. */
class ImageDedupeDiagnosticsCleanupWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try { applicationContext.imageDedupeDiagnostics().prune(); Result.success() }
    catch (_: Exception) { Result.retry() }
}
