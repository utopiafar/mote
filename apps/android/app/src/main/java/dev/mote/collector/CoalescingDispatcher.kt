package dev.mote.collector

import java.util.concurrent.Executor

/** At most one running request and one merged follow-up, even while storage is blocked. */
internal class CoalescingDispatcher<T : Any>(private val executor: Executor, private val merge: (T, T) -> T, private val action: (T) -> Unit) {
    private val lock = Any()
    private var running = false
    private var pending: T? = null
    fun submit(request: T) {
        val start = synchronized(lock) {
            pending = pending?.let { merge(it, request) } ?: request
            if (running) false else { running = true; true }
        }
        if (start) dispatch()
    }
    private fun dispatch() {
        try { executor.execute(::runNext) }
        catch (error: RuntimeException) { synchronized(lock) { running = false }; throw error }
    }
    private fun runNext() {
        val request = synchronized(lock) { pending!!.also { pending = null } }
        try { action(request) }
        finally {
            val again = synchronized(lock) { if (pending != null) true else { running = false; false } }
            if (again) dispatch()
        }
    }
}

/** Explicit intent is retained only while the connection and synchronization policy match. */
internal data class ScheduleIntent(val stamp: String, val explicit: Boolean = false, val manualScan: Boolean = false) {
    fun merge(next: ScheduleIntent): ScheduleIntent = if (stamp != next.stamp) next else
        next.copy(explicit = explicit || next.explicit, manualScan = manualScan || next.manualScan)
}
