package dev.mote.collector

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

object Notifications {
    const val ID = 4101
    private const val CHANNEL = "mote_capture"
    fun create(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "屏幕采集状态", NotificationManager.IMPORTANCE_LOW))
    }
    fun notification(context: Context, text: String): Notification {
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getBroadcast(context, 1, Intent(context, StopReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle("Mote · 屏幕采集")
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).addAction(Notification.Action.Builder(null, "停止采集", stop).build()).build()
    }
    fun show(context: Context, text: String) {
        if (context.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
            context.getSystemService(NotificationManager::class.java).notify(ID, notification(context, text))
    }
    fun clear(context: Context) { context.getSystemService(NotificationManager::class.java).cancel(ID) }
}

class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val settings = Settings(context)
        settings.enabled = false
        settings.status("paused", "你已停止采集，已有队列继续同步")
        context.stopService(Intent(context, ProjectionService::class.java))
        CaptureAccessibilityService.instance?.stopCapture()
        Notifications.clear(context)
        runCatching { UploadWorker.schedule(context, settings.read(), true) }
    }
}
