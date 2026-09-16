package dev.mote.collector

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.util.UUID

/** Called under the owning store's lock; an unreadable legacy file is never overwritten. */
internal object LocalContentMigration {
    fun migrate(file: File, cipher: ByteCipher, validate: (ByteArray) -> Unit = {}): Boolean {
        if (cipher !is LocalContentCipher || !file.exists()) return false
        check(file.isFile && !Files.isSymbolicLink(file.toPath())) { "本机文件类型无效，原文件已保留" }
        // Every escaped new binary payload begins with an ASCII marker, never an old IV length.
        val first = file.inputStream().use { it.read() }
        if (first !in 12..16) return false
        val original = file.readBytes()
        if (!cipher.isLegacy(original)) return false
        val plain = cipher.open(original)
        validate(plain)
        val modified = file.lastModified()
        val temporary = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { it.write(cipher.sealPlaintext(plain)); it.fd.sync() }
            check(temporary.renameTo(file)) { "本机文件格式升级失败，原文件已保留" }
            file.setLastModified(modified)
        } finally { temporary.delete() }
        return true
    }
}
