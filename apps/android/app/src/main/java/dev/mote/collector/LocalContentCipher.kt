package dev.mote.collector

/** Format 3 stores content verbatim. Current credentials and private ledgers use SecretBox separately. */
class LocalContentCipher : ByteCipher {
    override fun seal(bytes: ByteArray): ByteArray = bytes
    override fun open(bytes: ByteArray): ByteArray = bytes
}

fun android.content.Context.localContentCipher(): LocalContentCipher {
    LocalDataFormat.requireCurrent(this)
    return LocalContentCipher()
}
