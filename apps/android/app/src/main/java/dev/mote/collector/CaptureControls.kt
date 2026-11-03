package dev.mote.collector

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pauses shared by the home, the status panel, the notification and Quick Settings. Screen capture, all capture and
 * sending stay independent. Nothing here starts capture: resuming returns to the app's preview and system consent.
 */
internal object CaptureControls {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    /** A temporary privacy pause of screen capture only; other sources and sending continue. */
    fun pauseScreen(context: Context, finished: (Result<Boolean>) -> Unit = {}) {
        val app = context.applicationContext
        worker.execute {
            val current = runCatching { Settings(app).let { it to it.read() } }
            main.post {
                val (settings, config) = current.getOrElse { finished(Result.failure(it)); return@post }
                if (!settings.enabled || !config.screenCollectionEnabled || RuntimeSettings.stopping) { finished(Result.success(false)); return@post }
                settings.screenPaused(System.currentTimeMillis())
                RuntimeSettings.apply(app, config.copy(screenCollectionEnabled = false), expected = config) { result ->
                    if (result.isFailure) settings.screenPaused(null)
                    finished(result.map { true })
                }
            }
        }
    }
    /** Stops every capture source for the panel and the notification; records and sending are kept. */
    fun stopAll(context: Context, finished: (Result<Unit>) -> Unit = {}) {
        val app = context.applicationContext
        RuntimeSettings.cancelProjectionConsentRequest()
        // Joining a stop under way still reports only after that stop and this status are saved.
        RuntimeSettings.stop(app) { result ->
            app.systemEntries().showEvents(null)
            if (result.isFailure) { finished(result); return@stop }
            worker.execute {
                runCatching {
                    val settings = Settings(app)
                    if (!settings.enabled) { settings.status("paused", MoteI18n.text("你已停止采集，已有记录保留，同步按所选策略运行")); UploadWorker.schedule(app, settings.read()) }
                }
                main.post { finished(result) }
            }
        }
    }
    /** Sending pause keeps local saving and capture running. */
    fun setSendingPaused(context: Context, paused: Boolean, finished: (Result<Unit>) -> Unit = {}) {
        val app = context.applicationContext
        worker.execute { val result = runCatching { SendPauseControl.set(app, paused) }; main.post { finished(result) } }
    }
    /** Read off the main thread: active means screen capture is selected and capture is on. */
    fun screenState(context: Context, done: (active: Boolean, paused: Boolean, live: Boolean) -> Unit) {
        val app = context.applicationContext
        worker.execute {
            val read = runCatching {
                val settings = Settings(app); val config = settings.read()
                val live = config.screenCollectionEnabled && if (config.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected
                Triple(settings.enabled && config.screenCollectionEnabled, settings.screenPausedAt() != null && !config.screenCollectionEnabled, live)
            }.getOrDefault(Triple(false, false, false))
            main.post { done(read.first, read.second, read.third) }
        }
    }
}

/**
 * Keeps a notification action's broadcast, and so the process, until its work is saved. Work past the broadcast limit is
 * released instead of ending as a background ANR; it only runs that long while capture is on, whose service also keeps
 * the process.
 */
internal fun BroadcastReceiver.holdUntilDone(work: (done: () -> Unit) -> Unit) {
    val pending = goAsync()
    val main = Handler(Looper.getMainLooper())
    val released = AtomicBoolean()
    val release = Runnable { if (released.compareAndSet(false, true)) pending.finish() }
    main.postDelayed(release, 9_000)
    work { main.removeCallbacks(release); release.run() }
}

/** The notification action. Like the stop action, it runs only on the owner's tap. */
class PauseScreenReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = holdUntilDone { done -> CaptureControls.pauseScreen(context) { done() } }
}

/** Quick Settings pauses screen capture in one tap. Starting or resuming opens the app instead. */
class ScreenCaptureTileService : TileService() {
    override fun onStartListening() { super.onStartListening(); refresh() }
    override fun onClick() {
        super.onClick()
        // Decide from the saved state at click time; the tile may not have been listening before this click.
        CaptureControls.screenState(this) { capturing, _, _ ->
            if (capturing) CaptureControls.pauseScreen(this) { refresh() } else if (isLocked) unlockAndRun { openStatus() } else openStatus()
        }
    }
    private fun refresh() {
        CaptureControls.screenState(this) { capturing, paused, live ->
            val tile = qsTile ?: return@screenState
            tile.state = if (capturing) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            tile.label = MoteI18n.text("屏幕采集")
            tile.subtitle = MoteI18n.text(if (capturing && live) "采集中" else if (capturing) "需要处理" else if (paused) "已暂停" else "关闭")
            tile.contentDescription = MoteI18n.text(if (capturing) "暂停屏幕采集" else "采集状态")
            tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_screen)
            tile.updateTile()
        }
    }
    // Android 10–13 only offer the Intent form; Android 14+ uses the PendingIntent form below.
    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openStatus() {
        val intent = Intent(this, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 300, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
    }
}
