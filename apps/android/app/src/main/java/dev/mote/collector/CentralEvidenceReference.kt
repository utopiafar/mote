package dev.mote.collector

/** Resource IDs stay UUIDs; public references take their explicit namespace
 * from the shared deep-link schema so every end addresses the same object. */
internal object CentralEvidenceReference {
    fun normalize(reference: String): String =
        MoteLink.uuidId(reference)?.let { capture(it) } ?: MoteLink.reference(reference) ?: reference
    fun capture(id: String): String =
        requireNotNull(MoteLink.reference("capture:" + requireNotNull(MoteLink.uuidId(id))))
    fun captureId(reference: String): String? =
        MoteLink.reference(reference)?.takeIf { it.startsWith("capture:") }?.removePrefix("capture:")
}
