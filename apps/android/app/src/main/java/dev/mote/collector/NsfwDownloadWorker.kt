package dev.mote.collector

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class NsfwDownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    private val store = NsfwModelStore(context)
    override fun doWork(): Result = try {
        store.download(Settings(applicationContext).read().nsfw)
        Result.success()
    } catch (_: Exception) {
        if (!isStopped) store.status("下载未完成，将退避重试；可取消后更换来源，已有断点保留")
        Result.retry()
    }
    override fun onStopped() { store.cancel(); store.status("下载已暂停，断点保留；点击下载/继续可恢复"); super.onStopped() }
    companion object {
        fun start(context: Context, wifiOnly: Boolean) {
            NsfwModelStore(context).status("等待符合网络设置的连接，准备下载/续传")
            val request = OneTimeWorkRequestBuilder<NsfwDownloadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("mote-nsfw-download", ExistingWorkPolicy.REPLACE, request)
        }
        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork("mote-nsfw-download")
            NsfwModelStore(context).status("下载已取消，断点保留")
        }
    }
}
