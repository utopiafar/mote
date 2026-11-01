package dev.mote.collector

/**
 * Shared read cadence for the home blocks. While the home is visible a block reads at most once
 * per [steadyMs]; failures back off exponentially up to [maxBackoffMs]; a 403 stops the block
 * until the session or authorization generation changes. Leaving and returning to the home reads
 * at once, but never revives a block that a 403 stopped. Stamps let a late response check whether
 * it still belongs to the current generation.
 */
internal class HomeReadGate(private val steadyMs: Long = 60_000, private val maxBackoffMs: Long = 300_000, private val probeRecheckMs: Long = 300_000) {
    @Volatile private var generation = -1L
    @Volatile private var origin = ""
    @Volatile private var epoch = 0L
    @Volatile private var nextRead = 0L
    @Volatile private var failures = 0
    @Volatile private var stopped = false
    @Volatile private var probeNext = 0L
    @Volatile private var probeDone = false
    @Volatile private var probeEmpty = false

    /**
     * Adopts the resolved connection identity. Returns true when the session or authorization
     * generation changed: pending stamps are dropped, a 403 stop is cleared and the next due
     * check reads at once.
     */
    fun adopt(accessGeneration: Long, server: String): Boolean {
        if (accessGeneration == generation && server == origin) return false
        generation = accessGeneration; origin = server
        epoch++; nextRead = 0; failures = 0; stopped = false
        probeNext = 0; probeDone = false; probeEmpty = false
        return true
    }

    fun due(now: Long) = !stopped && now >= nextRead

    /** Marks a read as started and returns the stamp its late result must still match. */
    fun begin(now: Long): Long {
        nextRead = now + steadyMs
        return epoch
    }

    /** A delayed result only applies while the generation that started it is still current. */
    fun current(stamp: Long) = stamp == epoch

    fun success(now: Long) { failures = 0; nextRead = now + steadyMs }
    fun failure(now: Long, status: Int?) {
        if (status == 403) { stopped = true; return }
        failures++; nextRead = now + minOf(maxBackoffMs, steadyMs shl minOf(failures, 3))
    }

    /** The home is no longer visible: in-flight results are stale and the next refresh reads at once. A 403 stop survives. */
    fun wake() { epoch++; nextRead = 0 }

    /** The connection could not be resolved or drifted mid-read: in-flight results are stale and the next refresh re-adopts identity. */
    fun invalidate() { epoch++; nextRead = 0 }

    /**
     * Empty-archive probe used while [rowsEmpty] holds. Once data is found the probe is not run
     * again this generation; an empty answer is rechecked at most every [probeRecheckMs]; an
     * inconclusive read retries on the next steady read. The last answer is reused between probes.
     */
    fun archiveEmpty(rowsEmpty: Boolean, now: Long, probe: () -> Boolean): Boolean {
        if (!rowsEmpty) return false
        if (!probeDone && now >= probeNext) {
            when (runCatching { probe() }.getOrNull()) {
                null -> probeNext = now + steadyMs
                false -> { probeDone = true; probeEmpty = false }
                true -> { probeNext = now + probeRecheckMs; probeEmpty = true }
            }
        }
        return probeEmpty
    }
}
