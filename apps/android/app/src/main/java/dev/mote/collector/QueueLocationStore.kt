package dev.mote.collector

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

data class QueueLocation(val id: String, val baseId: String, val path: String) {
    fun json() = JSONObject().put("id", id).put("baseId", baseId).put("path", path)
    companion object { fun parse(value: JSONObject) = QueueLocation(UUID.fromString(value.getString("id")).toString(), value.getString("baseId"), value.getString("path")) }
}

/** The pointer and recovery journal always stay on internal storage. Files are copied while encrypted. */
class QueueLocationStore(private val control: File, private val legacy: File, private val cipher: ByteCipher,
    private val validate: (QueueLocation) -> Unit = {}, private val checkpoint: (String) -> Unit = {},
    private val syncDirectory: (File) -> Unit = { java.nio.channels.FileChannel.open(it.toPath(), java.nio.file.StandardOpenOption.READ).use { channel -> channel.force(true) } }) {
    private val pointer = File(control, "queue-location.json")
    private val journal = File(control, "queue-migration.json")
    companion object {
        private const val IDENTITY = ".mote-storage-id"
        private val verifiedTargets = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    }
    private fun verificationKey(location: QueueLocation) = "${control.absolutePath}:${location.id}"
    private fun atomic(file: File, bytes: ByteArray) {
        val temp = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.tmp")
        try { FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }; check(temp.renameTo(file)) { "无法持久保存存储位置" }; syncDirectory(file.parentFile!!) }
        finally { temp.delete() }
    }
    private fun write(file: File, value: JSONObject) = atomic(file, value.toString().toByteArray(Charsets.UTF_8))
    private fun read(file: File) = JSONObject(file.readText(Charsets.UTF_8))
    private fun identified(location: QueueLocation): File {
        validate(location)
        val directory = File(location.path)
        check(directory.isDirectory && !java.nio.file.Files.isSymbolicLink(directory.toPath())) { "所选存储位置不可用，请重新连接该存储介质" }
        check(File(directory, IDENTITY).readText(Charsets.UTF_8) == location.id) { "存储目录不匹配，已保留原选择和数据" }
        return directory
    }
    private fun load(): QueueLocation {
        if (pointer.exists()) return QueueLocation.parse(read(pointer)).also(::identified)
        check(!journal.exists()) { "存储恢复记录存在，但位置指针缺失，请保留应用数据" }
        check(legacy.isDirectory || legacy.mkdirs()) { "无法创建本机存储目录" }
        check(!java.nio.file.Files.isSymbolicLink(legacy.toPath())) { "存储目录不可为符号链接" }
        val marker = File(legacy, IDENTITY)
        val id = if (marker.exists()) UUID.fromString(marker.readText()).toString() else UUID.randomUUID().toString().also { atomic(marker, it.toByteArray()) }
        val location = QueueLocation(id, "internal", legacy.absolutePath)
        identified(location); write(pointer, location.json())
        return location
    }
    fun selected(): QueueLocation = if (pointer.exists()) QueueLocation.parse(read(pointer)) else current()
    fun current(): QueueLocation { recover(); return load() }
    fun assertCurrent(expected: QueueLocation) { check(load() == expected) { "存储位置已更新，请重试此操作" } }
    fun migrate(baseId: String, base: File, progress: (String) -> Unit = {}): QueueLocation {
        progress("正在检查原存储完整性"); recover(); val source = load()
        if (source.baseId == baseId) return source
        val sourceDirectory = identified(source)
        DurableQueue(sourceDirectory, cipher, createMissing = false).verifyIntegrity()
        val size = sourceDirectory.listFiles()?.filter { it.isFile }?.sumOf(File::length) ?: 0L
        check(base.isDirectory || base.mkdirs()) { "目标存储不可用" }
        check(base.usableSpace >= size + 1024 * 1024) { "目标空间不足，原目录保持不变" }
        val targetId = UUID.randomUUID().toString()
        val target = QueueLocation(targetId, baseId, File(base, "mote-queue-$targetId").absolutePath)
        validate(target)
        val targetDirectory = File(target.path)
        check(targetDirectory.mkdir()) { "无法创建目标存储目录" }
        atomic(File(targetDirectory, IDENTITY), target.id.toByteArray())
        syncDirectory(base)
        write(journal, JSONObject().put("version", 1).put("source", source.json()).put("target", target.json()))
        checkpoint("journal")
        try {
            val files = sourceDirectory.listFiles() ?: error("无法读取原存储目录")
            for ((index, file) in files.withIndex()) {
                progress("正在复制并校验文件 ${index + 1}/${files.size}")
                if (file.name == IDENTITY) continue
                check(file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath())) { "原存储包含无法迁移的条目" }
                val destination = File(targetDirectory, file.name)
                FileOutputStream(destination).use { output -> file.inputStream().use { it.copyTo(output) }; output.fd.sync() }
                check(file.length() == destination.length() && hash(file).contentEquals(hash(destination))) { "复制校验失败，原数据已保留" }
            }
            progress("正在验证目标记录与图片")
            DurableQueue(targetDirectory, cipher, createMissing = false).verifyIntegrity()
            syncDirectory(targetDirectory)
            checkpoint("verified")
            write(pointer, target.json())
            checkpoint("committed")
            verifiedTargets.add(verificationKey(target))
        } catch (error: Exception) {
            // A committed pointer is authoritative even if later cleanup or the process fails.
            val selected = runCatching { QueueLocation.parse(read(pointer)) }.getOrNull()
            if (selected == target) return target
            if (selected == source) runCatching { removeOwned(target); journal.delete(); syncDirectory(control) }
            throw error
        }
        runCatching { removeOwned(source); check(journal.delete()); syncDirectory(control) }
        return target
    }
    fun recover() {
        if (!journal.exists()) return
        val value = read(journal); check(value.getInt("version") == 1)
        val source = QueueLocation.parse(value.getJSONObject("source")); val target = QueueLocation.parse(value.getJSONObject("target"))
        val current = QueueLocation.parse(read(pointer))
        when (current) {
            target -> {
                val directory = identified(target)
                if (verificationKey(target) !in verifiedTargets) {
                    DurableQueue(directory, cipher, createMissing = false).verifyIntegrity()
                    syncDirectory(directory); syncDirectory(directory.parentFile!!); syncDirectory(control)
                    verifiedTargets.add(verificationKey(target))
                }
                runCatching { removeOwned(source); check(journal.delete()); syncDirectory(control) }
            }
            source -> { identified(source); runCatching { removeOwned(target); check(journal.delete()) } }
            else -> error("存储迁移状态不一致，请保留应用数据")
        }
    }
    private fun removeOwned(location: QueueLocation) {
        val directory = File(location.path)
        if (!directory.exists()) return
        validate(location)
        if (!File(directory, IDENTITY).exists() && directory.isDirectory && !java.nio.file.Files.isSymbolicLink(directory.toPath()) && directory.listFiles()?.isEmpty() == true) {
            check(directory.delete()); syncDirectory(directory.parentFile!!); return
        }
        identified(location)
        for (entry in directory.listFiles() ?: error("无法清理旧存储副本")) {
            check(entry.isFile && !java.nio.file.Files.isSymbolicLink(entry.toPath())) { "旧目录包含未知子目录，副本已保留" }
            if (entry.name != IDENTITY) check(entry.delete()) { "旧存储副本清理未完成" }
        }
        check(File(directory, IDENTITY).delete()); check(directory.delete()); syncDirectory(directory.parentFile!!)
    }
    private fun hash(file: File): ByteArray = MessageDigest.getInstance("SHA-256").run {
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val size = input.read(buffer); if (size < 0) break; update(buffer, 0, size) } }; digest()
    }
}
