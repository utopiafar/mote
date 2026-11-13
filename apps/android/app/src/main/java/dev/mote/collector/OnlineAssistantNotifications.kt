package dev.mote.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Lives with the existing system-entries notification publisher. Polls only
 * while this process is alive; no push, Worker or timely background promise. */
internal class OnlineAssistantNotifications(context: Context, private val enabled: () -> Boolean) {
    private val app = context.applicationContext
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val preferences = app.getSharedPreferences("assistant-notification-cursor", Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    @Volatile private var closed = false
    private var started = false
    private var next = 0L
    private var connection: Pair<String, Long>? = null
    private val presenter = AssistantNoticePresenter(
        cursor = {
            val origin = preferences.getString("origin", null); val id = preferences.getString("id", null); val at = preferences.getString("eligibleAt", null)
            val shown = preferences.getLong("shownAt", 0L)
            if (origin != null && id != null && at != null && shown > 0) AssistantNoticeCursor(origin, id, at, shown) else null
        },
        save = { cursor -> check(preferences.edit().putString("origin", cursor.origin).putString("id", cursor.id)
            .putString("eligibleAt", cursor.eligibleAt).putLong("shownAt", cursor.shownAt).commit()) },
        post = { event ->
            check(!closed && enabled())
            val selected = CentralAccess.resolve(app)
            check(selected.client != null && connection == (selected.server to selected.generation))
            val open = PendingIntent.getActivity(app, ID, Intent(app, AssistantInboxActivity::class.java)
                .setIdentifier(selected.server + "/" + event.id + "/" + event.eligibleAt)
                .putExtra("origin", selected.server).putExtra("cardId", event.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            // System history can outlive this process. Never place a derived
            // title/reason there; the click reads the current authorized card.
            manager.notify(ID, Notification.Builder(app, CHANNEL).setSmallIcon(R.drawable.ic_mote).setContentTitle(MoteI18n.text("通知"))
                .setContentText(MoteI18n.text("打开 Mote")).setContentIntent(open)
                .setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).build())
        },
        cancel = { manager.cancel(ID) },
    )
    private val tick = object : Runnable {
        override fun run() {
            if (closed) return
            presenter.expire()
            if (!enabled()) presenter.clear()
            if (System.currentTimeMillis() >= next && busy.compareAndSet(false, true)) {
                next = System.currentTimeMillis() + 15000
                executor.execute {
                    try {
                        val selected = CentralAccess.resolve(app)
                        val key = selected.server to selected.generation
                        if (connection != key) { presenter.clear(); connection = key }
                        val client = selected.client
                        if (client == null || !enabled()) presenter.clear()
                        else {
                            val snapshot = AssistantNotificationReader(client).snapshot()
                            val current = CentralAccess.resolve(app)
                            if (!closed && enabled() && current.server == selected.server && current.generation == selected.generation && current.client != null) {
                                val allowed = manager.areNotificationsEnabled() && manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
                                presenter.update(selected.server, snapshot, allowed)
                            } else presenter.clear()
                        }
                    } catch (_: Exception) { presenter.clear() }
                    finally { busy.set(false) }
                }
            }
            handler.postDelayed(this, 1000)
        }
    }
    fun start() {
        if (started || closed) return
        started = true
        manager.createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("通知"), NotificationManager.IMPORTANCE_DEFAULT))
        // Never retain an OS summary from a previous process before validating
        // its current card, permission and session again.
        presenter.clear(); handler.post(tick)
    }
    fun close() { closed = true; handler.removeCallbacks(tick); presenter.clear(); executor.shutdownNow() }
    companion object { private const val ID = 4110; private const val CHANNEL = "mote_assistant" }
}
