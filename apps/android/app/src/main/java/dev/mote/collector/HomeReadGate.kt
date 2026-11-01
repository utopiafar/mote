package dev.mote.collector

import org.json.JSONObject

/**
 * Shared read cadence for the home blocks. While the home is visible a block reads at most once
 * per [steadyMs]; failures back off exponentially up to [maxBackoffMs]; a 403 stops the block
 * until the session or authorization generation changes or the owner explicitly retries through
 * [retry] — leaving and returning to the home never revives the stop on its own. Returning to the
 * home otherwise reads at once. Stamps let a late response check whether it still belongs to the
 * current generation.
 */
/**
 * Confirms the archive is really empty across storage, library and files. A malformed storage
 * count throws — an inconclusive probe retries on the next read rather than claiming data exists.
 */
internal object HomeArchiveProbe {
    fun empty(read: (String) -> JSONObject): Boolean {
        val storage = read("/api/status").getJSONObject("storage")
        check(storage.get("captures") is Number) { "storage.captures missing or not numeric" }
        return storage.getLong("captures") == 0L &&
            read("/api/library/catalog?limit=1").getJSONArray("items").length() == 0 &&
            read("/api/files?limit=1").getJSONArray("items").length() == 0
    }
}

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
    @Synchronized fun adopt(accessGeneration: Long, server: String): Boolean {
        if (accessGeneration == generation && server == origin) return false
        generation = accessGeneration; origin = server
        epoch++; nextRead = 0; failures = 0; stopped = false
        probeNext = 0; probeDone = false; probeEmpty = false
        return true
    }

    fun due(now: Long) = !stopped && now >= nextRead

    /** Marks a read as started and returns the stamp its late result must still match. */
    @Synchronized fun begin(now: Long): Long {
        nextRead = now + steadyMs
        return epoch
    }

    /** A delayed result only applies while the generation that started it is still current. */
    fun current(stamp: Long) = stamp == epoch

    @Synchronized fun success(now: Long) { failures = 0; nextRead = now + steadyMs }
    @Synchronized fun failure(now: Long, status: Int?) {
        if (status == 403) { stopped = true; return }
        failures++; nextRead = now + minOf(maxBackoffMs, steadyMs shl minOf(failures, 3))
    }

    /** The home is no longer visible: in-flight results are stale and the next refresh reads at once. A 403 stop survives. */
    @Synchronized fun wake() { epoch++; nextRead = 0 }

    /** The connection could not be resolved or drifted mid-read: in-flight results are stale and the next refresh re-adopts identity. */
    @Synchronized fun invalidate() { epoch++; nextRead = 0 }

    /**
     * Explicit owner retry (the failure affordance): clears a 403 stop so a permission repaired
     * server-side under the same session is re-checked on the next refresh, and re-arms the
     * empty-archive probe so a recovered probe may run again.
     */
    @Synchronized fun retry() { stopped = false; nextRead = 0; probeNext = 0; probeDone = false; probeEmpty = false }

    /**
     * Empty-archive probe used while [rowsEmpty] holds. Once data is found the probe is not run
     * again this generation; an empty answer is rechecked at most every [probeRecheckMs]; an
     * inconclusive answer clears the empty confirmation and retries on the next steady read; a
     * forbidden answer rethrows so the whole read takes its failure path — the stop itself is
     * applied by [failure] on the UI thread, so a pause between the probe and the callback can
     * never strand a stop without its retry control. The last answer is reused between
     * probes. [probe] runs off the gate lock so a slow read cannot block [adopt]; its answer is
     * committed only while [stamp] is still current, so a probe from an old generation can never
     * mark the new generation done.
     */
    fun archiveEmpty(rowsEmpty: Boolean, stamp: Long, now: Long, probe: () -> Boolean): Boolean {
        if (!rowsEmpty) return false
        val due = synchronized(this) { stamp == epoch && !probeDone && now >= probeNext }
        val result = if (due) runCatching { probe() } else null
        val forbidden = (result?.exceptionOrNull() as? CentralFailure)?.status == 403
        val empty = synchronized(this) {
            if (due && stamp == epoch && result != null && !forbidden) {
                when {
                    result.isFailure -> { probeNext = now + steadyMs; probeEmpty = false }
                    result.getOrThrow() -> { probeNext = now + probeRecheckMs; probeEmpty = true }
                    else -> { probeDone = true; probeEmpty = false }
                }
            }
            probeEmpty
        }
        // A denied probe fails the read so the caller renders its forbidden/retry path instead of a bogus empty answer.
        if (forbidden) throw result!!.exceptionOrNull()!!
        return empty
    }
}
