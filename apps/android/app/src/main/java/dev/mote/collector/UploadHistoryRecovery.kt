package dev.mote.collector

import android.content.Context

internal class UploadHistoryUnavailable(cause: Exception) : IllegalStateException(UploadHistoryRecovery.message(), cause)

internal object UploadHistoryRecovery {
    @Volatile var unavailable = false
        private set
    fun title() = MoteI18n.text("上传历史") + " · " + MoteI18n.text("本机存储恢复失败")
    fun message() = title() + "。 " +
        MoteI18n.text("同步失败，本地记录已保留") + "。 " + MoteI18n.text("请稍后重试")
    fun report(context: Context) {
        unavailable = true
        Settings(context).syncStatus("error", message())
        SupportEvents.record(context, EventStage.QUEUE, EventCode.STORAGE)
        LocalStateChanges.changed(immediate = true)
    }
    fun available() { unavailable = false }
    /** A history failure must not skip unrelated local maintenance or source scheduling. */
    fun restore(context: Context, queue: DurableQueue, settings: Settings): Boolean = try {
        ConnectionGuard.sync {
            val latest = settings.read()
            val history = context.captureUploadHistory()
            UploadHistoryRetention.prune(context, UploadHistoryRetention.read(context))
            if (latest.hasSyncConnection()) {
                val scope = CaptureUploadReceipt.scope(latest.server, settings.deviceId)
                history.recoverInterrupted(scope, LoginProcess.id)
                CaptureReceiptFinalizer(history).recover(queue, scope)
                ItemUploadSession(context, latest, lane = "source").restore(false)
                ItemUploadSession(context, latest, lane = "capture").restore(false)
            }
            available()
        } != null
    } catch (_: Exception) { report(context); false }
}
