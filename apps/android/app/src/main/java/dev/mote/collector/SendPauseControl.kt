package dev.mote.collector

import android.content.Context
import android.os.Looper
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/** A send-only change. Local collection and source scanning keep their lifecycle and permissions. */
internal object SendPauseControl {
    fun set(context: Context, paused: Boolean) {
        check(Looper.myLooper() != Looper.getMainLooper())
        val settings = Settings(context)
        val current = settings.read()
        settings.save(current.copy(syncPaused = paused), expected = current)
        if (paused) {
            HttpJson.cancelSending()
            val manager = WorkManager.getInstance(context)
            listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload", "mote-heartbeat", "mote-heartbeat-now", "mote-sync-recovery")
                .map { manager.cancelUniqueWork(it).result }.forEach { it.get(10, TimeUnit.SECONDS) }
            settings.syncStatus("paused", MoteI18n.text("已暂停全部发送 · 本机继续保存"))
        }
        SyncSchedule.invalidate()
        SyncSchedule.schedule(context, settings.read())
    }
}
