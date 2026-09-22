package dev.mote.collector

/** Cooperative request budget. A request already in flight finishes before the next turn. */
internal class UploadSlice(
    private val maxBytes: Long = 4L * 1024 * 1024,
    private val maxRequests: Int = 64,
    private val maxMillis: Long = 15_000,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 }
) {
    private val started = now()
    var bytes: Long = 0; private set
    var requests: Int = 0; private set
    val exhausted: Boolean get() = requests > 0 && (bytes >= maxBytes || requests >= maxRequests || now() - started >= maxMillis)
    fun admit(size: Int): Boolean { if (exhausted) return false; record(size.toLong()); return true }
    fun record(size: Long, count: Int = 1) { require(size >= 0 && count >= 0); bytes += size; requests += count }
}
internal fun <T> rotateUploadSources(items: List<T>, after: String?, id: (T) -> String): List<T> {
    val index = items.indexOfFirst { id(it) == after }
    return if (index < 0 || index + 1 == items.size) items else items.drop(index + 1) + items.take(index + 1)
}
