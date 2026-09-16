package dev.mote.collector

/** Local content is trusted and written without encryption. Credentials still use SecretBox.
 * Reads remain compatible with the old authenticated AES/GCM envelope. Most content (JSON,
 * PNG, JPEG, etc.) is stored byte-for-byte; an explicit plaintext escape only disambiguates
 * arbitrary bytes which happen to begin with the legacy envelope or escape prefix.
 */
class LocalContentCipher(private val legacy: ByteCipher = SecretBox(), private val encryptWrites: () -> Boolean = { false }) : ByteCipher {
    constructor(legacy: ByteCipher = SecretBox(), encryptWrites: Boolean) : this(legacy, { encryptWrites })
    companion object { private val plaintextWrites = ThreadLocal.withInitial { false } }
    fun <T> withPlaintextWrites(action: () -> T): T {
        val previous = plaintextWrites.get()
        plaintextWrites.set(true)
        try { return action() } finally { plaintextWrites.set(previous) }
    }
    private val escape = "MOTE-LOCAL-PLAIN-V1\u0000".toByteArray(Charsets.US_ASCII)
    private fun escaped(bytes: ByteArray) = bytes.size >= escape.size && escape.indices.all { bytes[it] == escape[it] }
    fun isLegacy(bytes: ByteArray): Boolean = !escaped(bytes) && bytes.isNotEmpty() &&
        bytes[0].toInt() in 12..16 && bytes.size > bytes[0].toInt() + 1
    fun sealPlaintext(bytes: ByteArray): ByteArray = if (escaped(bytes) || isLegacy(bytes)) escape + bytes else bytes
    override fun seal(bytes: ByteArray): ByteArray = if (plaintextWrites.get() != true && encryptWrites()) legacy.seal(bytes) else sealPlaintext(bytes)
    override fun open(bytes: ByteArray): ByteArray = when {
        escaped(bytes) -> bytes.copyOfRange(escape.size, bytes.size)
        isLegacy(bytes) -> legacy.open(bytes) // Never hide a failed authenticated legacy read.
        else -> bytes
    }
}

/** Resolve the optional policy at write time, including for long-lived queue/store handles. */
fun android.content.Context.localContentCipher(): LocalContentCipher {
    val preferences = applicationContext.getSharedPreferences("mote", android.content.Context.MODE_PRIVATE)
    return LocalContentCipher(encryptWrites = { preferences.getBoolean("contentEncryptionEnabled", false) })
}
