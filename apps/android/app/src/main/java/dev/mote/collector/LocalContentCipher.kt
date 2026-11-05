package dev.mote.collector

import java.io.InputStream
import java.io.OutputStream

/** Format 3 stores content verbatim. Current credentials and private ledgers use SecretBox separately. */
class LocalContentCipher : ByteCipher {
    override fun seal(bytes: ByteArray): ByteArray = bytes
    override fun open(bytes: ByteArray): ByteArray = bytes
    override fun seal(input: InputStream, output: OutputStream) { input.copyTo(output, 64 * 1024) }
}

fun android.content.Context.localContentCipher(): LocalContentCipher {
    LocalDataFormat.requireCurrent(this)
    return LocalContentCipher()
}
