package dev.mote.collector

/** Uses observation clocks only; model/OCR/queue completion clocks are never inputs. */
internal object SamplingTime {
    fun interval(previousObservationMs: Long, observationMs: Long, maximumMs: Long): Long =
        if (observationMs < previousObservationMs) 0L else (observationMs - previousObservationMs).coerceAtMost(maximumMs)
}
