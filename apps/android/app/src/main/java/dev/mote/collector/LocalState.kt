package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** Counts image-bearing records; physical blobs can be shared by multiple records. */
data class QueueInventory(
    val records: Int, val images: Int, val imageFiles: Int, val pending: Int,
    val awaitingOcr: Int, val blocked: Int, val diskBytes: Long, val reservedOcrBytes: Long
) { val quotaBytes: Long get() = diskBytes + reservedOcrBytes }

data class LocalRevision(val value: Long = 0, val records: Long = 0, val storage: Long = 0, val immediate: Boolean = false)

/** A replayed invalidation revision, never a counter delta or a durable source of truth. */
object LocalStateChanges {
    private val mutable = MutableStateFlow(LocalRevision())
    val revisions: StateFlow<LocalRevision> = mutable.asStateFlow()
    @Synchronized fun changed(records: Boolean = false, storage: Boolean = records, immediate: Boolean = false) {
        val old = mutable.value
        mutable.value = LocalRevision(old.value + 1, old.records + (if (records) 1 else 0), old.storage + (if (storage || immediate) 1 else 0), immediate)
    }
}

data class LocalStateSnapshot(
    val revision: LocalRevision = LocalRevision(),
    val active: QueueInventory? = null,
    val quarantine: QueueInventory? = null,
    val sourcePending: Int? = null,
    val captureState: String = "paused",
    val captureMessage: String = MoteI18n.text("尚未开始采集"),
    val syncMessage: String = MoteI18n.text("尚未上传"),
    val error: String? = null,
    val checkedAt: Long = 0
) {
    val captureLabel: String get() = if (captureState == "capturing") MoteI18n.text("正在采集") else captureMessage
    val totalImages: Int? get() = active?.let { a -> quarantine?.let { a.images + it.images } }
    val pending: Int? get() = active?.let { a -> sourcePending?.let { a.pending + it } }
    fun imageLabel(): String = if (active == null || quarantine == null) { if (error == null) MoteI18n.text("本机图片数量正在读取") else MoteI18n.text("本机图片数量暂不可读取") } else
        MoteI18n.text("当前图片 {0} 张 · 采集区 {1} 张 · 待决定区 {2} 张", totalImages, active.images, quarantine.images) +
            if (error != null) MoteI18n.text("（上次结果，暂无法更新）") else ""
    fun storageLabel(): String = if (active == null || quarantine == null) imageLabel() else
        imageLabel() + MoteI18n.text("\n采集区 {0} 条记录 · 待同步 {1} 条 · 等待 OCR {2} 张", active.records, active.pending, active.awaitingOcr) +
            MoteI18n.text("\n采集区图片文件 {0} 个 · 待决定区图片文件 {1} 个", active.imageFiles, quarantine.imageFiles) +
            MoteI18n.text("\n本机队列 {0} · OCR 预留 {1} · 待决定区 {2}", size(active.diskBytes), size(active.reservedOcrBytes), size(quarantine.diskBytes))
    private fun size(bytes: Long) = "%.1f MiB".format(bytes / 1048576.0)
}

/** One application-owned producer. No images, credentials or captured text enter this stream. */
class LocalStateRepository private constructor(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutable = MutableStateFlow(LocalStateSnapshot())
    val state: StateFlow<LocalStateSnapshot> = mutable.asStateFlow()
    private val preferences = app.getSharedPreferences("mote", Context.MODE_PRIVATE)
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> LocalStateChanges.changed() }
    init {
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        scope.launch {
            LocalStateChanges.revisions.collect { request ->
                // StateFlow conflates bursts. A fixed delay (not debounce) guarantees progress
                // during continuous writes and permits only one storage read at a time.
                if (!request.immediate) delay(300)
                val previous = mutable.value
                val next = try {
                    check(!QueueStorage.recovering) { MoteI18n.text("正在恢复本机存储") }
                    // Index upgrades inspect a few records per lock acquisition; starting capture
                    // must not wait behind decrypting an entire legacy library.
                    if (previous.active == null || previous.error != null || previous.revision.storage != LocalStateChanges.revisions.value.storage) {
                        app.queue().prepareIndex()
                        BulkDedupeStore(app).quarantine().prepareIndex()
                    }
                    val (revision, active, pending) = DurableQueue.exclusive {
                        val version = LocalStateChanges.revisions.value
                        if (previous.error == null && previous.active != null && previous.quarantine != null && previous.revision.storage == version.storage)
                            Triple(version, previous.active, previous.quarantine)
                        else Triple(version, app.queue().inventory(), BulkDedupeStore(app).quarantine().inventory())
                    }
                    val settings = Settings(app)
                    LocalStateSnapshot(revision, active, pending, app.localSources().pendingSync().count,
                        settings.state(), settings.message(), settings.uploadStatus(), checkedAt = System.currentTimeMillis())
                } catch (error: Exception) {
                    previous.copy(revision = LocalStateChanges.revisions.value, error = error.message ?: MoteI18n.text("本机状态暂不可读取"))
                }
                mutable.value = next
                // Notifications are a consumer even when no Activity is visible.
                withContext(Dispatchers.Main) { runCatching { Notifications.showLocalState(app, next) } }
            }
        }
    }
    fun refresh() = LocalStateChanges.changed(immediate = true)
    companion object {
        @Volatile private var instance: LocalStateRepository? = null
        fun get(context: Context): LocalStateRepository = instance ?: synchronized(this) {
            instance ?: LocalStateRepository(context).also { instance = it }
        }
    }
}

/** Platform Activities explicitly pair this subscription with onResume/onPause. */
fun Activity.observeLocalState(onState: (LocalStateSnapshot) -> Unit): Job {
    val repository = LocalStateRepository.get(this)
    repository.refresh() // Calibrate against storage after backgrounding or a missed process event.
    return CoroutineScope(Dispatchers.Main.immediate).launch {
        repository.state.collect { if (!isDestroyed && !isFinishing) onState(it) }
    }
}
