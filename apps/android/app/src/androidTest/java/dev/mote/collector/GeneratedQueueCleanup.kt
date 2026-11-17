package dev.mote.collector

/** Fixture-only cleanup for an exact record created by that fixture. Upload ACK
 * now retains the original; cleanup uses the existing explicit local deletion. */
internal fun DurableQueue.removeGeneratedRecord(id: String) {
    val row = dedupeRow(id) ?: return
    check(resolveDedupe(id, row.optString("blob"), null, null, null))
}
