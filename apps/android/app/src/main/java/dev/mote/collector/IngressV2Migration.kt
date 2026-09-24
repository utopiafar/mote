package dev.mote.collector

import android.content.Context
import android.os.Looper
import java.io.File

/** One-time cutover of local work that was prepared for the retired ingress protocol.
 * The marker is committed last, so interruption repeats the cleanup before any uploader runs. */
object IngressV2Migration {
    private const val PREFS = "ingress-protocol"
    private const val KEY = "version"
    private val lock = Any()

    fun ensure(context: Context) = synchronized(lock) {
        val app = context.applicationContext
        val marker = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (marker.getInt(KEY, 0) >= 2) return@synchronized
        check(Looper.myLooper() != Looper.getMainLooper()) { MoteI18n.text("正在恢复本机存储，请稍候") }

        // Drop stage inputs before constructing DurableQueue: its constructor normally
        // replays them and could otherwise create another legacy event during cutover.
        val location = QueueStorage(app).current()
        val queueDirectory = File(location.path)
        listOf(".capture-stages.checkpoint", ".capture-stages.journal", ".capture-stages.inbox").forEach { name ->
            val file = File(queueDirectory, name)
            check(!file.exists() || file.delete()) { "Unable to discard legacy capture stage checkpoint" }
        }
        val cipher = app.localContentCipher()
        DurableQueue(queueDirectory, cipher, createMissing = false).discardLegacyOutbox()
        LocalSourceStore(File(app.noBackupFilesDir, "local-sources"), cipher).resetForProtocolUpgrade()
        FileArchiveQueue(File(app.noBackupFilesDir, "file-archives"), cipher).resetForProtocolUpgrade()
        NoteDraftStore(File(app.noBackupFilesDir, "note-draft"), cipher).clearPreparedForProtocolUpgrade()

        listOf("capture-upload-turns", "source-upload-turns", "bundle-capability", "sync-recovery", "sync-heartbeat", "central-perception")
            .forEach { name -> check(app.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()) { "Unable to reset legacy sync checkpoint" } }
        check(app.getSharedPreferences("mote", Context.MODE_PRIVATE).edit()
            .remove("lastSyncDispatch").remove("lastUploadAt").remove("lastUploadOrigin")
            .remove("syncState").remove("uploadStatus").commit()) { "Unable to reset legacy sync status" }
        check(marker.edit().putInt(KEY, 2).commit()) { "Unable to mark ingress protocol upgrade" }
        LocalStateChanges.changed(records = true, immediate = true)
    }
}
