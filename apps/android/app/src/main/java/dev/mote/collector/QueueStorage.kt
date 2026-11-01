package dev.mote.collector

import android.content.Context
import android.os.Environment
import java.io.File

data class QueueStorageChoice(val id: String, val title: String, val base: File, val availableBytes: Long)

class QueueStorage(private val context: Context) {
    companion object {
        @Volatile internal var recovering = false
        /** Rebuildable index/orphan maintenance; never a capture authorization gate. */
        @Volatile internal var maintaining = false
        @Volatile internal var recoveryFailure: String? = null
    }
    private fun requireUiReady() {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            check(!recovering) { MoteI18n.text("正在恢复本机存储，请稍候") }
            check(recoveryFailure == null) { recoveryFailure ?: MoteI18n.text("本机存储恢复失败") }
        }
    }
    fun choices(): List<QueueStorageChoice> = buildList {
        add(QueueStorageChoice("internal", MoteI18n.text("内部应用空间"), context.noBackupFilesDir, context.noBackupFilesDir.usableSpace))
        context.getExternalFilesDirs(null).filterNotNull().forEachIndexed { index, base ->
            if (Environment.getExternalStorageState(base) == Environment.MEDIA_MOUNTED) {
                val id = "external:${SourceRules.hash(base.absolutePath)}"
                add(QueueStorageChoice(id, if (Environment.isExternalStorageRemovable(base)) MoteI18n.text("存储卡应用空间 {0}", index + 1) else MoteI18n.text("本机存储应用空间"), base, base.usableSpace))
            }
        }
    }
    private fun store() = QueueLocationStore(context.noBackupFilesDir, File(context.noBackupFilesDir, "queue"), context.localContentCipher(), validate = { location ->
        val choice = choices().singleOrNull { it.id == location.baseId } ?: error(MoteI18n.text("所选存储介质不可用，请重新连接；不会切换为空目录"))
        val path = File(location.path)
        check(path.parentFile?.canonicalFile == choice.base.canonicalFile &&
            (path.name == "queue" && choice.id == "internal" || path.name == "mote-queue-${location.id}")) { MoteI18n.text("存储路径不在本应用授权空间内") }
    }, syncDirectory = { directory ->
        val descriptor = android.system.Os.open(directory.absolutePath, android.system.OsConstants.O_RDONLY, 0)
        try { check(android.system.OsConstants.S_ISDIR(android.system.Os.fstat(descriptor).st_mode)); android.system.Os.fsync(descriptor) } finally { android.system.Os.close(descriptor) }
    })
    fun selected(): QueueLocation { requireUiReady(); return DurableQueue.exclusive { store().selected() } }
    fun current(): QueueLocation { requireUiReady(); return DurableQueue.exclusive { store().current().also { recoveryFailure = null } } }
    /** Accepted stage work that still needs replay; a cheap file presence check, never an open. */
    fun stageRecoveryPending(): Boolean = DurableQueue.exclusive {
        val path = store().current().path
        File(path, ".capture-stages.inbox").exists() || File(path, ".capture-stages.journal").exists()
    }
    fun migrate(id: String): QueueLocation = DurableQueue.exclusive {
        val target = choices().singleOrNull { it.id == id } ?: error(MoteI18n.text("所选目标存储暂不可用"))
        try { store().migrate(target.id, target.base, RuntimeSettings::reportProgress) } finally { LocalStateChanges.changed(records = true) }
    }
    fun openQueue(): DurableQueue {
        requireUiReady()
        LocalDataFormat.requireCurrent(context)
        return DurableQueue.exclusive {
        val state = store(); val location = state.current()
        // The mutation listener is installed at construction so even a replay committed — or a
        // construction that fails partway — still reports its record writes.
        DurableQueue(File(location.path), context.localContentCipher(), createMissing = false,
            initialOnMutation = { LocalStateChanges.changed(records = it, storage = true) }) { kind, bytes, id -> Operations.record(context, kind, bytes = bytes, recordId = id) }
            .apply { externalStorageBytes = { recordOriginalDiskBytes(context) }; assertCurrent = { state.assertCurrent(location) }
                if (unreportedRecordWrites) { unreportedRecordWrites = false; LocalStateChanges.changed(records = true) }
                recoveryFailure = null }
        }
    }
}

internal fun recordOriginalDiskBytes(context: Context): Long = File(context.noBackupFilesDir, "record-draft").listFiles().orEmpty().filter { it.isFile }.sumOf { it.length() } + File(context.filesDir, "record-pending").listFiles().orEmpty().filter { it.isFile }.sumOf { it.length() }
