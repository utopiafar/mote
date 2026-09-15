package dev.mote.collector

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

object Notifications {
    const val ID = 4101
    private const val MEDIA_ID = 4102
    private var screenStatus: String? = null
    private var mediaStatus: String? = null
    private var eventStatus: String? = null
    private var localState: LocalStateSnapshot? = null
    @Synchronized fun showLocalState(context: Context, state: LocalStateSnapshot) {
        val changed = localState?.imageLabel() != state.imageLabel() || (screenStatus != null && screenStatus != state.captureLabel)
        localState = state
        if (screenStatus != null) screenStatus = state.captureLabel
        if (changed && (screenStatus != null || mediaStatus != null || eventStatus != null)) publish(context)
    }
    private const val CHANNEL = "mote_capture"
    fun create(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "采集状态", NotificationManager.IMPORTANCE_LOW))
    }
    @Synchronized fun notification(context: Context, text: String): Notification {
        screenStatus = text
        return build(context)
    }
    private fun build(context: Context): Notification {
        val text = listOfNotNull(screenStatus?.let { "屏幕：$it" }, mediaStatus?.let { "媒体：$it" }, eventStatus, localState?.imageLabel()).joinToString("\n")
        // Launcher semantics bring the existing task (including a detail screen) forward.
        val open = PendingIntent.getActivity(context, 0, Intent.makeMainActivity(android.content.ComponentName(context, MainActivity::class.java)), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getBroadcast(context, 1, Intent(context, StopReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle("Mote · 采集状态")
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).addAction(Notification.Action.Builder(null, "停止采集", stop).build()).build()
    }
    @Synchronized fun show(context: Context, text: String) { screenStatus = text; publish(context) }
    @Synchronized fun clear(context: Context) { screenStatus = null; publish(context) }
    @Synchronized fun showMedia(context: Context, text: String) { mediaStatus = text; publish(context) }
    @Synchronized fun clearMedia(context: Context) { mediaStatus = null; publish(context) }
    @Synchronized fun showEvents(context: Context, text: String?) { eventStatus = text; publish(context) }
    private fun publish(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(MEDIA_ID) // Remove the separate notification left by older versions.
        if (screenStatus == null && mediaStatus == null && eventStatus == null) manager.cancel(ID)
        else if (manager.areNotificationsEnabled()) manager.notify(ID, build(context))
    }
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
        Notifications.showEvents(context, null)
        MediaCollection.clear(); MediaCollectionService.refresh()
        runCatching { UploadWorker.schedule(context, settings.read()) }
    }
}
