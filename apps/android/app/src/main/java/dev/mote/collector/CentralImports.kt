package dev.mote.collector

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Durable, encrypted, bounded upload parts; retries preserve both upload and admission IDs. */
internal class CentralImports(private val directory: File, private val cipher: ByteCipher) {
    private val state = CentralStateFile(directory, "import", cipher)
    fun pending(): JSONObject = state.read()
    fun stage(context: Context, uri: Uri, instruction: String): JSONObject {
        check(!pending().has("manifest")) { MoteI18n.text("请先重试或放弃待导入文件。") }
        directory.mkdirs(); directory.listFiles()?.filter { it.name.startsWith("part-") }?.forEach { it.delete() }
        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: "import"
        val mime = context.contentResolver.getType(uri)
        var size = 0L; var part = 0
        try {
            requireNotNull(context.contentResolver.openInputStream(uri)).use { input ->
                while (true) {
                    val bytes = ByteArray(PART); var offset = 0
                    while (offset < bytes.size) { val count = input.read(bytes, offset, bytes.size - offset); if (count < 0) break; offset += count }
                    if (offset == 0) break
                    size += offset; require(size <= MAX) { MoteI18n.text("导入文件最多 64 MiB。") }
                    File(directory, "part-${part++}.enc").outputStream().use { it.write(cipher.seal(bytes.copyOf(offset))) }
                }
            }
            val manifest = JSONObject().put("id", UUID.randomUUID().toString()).put("name", name).put("sizeBytes", size)
            mime?.let { manifest.put("mimeType", it) }
            return JSONObject().put("manifest", manifest).put("requestId", UUID.randomUUID().toString()).put("instruction", instruction).also(state::write)
        } catch (error: Throwable) { discard(); throw error }
    }
    fun send(client: CentralClient, progress: (Int, Int) -> Unit): JSONObject {
        val saved = pending(); val manifest = saved.getJSONObject("manifest")
        val upload = client.post("/api/import-uploads", manifest)
        val id = manifest.getString("id"); UUID.fromString(id)
        require(upload.getString("id") == id && upload.getInt("partBytes") == PART)
        val received = upload.getJSONArray("parts").let { parts -> (0 until parts.length()).map { parts.getJSONObject(it).getInt("part") }.toSet() }
        val total = ((manifest.getLong("sizeBytes") + PART - 1) / PART).toInt()
        if (upload.optString("fileId").isBlank()) repeat(total) { part ->
            if (part !in received) client.bytes("PUT", "/api/import-uploads/$id/parts/$part", cipher.open(File(directory, "part-$part.enc").readBytes()), "application/octet-stream")
            progress(part + 1, total)
        }
        val fileId = upload.optString("fileId").ifBlank { client.post("/api/import-uploads/$id/commit").getString("id") }
        val request = JSONObject().put("requestId", saved.getString("requestId")).put("processing", "preview")
            .put("instruction", saved.getString("instruction")).put("archivedFileIds", JSONArray().put(fileId))
        val result = client.post("/api/imports", request)
        discard(); return result
    }
    fun discard() { directory.listFiles()?.forEach { check(it.delete()) }; }
    companion object { const val PART = 4 * 1024 * 1024; const val MAX = 64 * 1024 * 1024L }
}
