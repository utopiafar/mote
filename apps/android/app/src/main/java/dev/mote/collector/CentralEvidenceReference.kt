package dev.mote.collector

/** Resource IDs stay UUIDs; a public original reference carries its explicit namespace. */
internal object CentralEvidenceReference {
    private val uuid = Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")
    fun capture(id: String): String { require(uuid.matches(id)); return "capture:" + id.lowercase() }
    fun captureId(reference: String): String? {
        if (!reference.startsWith("capture:")) return null
        val id = reference.removePrefix("capture:")
        return id.takeIf(uuid::matches)?.lowercase()
    }
}
