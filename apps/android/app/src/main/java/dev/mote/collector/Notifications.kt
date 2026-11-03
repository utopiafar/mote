package dev.mote.collector

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

object Notifications {
    private val diagnosticsWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    const val ID = 4101
    private const val MEDIA_ID = 4102
    private var lastPublished: String? = null
    private var initialized = false
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
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("采集状态"), NotificationManager.IMPORTANCE_LOW))
    }
    @Synchronized fun notification(context: Context, text: String): Notification {
        screenStatus = text
        initialized = true; lastPublished = visibleText()
        context.getSystemService(NotificationManager::class.java).cancel(MEDIA_ID)
        return build(context)
    }
    private fun visibleText() = listOfNotNull(screenStatus?.let { MoteI18n.text("屏幕：{0}", it) }, mediaStatus?.let { MoteI18n.text("媒体：{0}", it) }, eventStatus, localState?.imageLabel()).joinToString("\n")
    private fun build(context: Context): Notification {
        val text = visibleText()
        // The status panel opens on top of the existing task, so a draft or reader underneath stays where it was.
        val open = PendingIntent.getActivity(context, 0, Intent(context, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        // A quick privacy pause stops only the screen; without screen capture the only choice is the existing full stop.
        val pause = if (screenStatus != null) Notification.Action.Builder(null, MoteI18n.text("暂停屏幕采集"),
            PendingIntent.getBroadcast(context, 2, Intent(context, PauseScreenReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
            else Notification.Action.Builder(null, MoteI18n.text("停止采集"),
            PendingIntent.getBroadcast(context, 1, Intent(context, StopReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
        val record = Notification.Action.Builder(null, MoteQuickEntry.RECORD.label, MoteQuickEntry.RECORD.pendingIntent(context)).build()
        return Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle(MoteI18n.text("Mote · 采集状态"))
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).addAction(pause).addAction(record).build()
    }
    @Synchronized fun show(context: Context, text: String) { screenStatus = text; publish(context) }
    @Synchronized fun clear(context: Context) { screenStatus = null; publish(context) }
    @Synchronized fun showMedia(context: Context, text: String) { mediaStatus = text; publish(context) }
    @Synchronized fun clearMedia(context: Context) { mediaStatus = null; publish(context) }
    @Synchronized fun showEvents(context: Context, text: String?) { eventStatus = text; publish(context) }
    private fun publish(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!initialized) { manager.cancel(MEDIA_ID); manager.cancel(ID); initialized = true }
        val text = if (screenStatus == null && mediaStatus == null && eventStatus == null) null else visibleText()
        if (text == lastPublished) return
        if (text == null) { manager.cancel(ID); lastPublished = null; diagnosticsWorker.execute { Diagnostics(context.applicationContext).add("notificationCancels") } }
        else if (manager.areNotificationsEnabled()) { manager.notify(ID, build(context)); lastPublished = text; diagnosticsWorker.execute { Diagnostics(context.applicationContext).add("notificationPublishes") } }
    }
}

class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = holdUntilDone { done -> dev.mote.collector.plugins.CapturePlugin.controls().stopAll(context) { done() } }
}
