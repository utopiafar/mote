package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Origin-scoped encrypted draft and outbox. An ambiguous ACK always retries the same ID. */
internal class CentralNoteStore(private val directory: File, private val cipher: ByteCipher) {
    private val file = File(directory, "notes.enc")
    @Synchronized fun read(): JSONObject = if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else
        JSONObject().put("draft", JSONObject().put("text", "").put("mood", "").put("attachments", JSONArray())).put("pending", JSONArray())
    @Synchronized fun edit(text: String, mood: String, attachments: JSONArray) {
        require(text.length <= 100000 && mood.length <= 80 && attachments.length() <= 10)
        val state = read(); state.put("draft", JSONObject().put("text", text).put("mood", mood).put("attachments", attachments)); write(state)
    }
    @Synchronized fun enqueue(deviceId: String, deviceName: String): JSONObject {
        val state = read(); val draft = state.getJSONObject("draft")
        require(draft.getString("text").isNotBlank()) { MoteI18n.text("请先填写随手记") }
        val note = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", deviceId).put("deviceName", deviceName)
            .put("platform", "android").put("capturedAt", java.time.Instant.now().toString()).put("text", draft.getString("text"))
        if (draft.optString("mood").isNotBlank()) note.put("mood", draft.getString("mood"))
        if (draft.getJSONArray("attachments").length() > 0) note.put("metadata", JSONObject().put("attachments", draft.getJSONArray("attachments")))
        val pending = state.getJSONArray("pending"); require(pending.length() < 1000)
        pending.put(note); state.put("draft", JSONObject().put("text", "").put("mood", "").put("attachments", JSONArray())); write(state)
        return note
    }
    @Synchronized fun acknowledge(id: String, response: JSONObject) {
        require(response.optString("id") == id) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        val state = read(); val pending = state.getJSONArray("pending")
        state.put("pending", JSONArray((0 until pending.length()).map { pending.getJSONObject(it) }.filter { it.getString("id") != id })); write(state)
    }
    private fun write(state: JSONObject) {
        directory.mkdirs(); val temp = File(directory, UUID.randomUUID().toString() + ".tmp")
        try { FileOutputStream(temp).use { it.write(cipher.seal(state.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }; check(temp.renameTo(file)) }
        finally { temp.delete() }
    }
}

internal object CentralAttachments {
    const val MAX_BYTES = 50 * 1024 * 1024
    fun upload(client: CentralClient, file: File, name: String, mime: String, deviceId: String,
        resolveTime: (String) -> Long,
        progress: (Int, Int) -> Unit = { _, _ -> }): String {
        require((mime.startsWith("image/") || mime.startsWith("audio/")) && file.length() in 1..MAX_BYTES.toLong()) {
            MoteI18n.text("附件必须是图片或音频，且每个文件最多 50 MiB。")
        }
        val sourceId = "notes-$deviceId"
        client.post("/api/sources", JSONObject().put("id", sourceId).put("name", MoteI18n.text("图片与语音附件"))
            .put("kind", "upload").put("deviceId", deviceId).put("platform", "android").put("retention", "archive").put("enabled", true))
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        val identity = SourceRules.hash(JSONArray().put(hash).put(name).toString())
        val modifiedAt = resolveTime(identity)
        val manifest = JSONObject().put("sourceId", sourceId).put("sha256", hash).put("sizeBytes", file.length()).put("item", JSONObject()
            .put("externalId", "attachment:$identity").put("revision", hash).put("observedAt", java.time.Instant.ofEpochMilli(modifiedAt).toString())
            .put("title", name).put("kind", "file").put("layer", "original").put("text", "").put("mimeType", mime))
        val upload = client.post("/api/file-sync/v1/uploads", manifest)
        upload.optJSONObject("ack")?.let { return it.getString("captureId") }
        val id = upload.getString("uploadId"); UUID.fromString(id)
        val parts = upload.optJSONArray("parts") ?: JSONArray()
        val received = (0 until parts.length()).map { parts.getJSONObject(it).getInt("part") }.toSet()
        val total = ((file.length() + 4 * 1024 * 1024 - 1) / (4 * 1024 * 1024)).toInt()
        file.inputStream().use { input ->
            repeat(total) { part ->
                val bytes = ByteArray(minOf(4 * 1024 * 1024L, file.length() - part * 4 * 1024 * 1024L).toInt())
                var offset = 0
                while (offset < bytes.size) { val n = input.read(bytes, offset, bytes.size - offset); check(n > 0); offset += n }
                if (part !in received) client.bytes("PUT", "/api/file-sync/v1/uploads/$id/parts/$part", bytes, "application/octet-stream")
                progress(part + 1, total)
            }
        }
        return client.post("/api/file-sync/v1/uploads/$id/commit").getString("captureId")
    }
}
