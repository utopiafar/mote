package dev.mote.collector

import java.util.concurrent.Executor

/** One running write plus the latest pending value; queued barriers run after both have drained. */
internal class LatestWriter<T : Any>(private val executor: Executor, private val write: (T) -> Unit) {
    private val lock = Any()
    private var pending: T? = null
    private var running = false
    fun submit(value: T) {
        val start = synchronized(lock) { pending = value; if (running) false else { running = true; true } }
        if (start) executor.execute {
            while (true) {
                val next = synchronized(lock) {
                    pending.also { pending = null; if (it == null) running = false }
                } ?: break
                // The owner reports persistence errors; one failure must not strand newer edits.
                write(next)
            }
        }
    }
}
