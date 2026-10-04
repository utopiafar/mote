package dev.mote.collector

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** Integrity checks for release APK artifacts and resumed downloads. */
internal object UpdateArtifactValidation {
    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) { val length = input.read(buffer); if (length < 0) break; digest.update(buffer, 0, length) }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    fun validateRange(value: String?, offset: Long, total: Long) {
        val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(value ?: "") ?: throw IOException(MoteI18n.text("无效 Content-Range"))
        val (start, end, size) = match.destructured
        require(start.toLong() == offset && size.toLong() == total && end.toLong() in offset until total) { MoteI18n.text("断点响应与清单不匹配") }
    }
}
