package dev.mote.collector

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

class QueueFull : IllegalStateException("本地队列已满，暂停采集；联网并成功上传后恢复")

/** Atomic encrypted events + content-addressed blobs. All callers share the process lock. */
class DurableQueue(private val dir: File, private val cipher: ByteCipher, private val onChange: ((OperationKind, Long, String) -> Unit)? = null) {
    companion object { private val lock = Any() }
    init { dir.mkdirs() }
    private fun records(): List<File> = dir.listFiles()?.filter { it.extension == "event" }?.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name }) ?: emptyList()
    fun depth(): Int = synchronized(lock) { records().size }
    fun bytes(): Long = synchronized(lock) { dir.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L }
    private fun read(file: File): JSONObject = JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8))
    private fun atomic(file: File, bytes: ByteArray) {
        val temp = File(dir, "${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(bytes)); it.fd.sync() }
            check(temp.renameTo(file)) { "无法原子写入队列" }
        } finally { temp.delete() }
    }
    fun enqueue(event: JSONObject, image: ByteArray?, maxBytes: Long) = synchronized(lock) {
        require(!event.getJSONObject("privacy").optBoolean("excluded")) { "Excluded captures must never be queued" }
        val id = UUID.fromString(event.getString("id")).toString()
        val file = File(dir, "$id.event")
        val source = event.optString("source", "screen")
        if (image == null) require(source in setOf("note", "activity") && !event.has("imageMime") && !event.has("imageBase64")) { "Only notes or activity can omit images" }
        if (source == "activity") {
            require(image == null && event.getJSONObject("privacy").optString("collection") == "activity" && event.optString("appId").isNotBlank())
            require(listOf("ocrText", "title", "windowTitle", "mood", "provenance", "imageMime", "imageBase64").none(event::has)) { "Activity must not contain content" }
            event.optJSONObject("metadata")?.optJSONObject("capture")?.let { require(it.keys().asSequence().all { key -> key == "intervalMs" }) }
        }
        val hash = image?.let { MessageDigest.getInstance("SHA-256").digest(it).joinToString("") { byte -> "%02x".format(byte) } }
        val stored = JSONObject(event.toString()).put("_blob", hash)
        if (file.exists()) { check(read(file).toString() == stored.toString()) { "相同记录 ID 的内容发生变化" }; return@synchronized }
        val blob = hash?.let { File(dir, "$it.blob") }
        val body = stored.toString().toByteArray()
        val added = body.size + 64L + if (blob == null || blob.exists()) 0 else image!!.size + 64L
        if (bytes() + added > maxBytes) throw QueueFull()
        if (blob != null && !blob.exists()) atomic(blob, image!!)
        atomic(file, body)
        onChange?.invoke(when (source) { "activity" -> OperationKind.ACTIVITY_QUEUED; "note" -> OperationKind.NOTE_QUEUED; else -> OperationKind.SCREEN_QUEUED }, added, id)
    }
    fun peek(): JSONObject? = synchronized(lock) {
        val file = records().firstOrNull() ?: return null
        val event = read(file)
        val hash = event.optString("_blob", "")
        if (hash.isEmpty()) { require(event.getString("source") in setOf("note", "activity")); event.remove("_blob"); return event }
        require(hash.matches(Regex("[a-f0-9]{64}")))
        event.remove("_blob")
        event.put("imageBase64", Base64.getEncoder().encodeToString(cipher.open(File(dir, "$hash.blob").readBytes())))
        event
    }
    fun acknowledge(id: String, uploadedBytes: Long = 0) = synchronized(lock) {
        val file = File(dir, "${UUID.fromString(id)}.event")
        if (!file.exists()) return
        val record = read(file)
        val hash = record.optString("_blob", "")
        check(file.delete()) { "无法删除已确认记录" }
        onChange?.invoke(when (record.optString("source")) { "activity" -> OperationKind.ACTIVITY_ACK; "note" -> OperationKind.NOTE_ACK; else -> OperationKind.SCREEN_ACK }, uploadedBytes, id)
        if (hash.isNotEmpty() && records().none { read(it).optString("_blob", "") == hash }) File(dir, "$hash.blob").delete()
    }
    fun summary(): JSONObject = synchronized(lock) {
        val files = records(); var screens = 0; var notes = 0; var activities = 0; var unreadable = 0
        val pending = org.json.JSONArray()
        files.take(100).forEach { file -> try {
            val body = read(file); val source = body.optString("source", "screen"); val id = UUID.fromString(body.getString("id")).toString()
            val at = java.time.Instant.parse(body.getString("capturedAt")).toString()
            when (source) { "screen" -> screens++; "note" -> notes++; "activity" -> activities++; else -> error("unknown") }
            pending.put(JSONObject().put("id", id).put("kind", source).put("createdAt", at).put("bytes", file.length()))
        } catch (_: Exception) { unreadable++ } }
        JSONObject().put("total", files.size).put("screens", screens).put("notes", notes).put("activities", activities).put("unreadable", unreadable)
            .put("uninspected", (files.size - 100).coerceAtLeast(0)).put("bytes", bytes()).put("pending", pending)
    }
    fun recoverOrphans() = synchronized(lock) {
        // Read every event first. Corruption is surfaced; never silently discard an event.
        val referenced = records().map { read(it).optString("_blob", "") }.toSet()
        dir.listFiles()?.filter { it.extension == "tmp" || (it.extension == "blob" && it.nameWithoutExtension !in referenced) }?.forEach { it.delete() }
    }
}
