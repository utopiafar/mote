package dev.mote.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.mote.collector.plugins.SystemEntriesPlugin

/** The capture status notification. The system entries plugin creates and owns
 * this publisher; when that scope is stopped no action is offered and the
 * reason stays visible. */
internal class Notifications(
    context: Context,
    private val gate: () -> SystemEntriesPlugin.Availability,
) {
    private val app = context.applicationContext
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val diagnosticsWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var lastPublished: String? = null
    private var initialized = false
    private var closed = false
    private var screenStatus: String? = null
    private var mediaStatus: String? = null
    private var eventStatus: String? = null
    private var localState: LocalStateSnapshot? = null

    private fun availability() = if (closed) SystemEntriesPlugin.Availability(false, MoteI18n.text("系统入口插件已停用；快捷入口和通知动作不可用。")) else gate()

    @Synchronized fun showLocalState(state: LocalStateSnapshot) {
        if (closed) return
        val changed = localState?.imageLabel() != state.imageLabel() || (screenStatus != null && screenStatus != state.captureLabel)
        localState = state
        if (screenStatus != null) screenStatus = state.captureLabel
        if (changed && (screenStatus != null || mediaStatus != null || eventStatus != null)) publish()
    }

    fun create() {
        if (!availability().active) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("采集状态"), NotificationManager.IMPORTANCE_LOW))
    }

    @Synchronized fun notification(text: String): Notification {
        screenStatus = text
        initialized = true; lastPublished = publicationText()
        manager.cancel(MEDIA_ID)
        return build()
    }

    private fun visibleText() = listOfNotNull(screenStatus?.let { MoteI18n.text("屏幕：{0}", it) }, mediaStatus?.let { MoteI18n.text("媒体：{0}", it) }, eventStatus, localState?.imageLabel()).joinToString("\n")

    private fun publicationText(): String? {
        val text = visibleText().ifBlank { null } ?: return null
        return SystemEntriesPlugin.surfaceText(availability(), text)
    }

    private fun diagnostics(name: String) {
        if (closed) return
        runCatching { diagnosticsWorker.execute { Diagnostics(app).add(name) } }
    }

    private fun build(): Notification {
        val availability = availability()
        val text = publicationText() ?: MoteI18n.text("采集状态")
        // The status panel opens on top of the existing task, so a draft or reader underneath stays where it was.
        val open = PendingIntent.getActivity(app, 0, Intent(app, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(app, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle(MoteI18n.text("Mote · 采集状态"))
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true)
        for (action in SystemEntriesPlugin.notificationActions(availability, screenStatus != null)) when (action) {
            SystemEntriesPlugin.Action.PAUSE_SCREEN -> builder.addAction(Notification.Action.Builder(null, MoteI18n.text("暂停屏幕采集"),
                PendingIntent.getBroadcast(app, 2, Intent(app, PauseScreenReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            SystemEntriesPlugin.Action.STOP_CAPTURE -> builder.addAction(Notification.Action.Builder(null, MoteI18n.text("停止采集"),
                PendingIntent.getBroadcast(app, 1, Intent(app, StopReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            SystemEntriesPlugin.Action.RECORD -> MoteQuickEntry.RECORD.pendingIntent(app)?.let { entry ->
                builder.addAction(Notification.Action.Builder(null, MoteQuickEntry.RECORD.label, entry).build())
            }
        }
        return builder.build()
    }

    @Synchronized fun show(text: String) { if (closed) return; screenStatus = text; publish() }
    @Synchronized fun clear() { if (closed) return; screenStatus = null; publish() }
    @Synchronized fun showMedia(text: String) { if (closed) return; mediaStatus = text; publish() }
    @Synchronized fun clearMedia() { if (closed) return; mediaStatus = null; publish() }
    @Synchronized fun showEvents(text: String?) { if (closed) return; eventStatus = text; publish() }

    private fun publish() {
        if (closed) { manager.cancel(MEDIA_ID); manager.cancel(ID); return }
        if (!initialized) { manager.cancel(MEDIA_ID); manager.cancel(ID); initialized = true }
        val text = publicationText()
        if (text == null) { manager.cancel(ID); lastPublished = null; diagnostics("notificationCancels"); return }
        if (text == lastPublished) return
        if (manager.areNotificationsEnabled()) { manager.notify(ID, build()); lastPublished = text; diagnostics("notificationPublishes") }
    }

    /** Idempotent: a stopped scope leaves no publisher, executor or status
     * notification behind. */
    @Synchronized fun close() {
        if (closed) return
        closed = true
        manager.cancel(ID); manager.cancel(MEDIA_ID)
        diagnosticsWorker.shutdownNow()
    }

    companion object {
        const val ID = 4101
        private const val MEDIA_ID = 4102
        private const val CHANNEL = "mote_capture"
    }
}

/** The publisher installed by the system entries plugin. */
internal fun Context.systemEntries(): Notifications = SystemEntriesPlugin.notifications(this)

class StopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = holdUntilDone { done -> dev.mote.collector.plugins.CapturePlugin.controls().stopAll(context) { done() } }
}
