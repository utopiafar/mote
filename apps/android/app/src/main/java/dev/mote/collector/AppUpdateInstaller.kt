package dev.mote.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.util.UUID

/** Only replacement installation sessions; there is deliberately no uninstall or data-clear path. */
object AppUpdateInstaller {
    private const val CHANNEL = "mote_app_update"
    private const val NOTIFICATION = 4108
    private val installLock = Any()
    @Volatile private var liveTicket: String? = null
    internal fun <T> withoutActiveInstall(context: Context, action: () -> T): T = synchronized(installLock) {
        if (AppUpdateStore(context).prefs.getBoolean("installRequestActive", false)) throw UpdateFailure("install_pending")
        action()
    }
    fun request(context: Context): String = synchronized(installLock) {
        val store = AppUpdateStore(context)
        if (store.prefs.getBoolean("installRequestActive", false)) throw UpdateFailure("install_pending")
        UUID.randomUUID().toString().also { ticket ->
            liveTicket = ticket; store.prefs.edit().putString("installTicket", ticket).putBoolean("installRequestActive", true).commit(); store.state("preparing")
        }
    }
    private fun current(store: AppUpdateStore, ticket: String) = store.prefs.getBoolean("installRequestActive", false) && store.prefs.getString("installTicket", "") == ticket
    private fun requireCurrent(store: AppUpdateStore, ticket: String) { if (!current(store, ticket)) throw UpdateFailure("cancelled") }
    internal fun stage(context: Context, ticket: String, beforeCreate: (() -> Unit)? = null): Int {
        val store = AppUpdateStore(context)
        requireCurrent(store, ticket)
        try { return store.locked {
            requireCurrent(store, ticket)
            if (!context.packageManager.canRequestPackageInstalls()) throw UpdateFailure("install_permission")
            val asset = store.candidate()?.second ?: throw UpdateFailure("asset_missing")
            val file = store.apk(asset); AndroidUpdateVerifier.verify(context, file, asset)
            beforeCreate?.invoke()
            val installer = context.packageManager.packageInstaller
            val previous = store.prefs.getInt("sessionId", -1)
            if (previous >= 0 && installer.mySessions.any { it.sessionId == previous }) throw UpdateFailure("install_pending")
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName); setSize(asset.size)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
            val nonce = UUID.randomUUID().toString()
            val id = synchronized(installLock) {
                requireCurrent(store, ticket)
                installer.createSession(params).also { id ->
                    store.prefs.edit().putInt("sessionId", id).putString("sessionNonce", nonce).putLong("installVersionCode", asset.versionCode).commit(); store.state("staging")
                }
            }
            try {
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, asset.size).use { out -> file.inputStream().use { it.copyTo(out) }; session.fsync(out) }
                    val callback = Intent(context, AppUpdateResultReceiver::class.java).setAction(context.packageName + ".UPDATE_RESULT").putExtra("moteNonce", nonce)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                    val pending = PendingIntent.getBroadcast(context, id, callback, flags)
                    synchronized(installLock) { requireCurrent(store, ticket); store.state("install_pending"); session.commit(pending.intentSender) }
                }
                id
            } catch (e: Exception) {
                runCatching { installer.abandonSession(id) }
                synchronized(installLock) { if (store.prefs.getInt("sessionId", -1) == id) store.prefs.edit().remove("sessionId").remove("sessionNonce").commit() }
                throw e
            }
        } } catch (e: Exception) {
            synchronized(installLock) { if (current(store, ticket)) { store.prefs.edit().putBoolean("installRequestActive", false).commit(); liveTicket = null; store.state((e as? UpdateFailure)?.code ?: "install_failed") } }; throw e
        }
    }
    fun cancelSession(context: Context) {
        val store = AppUpdateStore(context)
        val id = synchronized(installLock) {
            val id = store.prefs.getInt("sessionId", -1)
            store.prefs.edit().putString("installTicket", UUID.randomUUID().toString()).putBoolean("installRequestActive", false).remove("sessionId").remove("sessionNonce").commit(); liveTicket = null; store.state("cancelled"); id
        }
        if (id >= 0 && context.packageManager.packageInstaller.mySessions.any { it.sessionId == id }) context.packageManager.packageInstaller.abandonSession(id)
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
    }
    fun reconcile(context: Context) {
        val store = AppUpdateStore(context); val target = store.prefs.getLong("installVersionCode", 0)
        if (target > 0 && AndroidUpdateVerifier.installed(context).longVersionCode >= target) {
            store.prefs.edit().remove("sessionId").remove("sessionNonce").remove("installVersionCode").putBoolean("installRequestActive", false).commit(); store.state("installed"); liveTicket = null
            context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
        } else if (store.prefs.contains("sessionId") && context.packageManager.packageInstaller.mySessions.none { it.sessionId == store.prefs.getInt("sessionId", -1) }) {
            store.prefs.edit().remove("sessionId").remove("sessionNonce").putBoolean("installRequestActive", false).commit(); store.state("install_failed"); liveTicket = null
        } else if (store.prefs.getBoolean("installRequestActive", false) && !store.prefs.contains("sessionId") && liveTicket != store.prefs.getString("installTicket", null)) {
            store.prefs.edit().putBoolean("installRequestActive", false).commit(); store.state("install_failed")
        }
    }
    fun confirmation(context: Context, intent: Intent, sessionId: Int) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, MoteI18n.text("应用更新"), NotificationManager.IMPORTANCE_DEFAULT))
        val action = intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(context, sessionId, action, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (manager.areNotificationsEnabled()) manager.notify(NOTIFICATION, Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_mote)
            .setContentTitle(MoteI18n.text("Mote 更新需要系统确认")).setContentText(MoteI18n.text("点按继续安装；取消不会删除已有数据")).setContentIntent(pending).setAutoCancel(true).build())
        if (AppUpdatesActivity.foreground) runCatching { context.startActivity(action) }
    }
}

class AppUpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = AppUpdateStore(context); val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (intent.action != context.packageName + ".UPDATE_RESULT" || id < 0 || id != store.prefs.getInt("sessionId", -2) || intent.getStringExtra("moteNonce") != store.prefs.getString("sessionNonce", null)) return
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirmation = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                store.state("awaiting_user")
                if (confirmation != null) AppUpdateInstaller.confirmation(context, confirmation, id)
            }
            PackageInstaller.STATUS_SUCCESS -> { store.state("installed"); store.prefs.edit().remove("sessionId").remove("sessionNonce").putBoolean("installRequestActive", false).commit() }
            else -> { store.state(if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, 0) == PackageInstaller.STATUS_FAILURE_ABORTED) "cancelled" else "install_failed"); store.prefs.edit().remove("sessionId").remove("sessionNonce").putBoolean("installRequestActive", false).commit() }
        }
    }
}
