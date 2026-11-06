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

// Android 10–13 only offer the Intent form; Android 14+ uses the PendingIntent form below.
@android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
private fun TileService.openStatus() {
    val intent = Intent(this, CaptureStatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val open = {
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 300, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
    }
    if (isLocked) unlockAndRun { open() } else open()
}

/** Quick Settings pauses screen capture in one tap. Starting or resuming opens the app instead. */
class ScreenCaptureTileService : TileService() {
    override fun onStartListening() { super.onStartListening(); refresh() }
    override fun onClick() {
        super.onClick()
        // Decide from the saved state at click time; the tile may not have been listening before this click.
        CapturePlugin.controls().overviewFacts(this) { facts ->
            if (facts != null && facts.enabled && facts.screenSelected) CapturePlugin.controls().pauseScreen(this) { refresh() } else openStatus()
        }
    }
    private fun refresh() {
        CapturePlugin.controls().overviewFacts(this) { facts ->
            val tile = qsTile ?: return@overviewFacts
            val face = CaptureTiles.screen(facts?.let(CaptureOverview::statusFacts))
            tile.state = if (face.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            tile.label = MoteI18n.text("屏幕采集")
            tile.subtitle = face.subtitle
            tile.contentDescription = MoteI18n.text(if (face.active) "暂停屏幕采集" else "采集状态")
            tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_screen)
            tile.updateTile()
        }
    }
}

/** Quick Settings pauses or resumes sending in one tap. With no configured central it only opens the status panel. */
class SendPauseTileService : TileService() {
    override fun onStartListening() { super.onStartListening(); refresh() }
    override fun onClick() {
        super.onClick()
        CapturePlugin.controls().overviewFacts(this) { facts ->
            if (facts != null && facts.connected) CapturePlugin.controls().setSendingPaused(this, !facts.sendPaused) { refresh() } else openStatus()
        }
    }
    private fun refresh() {
        CapturePlugin.controls().overviewFacts(this) { facts ->
            val tile = qsTile ?: return@overviewFacts
            val face = CaptureTiles.send(
                facts?.connected == true, facts?.sendPaused == true, facts?.sendState in setOf("error", "blocked")
            )
            tile.state = if (face.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            tile.label = MoteI18n.text("暂停发送")
            tile.subtitle = face.subtitle
            tile.contentDescription = MoteI18n.text(
                when {
                    facts?.connected != true -> "发送状态"
                    face.active -> "恢复全部发送"
                    else -> "暂停发送"
                }
            )
            tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_send)
            tile.updateTile()
        }
    }
}
