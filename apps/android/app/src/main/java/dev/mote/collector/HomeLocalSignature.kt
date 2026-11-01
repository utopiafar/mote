package dev.mote.collector

import org.json.JSONObject

/**
 * Render signatures for the home blocks. A block rebuilds its views only when the content
 * it displays actually changed; the signature inputs are the same strings and ids the rows show.
 */
internal object HomeLocalSignature {
    /** (id, name, rendered status text) per continuously-synced source, in display order. */
    fun sources(rows: List<Triple<String, String, String>>): String =
        rows.joinToString("") { (id, name, status) -> fields(id, name, status) }

    /** The saved-receipt card: record id, rendered preview, capture time and the Central link visibility. */
    fun receipt(id: String, preview: String, capturedAt: String, connected: Boolean): String =
        fields(id, preview, capturedAt, connected.toString())

    /** Length-prefixed fields cannot collide no matter what the values contain. */
    private fun fields(vararg values: String): String = values.joinToString("") { "${it.length}:$it" }
}

/**
 * The has-any-records answer keyed by the local-records revision. An unchanged revision reuses
 * the last answer without touching the queue; a changed revision, including a full deletion,
 * runs [check] once more.
 */
internal class RevisionCache {
    private var revision = -1L
    private var value = false
    fun hasRecords(revision: Long, check: () -> Boolean): Boolean {
        if (revision != this.revision) { value = check(); this.revision = revision }
        return value
    }
}

/**
 * The local inventory payload the home reads: the draft flag, the existence check keyed by
 * [recordsRevision] and the saved receipt. [exists] is invoked only when the revision changed,
 * so an unchanged local archive never opens the queue.
 */
internal object HomeLocalCaptures {
    /**
     * The existence check must cover every stored record: a timestamp-bounded page query would
     * exclude future-dated records while its revision-keyed cache answer never expires, so the
     * home could stick in first-use mode as the clock catches up. [DurableQueue.anyStored] has
     * no clock input and reports a listing failure rather than inventing an empty inventory.
     */
    fun exists(queue: DurableQueue) = queue.anyStored()

    fun collect(cache: RevisionCache, recordsRevision: Long, draft: JSONObject, savedReceipt: JSONObject?, exists: () -> Boolean): JSONObject {
        val captures = JSONObject()
        captures.put("hasDraft", draft.optString("text").isNotBlank() || draft.optString("description").isNotBlank() || (draft.optJSONArray("attachments")?.length() ?: 0) > 0 || draft.optJSONObject("origin")?.optString("text").orEmpty().isNotBlank())
        captures.put("hasAnyRecords", cache.hasRecords(recordsRevision, exists))
        savedReceipt?.let { captures.put("savedReceipt", it) }
        return captures
    }
}
