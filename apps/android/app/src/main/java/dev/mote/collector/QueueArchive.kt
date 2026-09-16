package dev.mote.collector

import org.json.JSONObject
import java.io.*
import java.util.UUID
import java.util.zip.*

/** Portable queue records and their exact images. No keystore material or executable settings. */
object QueueArchive {
    private val record = Regex("records/[a-f0-9-]{36}\\.json")
    private val image = Regex("images/[a-f0-9]{64}\\.blob")
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    data class Prepared(val directory: File, val origin: String, val count: Int) {
        fun queue() = DurableQueue(directory, plain)
        fun close() { directory.deleteRecursively() }
    }
    fun export(queue: DurableQueue, origin: String, output: OutputStream): Int {
        var count = 0
        ZipOutputStream(output).use { zip ->
            fun write(name: String, bytes: ByteArray) { zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() }
            write("archive.json", JSONObject().put("format", "mote-android-records").put("version", 1).put("origin", origin).toString().toByteArray())
            val images = mutableSetOf<String>()
            for (id in queue.dedupeIds()) {
                val value = queue.archiveRecord(id) ?: continue
                val event = value.first; val bytes = value.second; val hash = event.optString("_blob")
                if (bytes != null && images.add(hash)) write("images/$hash.blob", bytes)
                write("records/$id.json", event.toString().toByteArray()); count++
            }
        }
        return count
    }
    /** Stage and validate the entire archive before touching the current queue. */
    fun prepare(input: InputStream, directory: File, maxBytes: Long): Prepared {
        require(maxBytes > 0 && !directory.exists()); check(directory.mkdirs())
        try {
            val seen = mutableSetOf<String>(); var total = 0L; var origin: String? = null; var count = 0
            ZipInputStream(input).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    require(seen.size < 200_001 && seen.add(entry.name) && !entry.isDirectory) { "备份包含重复或过多条目" }
                    val name = entry.name
                    val cap = when { name == "archive.json" -> 16 * 1024; record.matches(name) -> 1024 * 1024; image.matches(name) -> 16 * 1024 * 1024; else -> error("备份条目无效") }
                    val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val n = zip.read(buffer); if (n < 0) break; total += n; require(total <= maxBytes && out.size() + n <= cap) { "备份超过本机空间上限" }; out.write(buffer, 0, n) }
                    val bytes = out.toByteArray()
                    when {
                        name == "archive.json" -> {
                            val manifest = JSONObject(String(bytes, Charsets.UTF_8))
                            require(manifest.getString("format") == "mote-android-records" && manifest.get("version") == 1) { "备份版本不支持" }
                            origin = manifest.getString("origin")
                        }
                        record.matches(name) -> {
                            val id = name.removePrefix("records/").removeSuffix(".json")
                            require(UUID.fromString(id).toString() == id)
                            val text = String(bytes, Charsets.UTF_8); StrictJson.validate(text)
                            val event = JSONObject(text); require(event.getString("id") == id)
                            File(directory, "$id.event").writeBytes(bytes); count++
                        }
                        else -> {
                            val hash = name.removePrefix("images/").removeSuffix(".blob")
                            val actual = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                            require(hash == actual) { "备份图片校验失败" }; File(directory, "$hash.blob").writeBytes(bytes)
                        }
                    }
                    zip.closeEntry()
                }
            }
            require(origin != null) { "缺少备份清单" }
            val staged = DurableQueue(directory, plain)
            // Validate the same invariants as fresh captures, including image identities and privacy.
            val validatedDir = File(directory, "validated"); val validated = DurableQueue(validatedDir, plain)
            for (id in staged.dedupeIds()) {
                val (event, bytes) = requireNotNull(staged.archiveRecord(id))
                val wire = wire(event)
                validated.enqueue(wire, bytes, maxBytes)
                restoreOcr(event, validated, maxBytes)
            }
            staged.prepareIndex()
            validatedDir.deleteRecursively()
            return Prepared(directory, origin!!, count)
        } catch (error: Exception) { directory.deleteRecursively(); throw error }
    }
    private fun restoreOcr(event: JSONObject, target: DurableQueue, maxBytes: Long) {
        event.optJSONObject("_ocrResult")?.let { result ->
            java.time.Instant.parse(result.getString("updatedAt"))
            if (target.archiveRecord(event.getString("id"))?.first?.has("_ocrResult") != true)
                target.completeOcr(event.getString("id"), result.getString("ocrText"), result.getString("status"), maxBytes)
        }
    }
    private fun wire(event: JSONObject) = JSONObject(event.toString()).apply { keys().asSequence().filter { it.startsWith("_") }.toList().forEach(::remove) }
    /** Same IDs merge idempotently; a conflicting existing record is rejected before any writes. */
    fun restore(prepared: Prepared, target: DurableQueue, origin: String, maxBytes: Long): Int = DurableQueue.exclusive {
        require(prepared.origin == origin) { "备份属于不同中央节点；请连接原节点后导入" }
        val source = prepared.queue()
        val ids = source.dedupeIds()
        for (id in ids) {
            val existing = target.archiveRecord(id) ?: continue
            val incoming = requireNotNull(source.archiveRecord(id))
            require(SourceRules.canonical(wire(existing.first)) == SourceRules.canonical(wire(incoming.first)) && existing.second.contentEquals(incoming.second)) { "备份中存在同 ID 内容冲突，未导入" }
            val oldOcr = existing.first.optJSONObject("_ocrResult"); val newOcr = incoming.first.optJSONObject("_ocrResult")
            require(oldOcr == null || newOcr == null || oldOcr.getString("ocrText") == newOcr.getString("ocrText") && oldOcr.getString("status") == newOcr.getString("status")) { "备份 OCR 与本机内容冲突，未导入" }
        }
        var count = 0
        for (id in ids) {
            val (event, bytes) = requireNotNull(source.archiveRecord(id))
            if (target.capture(id) == null) { target.enqueue(wire(event), bytes, maxBytes); count++ }
            restoreOcr(event, target, maxBytes)
        }
        count
    }
}
