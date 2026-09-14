package dev.mote.collector

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

object Notifications {
    const val ID = 4101
    private const val MEDIA_ID = 4102
    private const val CHANNEL = "mote_capture"
    fun create(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "屏幕采集状态", NotificationManager.IMPORTANCE_LOW))
    }
    fun notification(context: Context, text: String): Notification {
        // Launcher semantics bring the existing task (including a detail screen) forward.
        val open = PendingIntent.getActivity(context, 0, Intent.makeMainActivity(android.content.ComponentName(context, MainActivity::class.java)), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
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
    fun showMedia(context: Context, text: String) {
        if (context.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
            context.getSystemService(NotificationManager::class.java).notify(MEDIA_ID, Notification.Builder.recoverBuilder(context, notification(context, text)).setContentTitle("Mote · 媒体采集").build())
    }
    fun clearMedia(context: Context) { context.getSystemService(NotificationManager::class.java).cancel(MEDIA_ID) }
}

class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val settings = Settings(context)
        RuntimeSettings.cancelProjectionConsentRequest()
        settings.enabled = false
        settings.status("paused", "你已停止采集，已有记录保留，同步按所选策略运行")
        context.stopService(Intent(context, ProjectionService::class.java))
        CaptureAccessibilityService.instance?.stopCapture()
        Notifications.clear(context)
        Notifications.clearMedia(context)
        MediaCollection.clear(); MediaCollectionService.refresh()
        runCatching { UploadWorker.schedule(context, settings.read()) }
    }
}
