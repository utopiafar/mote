package dev.mote.collector

/** Blocking transport adapters recheck the current admission at the actual I/O
 * boundary, after request hooks and immediately before opening the connection. */
internal object TransferRequestGuard {
    private val guard = ThreadLocal<(() -> Unit)?>()
    fun check() { guard.get()?.invoke() }
    fun <T> within(requireCurrent: () -> Unit, action: () -> T): T {
        val previous = guard.get()
        guard.set { previous?.invoke(); requireCurrent() }
        try { check(); return action() } finally { if (previous == null) guard.remove() else guard.set(previous) }
    }
}
