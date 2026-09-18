package dev.mote.collector

/** Actual request-body writes, including JSON/base64 overhead, averaged over two seconds. */
object UploadMeter {
    private val samples = java.util.ArrayDeque<Pair<Long, Long>>()
    @Synchronized fun add(bytes: Long, now: Long = android.os.SystemClock.elapsedRealtime()) {
        trim(now); samples.addLast(now to bytes)
    }
    private fun trim(now: Long) { while (samples.isNotEmpty() && now - samples.first.first >= 2000) samples.removeFirst() }
    @Synchronized fun rate(now: Long = android.os.SystemClock.elapsedRealtime()): Double { trim(now); return samples.sumOf { it.second } / 2.0 }
    fun label(): String = "%.1f KiB/s".format(java.util.Locale.ROOT, rate() / 1024)
}
