package dev.mote.collector

/** WorkManager persists progress in SQLite; fast loops must not issue one write per image. */
internal class BulkDedupeProgress(private val intervalMs: Long = 250) {
    private var lastStage: String? = null
    private var lastAt = Long.MIN_VALUE

    fun shouldPublish(stage: String, done: Int, total: Int, now: Long): Boolean {
        if (stage == lastStage && done < total && now - lastAt < intervalMs) return false
        lastStage = stage
        lastAt = now
        return true
    }
}

/** Only compact features survive an iteration. Shared content is decoded once within this bound. */
internal class BulkDedupeFeatureCache(private val capacity: Int = 64) {
    data class Entry(val features: ScreenshotDedupeHelper.FrameFeatures, val imageBytes: Int)
    private val entries = object : LinkedHashMap<String, Entry>(capacity, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) = size > capacity
    }

    init { require(capacity > 0) }

    fun getOrPut(blob: String, load: () -> Entry): Entry = entries[blob] ?: load().also { entries[blob] = it }
}
