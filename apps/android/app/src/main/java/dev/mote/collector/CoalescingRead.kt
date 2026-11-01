package dev.mote.collector

import java.util.concurrent.Executor

/**
 * At most one read in flight and one merged follow-up: every request while a read runs collapses
 * into a single queued re-read that observes the latest state. Delivery happens under the state
 * lock so [close] is a hard boundary — a read finishing after close is discarded, never delivered,
 * and a runnable queued before close does not even begin reading. Executor rejections and
 * delivery failures reset the in-flight flag instead of sticking busy.
 */
internal class CoalescingRead<T>(private val executor: Executor, private val deliver: (Result<T>) -> Unit, private val read: () -> T) {
    private val lock = Any()
    private var inFlight = false
    private var again = false
    private var closed = false

    fun request() {
        val start = synchronized(lock) { if (closed) false else if (inFlight) { again = true; false } else { inFlight = true; true } }
        if (start) dispatch()
    }

    private fun dispatch() {
        try { executor.execute(::run) }
        catch (failure: RuntimeException) {
            synchronized(lock) {
                if (!closed) runCatching { deliver(Result.failure(failure)) }
                // A rejecting executor cannot accept a follow-up either. Drop that
                // pending retry and let the next requested refresh try again.
                again = false; inFlight = false
            }
        }
    }

    private fun run() {
        synchronized(lock) { if (closed) { inFlight = false; return } }
        val result = runCatching(read)
        val rerun = synchronized(lock) {
            if (!closed) runCatching { deliver(result) }
            // Delivery can itself request another read. Keep this reservation
            // through delivery and hand it directly to one merged follow-up.
            if (again && !closed) { again = false; true }
            else { again = false; inFlight = false; false }
        }
        if (rerun) dispatch()
    }

    fun close() = synchronized(lock) { closed = true; again = false }
}
