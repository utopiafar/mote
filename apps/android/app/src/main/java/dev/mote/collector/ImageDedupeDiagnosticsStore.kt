package dev.mote.collector

import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.FileVisitResult
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

data class ImageDedupeDiagnosticRecord(val metadata: JSONObject, val referenceImage: ByteArray, val duplicateImage: ByteArray)

/** Opt-in local diagnostics, deliberately independent from every capture/upload queue. */
class ImageDedupeDiagnosticsStore(
    private val directory: File,
    private val cipher: ByteCipher,
    private val now: () -> Long = System::currentTimeMillis,
    private val enabled: () -> Boolean = { true },
    private val maxRecords: Int = 20,
    private val maxBytes: Long = 32L * 1024 * 1024,
    private val maxAgeMs: Long = 24L * 60 * 60 * 1000
) {
    init {
        require(maxRecords in 1..1000 && maxBytes in 1..Int.MAX_VALUE.toLong() && maxAgeMs > 0) { "Invalid diagnostic retention limits" }
    }

    fun record(metadata: JSONObject, referenceImage: ByteArray, duplicateImage: ByteArray): String? = synchronized(lock) {
        if (!enabled()) { clearFiles(); return@synchronized null }
        require(referenceImage.isNotEmpty() && duplicateImage.isNotEmpty()) { "A diagnostic needs both images" }
        val retainedAt = now(); require(retainedAt >= 0) { "Invalid diagnostic timestamp" }
        val id = UUID.randomUUID().toString()
        val value = JSONObject(metadata.toString()).put("id", id).put("retainedAt", retainedAt)
        val json = value.toString().toByteArray(Charsets.UTF_8)
        require(json.size <= MAX_METADATA_BYTES) { "Diagnostic metadata is too large" }
        val plainBytes = 16L + json.size + referenceImage.size + duplicateImage.size
        if (plainBytes > maxBytes) { retained(); return@synchronized null }
        val plain = ByteArrayOutputStream(plainBytes.toInt()).also { bytes ->
            DataOutputStream(bytes).use { out ->
                out.writeInt(MAGIC); out.writeInt(json.size); out.writeInt(referenceImage.size); out.writeInt(duplicateImage.size)
                out.write(json); out.write(referenceImage); out.write(duplicateImage)
            }
        }.toByteArray()
        // Seal the entire pair before opening a temporary file or evicting older valid entries.
        val sealed = cipher.seal(plain)
        if (!enabled()) { clearFiles(); return@synchronized null }
        if (sealed.size.toLong() > maxBytes) { retained(); return@synchronized null }
        val entries = retained().toMutableList()
        var bytes = entries.sumOf { it.file.length() }
        while (entries.size >= maxRecords || bytes + sealed.size > maxBytes) {
            val oldest = entries.removeAt(entries.lastIndex)
            bytes -= oldest.file.length(); erase(oldest.file)
        }
        ensureDirectory()
        val file = File(directory, "$id.enc"); val temp = File(directory, "$id.tmp")
        try {
            FileOutputStream(temp).use { out -> out.write(sealed); out.fd.sync() }
            if (!enabled()) { clearFiles(); return@synchronized null }
            check(temp.renameTo(file)) { "Cannot commit encrypted diagnostic" }
        } finally { if (temp.exists()) erase(temp) }
        id
    }

    fun list(): List<JSONObject> = synchronized(lock) {
        if (!enabled()) { clearFiles(); return@synchronized emptyList() }
        retained().map { JSONObject(it.record.metadata.toString()) }
    }

    fun read(id: String): ImageDedupeDiagnosticRecord? = synchronized(lock) {
        if (!enabled()) { clearFiles(); return@synchronized null }
        if (!validId(id)) return@synchronized null
        retained().firstOrNull { it.record.metadata.getString("id") == id }?.record
    }

    fun delete(id: String): Boolean = synchronized(lock) {
        if (!validId(id)) return@synchronized false
        checkDirectory()
        val file = File(directory, "$id.enc")
        if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return@synchronized false
        erase(file); true
    }

    fun clear() = synchronized(lock) { clearFiles() }
    fun prune() = synchronized(lock) { if (!enabled()) clearFiles() else retained().let { Unit } }
    fun migrateLegacyContent(shouldStop: () -> Boolean = { false }, onProgress: (Int, Int) -> Unit = { _, _ -> }): Int {
        val files = synchronized(lock) { retained().map { it.file } }
        var changed = 0
        for ((index, file) in files.withIndex()) {
            if (shouldStop()) break
            synchronized(lock) { if (LocalContentMigration.migrate(file, cipher) { decode(file.nameWithoutExtension, file.readBytes()) }) changed++ }
            onProgress(index + 1, files.size)
        }
        return changed
    }

    private data class Entry(val file: File, val record: ImageDedupeDiagnosticRecord)

    /** Corrupt, abandoned, expired and excess records cannot appear in the viewer. */
    private fun retained(): List<Entry> {
        checkDirectory()
        if (!directory.exists()) return emptyList()
        val current = now()
        val entries = mutableListOf<Entry>()
        for (file in directory.listFiles() ?: error("Cannot list diagnostic storage")) {
            val id = file.name.removeSuffix(".enc")
            if (!file.name.endsWith(".enc") || !validId(id) || !file.isFile || Files.isSymbolicLink(file.toPath()) || file.length() > maxBytes) {
                erase(file); continue
            }
            val record = runCatching { decode(id, file.readBytes()) }.getOrNull()
            val at = record?.metadata?.getLong("retainedAt")
            if (record == null || at == null || at < 0 || at > current || current - at >= maxAgeMs) { erase(file); continue }
            entries.add(Entry(file, record))
        }
        entries.sortWith(compareByDescending<Entry> { it.record.metadata.getLong("retainedAt") }.thenByDescending { it.file.name })
        var bytes = 0L
        return entries.filterIndexed { index, entry ->
            bytes += entry.file.length()
            if (index < maxRecords && bytes <= maxBytes) true else { erase(entry.file); false }
        }
    }

    private fun decode(id: String, encrypted: ByteArray): ImageDedupeDiagnosticRecord {
        val plain = cipher.open(encrypted)
        require(plain.size.toLong() <= maxBytes && plain.size >= 16)
        return DataInputStream(ByteArrayInputStream(plain)).use { input ->
            require(input.readInt() == MAGIC)
            val jsonSize = input.readInt(); val referenceSize = input.readInt(); val duplicateSize = input.readInt()
            require(jsonSize in 1..MAX_METADATA_BYTES && referenceSize > 0 && duplicateSize > 0)
            require(16L + jsonSize + referenceSize + duplicateSize == plain.size.toLong())
            val metadata = JSONObject(String(ByteArray(jsonSize).also(input::readFully), Charsets.UTF_8))
            require(metadata.opt("id") == id && metadata.opt("retainedAt") is Number)
            val at = metadata.getDouble("retainedAt")
            require(at.isFinite() && at >= 0 && at == metadata.getLong("retainedAt").toDouble())
            ImageDedupeDiagnosticRecord(metadata, ByteArray(referenceSize).also(input::readFully), ByteArray(duplicateSize).also(input::readFully))
        }
    }

    private fun checkDirectory() {
        check(!Files.isSymbolicLink(directory.toPath()) && (!directory.exists() || directory.isDirectory)) { "Invalid diagnostic storage directory" }
    }
    private fun ensureDirectory() { checkDirectory(); check(directory.isDirectory || directory.mkdirs()) { "Cannot create diagnostic storage" } }
    private fun clearFiles() {
        checkDirectory()
        if (!directory.exists()) return
        for (file in directory.listFiles() ?: error("Cannot list diagnostic storage")) erase(file)
    }
    private fun erase(file: File) {
        // walkFileTree does not follow symbolic links; damaged nested cache entries
        // can be removed without reading or deleting their external targets.
        if (!Files.exists(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return
        Files.walkFileTree(file.toPath(), object : SimpleFileVisitor<Path>() {
            override fun visitFile(path: Path, attributes: BasicFileAttributes): FileVisitResult {
                Files.delete(path); return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(path: Path, error: java.io.IOException?): FileVisitResult {
                if (error != null) throw error
                Files.delete(path); return FileVisitResult.CONTINUE
            }
        })
    }
    companion object {
        private val lock = Any()
        private const val MAX_METADATA_BYTES = 64 * 1024
        private const val MAGIC = 0x4D444431 // MDD1, inside the authenticated encrypted envelope.
        private val idPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        private fun validId(id: String) = idPattern.matches(id)
    }
}
