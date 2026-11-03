package dev.mote.collector

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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
    val checkedAt: Long = 0,
    val sourceIssues: Int? = null,
    val sourceError: Boolean = false
) {
    val captureLabel: String get() = if (captureState == "capturing") MoteI18n.text("正在采集") else captureMessage
    val totalImages: Int? get() = active?.let { a -> quarantine?.let { a.images + it.images } }
    val pending: Int? get() = active?.let { a -> sourcePending?.let { a.pending + it } }
    fun imageLabel(): String = if (active == null || quarantine == null) { if (error == null) MoteI18n.text("本机图片数量正在读取") else MoteI18n.text("本机图片数量暂不可读取") } else
        MoteI18n.text("当前图片 {0} 张 · 采集区 {1} 张 · 待决定区 {2} 张", totalImages, active.images, quarantine.images) +
            if (error != null) MoteI18n.text("（上次结果，暂无法更新）") else ""
    fun storageLabel(): String = if (active == null || quarantine == null) imageLabel() else
        imageLabel() + MoteI18n.text("\n采集区 {0} 条记录 · 待同步 {1} 条 · 需处理 {2} 条", active.records, active.pending, active.blocked) +
            MoteI18n.text("\n采集区图片文件 {0} 个 · 待决定区图片文件 {1} 个", active.imageFiles, quarantine.imageFiles) +
            MoteI18n.text("\n本机队列 {0} · 待决定区 {1}", size(active.diskBytes), size(quarantine.diskBytes))
    private fun size(bytes: Long) = "%.1f MiB".format(bytes / 1048576.0)
}

/** Source read failures do not replace the independently read local queue snapshot. */
internal fun LocalStateSnapshot.withSources(load: () -> Pair<Int, Int>): LocalStateSnapshot {
    val result = runCatching(load)
    return copy(sourcePending = result.getOrNull()?.first, sourceIssues = result.getOrNull()?.second, sourceError = result.isFailure)
}
