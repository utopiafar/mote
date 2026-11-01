package dev.mote.collector

/**
 * A count alone never proves what changed: an equal count can hide a swap or a
 * same-batch delete, and a larger count can still include removals or rewrites.
 * QueueStorage installs its callback before constructor replay. Each event-file
 * commit/delete notifies independently, including inside a deferred-index batch;
 * other invalidations can add notifications, never subtract physical mutations.
 * Thus equal positive revision/count deltas are a conservative insert candidate,
 * not a durable row counter. The caller must ALSO prove that page one contains
 * every candidate insertion. Backdated or larger bursts otherwise need a full read.
 */
internal class LibraryRefreshPolicy(revision: Long? = null, count: Int? = null) {
    enum class Action { INCREMENTAL, FULL }
    private var lastRevision: Long? = revision
    private var lastCount: Int? = count
    var insertions: Int = 0; private set
    fun baseline(revision: Long, count: Int?) { lastRevision = revision; lastCount = count }
    fun recordsChanged(revision: Long, count: Int?): Action {
        val previousRevision = lastRevision; val previousCount = lastCount
        lastRevision = revision; lastCount = count
        val mutations = if (previousRevision == null) null else revision - previousRevision
        val delta = if (previousCount == null || count == null) null else (count - previousCount).toLong()
        insertions = if (mutations != null && mutations == delta && delta > 0 && delta <= 20) delta.toInt() else 0
        return if (insertions > 0) Action.INCREMENTAL else Action.FULL
    }
    fun firstPageCovers(insertions: Int, newIdentities: Int) = insertions in 1..20 && newIdentities == insertions
    data class Position(val at: String, val id: String)
    /** device-view orders captured_at DESC, id DESC and seeks strictly below its cursor.
     * Cover the whole retained range, including backfills, rather than just an overlap. */
    fun centralRangeCovers(previous: Position?, previouslyMore: Boolean, last: Position?, hasMore: Boolean): Boolean {
        if (!hasMore) return true // The response contains the whole current filtered domain.
        if (!previouslyMore || previous == null || last == null) return false
        val order = java.time.Instant.parse(last.at).compareTo(java.time.Instant.parse(previous.at))
        return order < 0 || order == 0 && last.id <= previous.id
    }
    /** New records must not restart a refresh loop for every single capture commit. */
    companion object { const val DEBOUNCE_MILLIS: Long = 5_000 }
}
