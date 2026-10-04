package dev.mote.collector

/** Uses observation clocks only; model/OCR/queue completion clocks are never inputs. */
internal object SamplingTime {
    fun interval(previousObservationMs: Long, observationMs: Long, maximumMs: Long): Long =
        if (observationMs < previousObservationMs) 0L else (observationMs - previousObservationMs).coerceAtMost(maximumMs)
}

/** Content transport (page or image) does not change an observed foreground interval. */
internal class ForegroundObservationClock {
    private data class Observation(val at: Long, val appId: String?, val mode: AppCollectionMode)
    private var previous: Observation? = null
    fun interval(now: Long, appId: String?, mode: AppCollectionMode, maximumMs: Long): Long {
        val old = previous ?: return 0L
        return if (old.appId == appId && old.mode == mode) SamplingTime.interval(old.at, now, maximumMs) else 0L
    }
    fun accept(now: Long, appId: String?, mode: AppCollectionMode) { previous = Observation(now, appId, mode) }
    fun reset() { previous = null }
}
