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
import dev.mote.collector.plugins.CapturePlugin
import java.util.concurrent.atomic.AtomicBoolean

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
    override fun onReceive(context: Context, intent: Intent) = holdUntilDone { done -> CapturePlugin.controls().pauseScreen(context) { done() } }
}

/** Quick Settings pauses screen capture in one tap. Starting or resuming opens the app instead. */
class ScreenCaptureTileService : TileService() {
    override fun onStartListening() { super.onStartListening(); refresh() }
    override fun onClick() {
        super.onClick()
        // Decide from the saved state at click time; the tile may not have been listening before this click.
        CapturePlugin.controls().screenState(this) { capturing, _, _ ->
            if (capturing) CapturePlugin.controls().pauseScreen(this) { refresh() } else if (isLocked) unlockAndRun { openStatus() } else openStatus()
        }
    }
    private fun refresh() {
        CapturePlugin.controls().screenState(this) { capturing, paused, live ->
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
