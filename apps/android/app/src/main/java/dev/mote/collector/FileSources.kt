package dev.mote.collector

import android.content.Context
import android.net.Uri
import android.os.CancellationSignal
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

fun Context.fileArchives() = FileArchiveQueue(File(noBackupFilesDir, "file-archives"), localContentCipher())
fun LocalSource.binaryFiles() = kind == "local-files"

/** Persistent traversal checkpoints; every directory is eventually reached within bounded slices. */
class FileSources(private val context: Context, private val cancel: CancellationSignal = CancellationSignal()) {
    init { com.tom_roush.pdfbox.android.PDFBoxResourceLoader.init(context.applicationContext) }
    private val resolver = context.contentResolver
    private val projection = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
    fun metadata(uri: Uri, source: LocalSource): JSONObject? = resolver.query(uri, projection, null, null, null, cancel)?.use { c ->
        if (!c.moveToFirst()) return@use null
        val name = c.getString(1) ?: "file"; val mime = c.getString(2) ?: "application/octet-stream"
        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) return@use null
        val item = JSONObject().put("externalId", uri.toString()).put("uri", uri.toString()).put("title", name.take(2000)).put("kind", "file").put("layer", if (source.retention == "archive") "original" else if (source.retention == "snapshot") "snapshot" else "reference").put("text", "").put("mimeType", mime.take(200)).put("observedAt", Instant.now().toString())
        if (!c.isNull(3) && c.getLong(3) >= 0) item.put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", c.getLong(3))))
        if (!c.isNull(4) && c.getLong(4) > 0) item.put("modifiedAt", Instant.ofEpochMilli(c.getLong(4)).toString())
        item
    }
    fun scan(source: LocalSource): Boolean = measured(EventStage.FILE_SCAN) { scanSlice(source) }
    private fun <T> measured(stage: EventStage, work: () -> T): T {
        val started = android.os.SystemClock.elapsedRealtime()
        SupportEvents.record(context, stage, EventCode.STARTED)
        try { return work().also { SupportEvents.record(context, stage, EventCode.OK, android.os.SystemClock.elapsedRealtime() - started) } }
        catch (error: Exception) { SupportEvents.record(context, stage, EventJournal.failure(error, stage), android.os.SystemClock.elapsedRealtime() - started); throw error }
    }
    private fun scanSlice(source: LocalSource): Boolean {
        val queue = context.fileArchives(); val state = queue.configure(source); val generation = state.getString("generation"); val root = Uri.parse(source.uri)
        if (!source.tree) {
            val item = metadata(root, source) ?: throw IllegalStateException(MoteI18n.text("所选文件不可用"))
            if (SourceRules.include(item.getString("title"), source)) queue.observe(source, item, generation)
            queue.finish(source, generation) { false }; return true
        }
        val stack = state.optJSONArray("stack") ?: JSONArray().put(JSONObject().put("id", DocumentsContract.getTreeDocumentId(root)).put("offset", 0).put("path", ""))
        var examined = 0
        while (stack.length() > 0 && examined < 200) {
            cancel.throwIfCanceled()
            val current = stack.getJSONObject(stack.length() - 1); val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, current.getString("id"))
            var finished = true; val nested = mutableListOf<JSONObject>()
            resolver.query(children, projection, null, null, null, cancel)?.use { c ->
                var index = 0
                while (c.moveToNext()) {
                    if (index++ < current.getInt("offset")) continue
                    if (examined++ >= 200) { finished = false; break }
                    cancel.throwIfCanceled(); current.put("offset", index)
                    val name = c.getString(1) ?: "file"; val path = (current.getString("path").takeIf { it.isNotEmpty() }?.plus("/") ?: "") + name
                    if (SourceRules.patterns(source.excluded).any { it.matches(path) }) continue
                    val documentId = c.getString(0)
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                        check(path.count { it == '/' } < 32) { MoteI18n.text("目录层级超过上限") }
                        nested.add(JSONObject().put("id", documentId).put("offset", 0).put("path", path))
                    } else if (SourceRules.include(path, source)) {
                        val uri = DocumentsContract.buildDocumentUriUsingTree(root, documentId)
                        val item = metadata(uri, source) ?: throw IllegalStateException(MoteI18n.text("文件枚举期间不可用"))
                        queue.observe(source, item.put("_relativePath", path), generation)
                    }
                }
            } ?: throw IllegalStateException(MoteI18n.text("目录不可用，保留已有档案"))
            if (finished) stack.remove(stack.length() - 1)
            nested.forEach { stack.put(it) }; check(stack.length() <= 10000) { MoteI18n.text("待扫描目录超过上限") }
            state.put("stack", stack).put("scanComplete", false); queue.saveState(source.id, state)
        }
        if (stack.length() == 0) {
            queue.finish(source, generation) { external ->
                // A permissions/provider failure is unknown, never a removal.
                runCatching { resolver.query(Uri.parse(external), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null, cancel)?.use { !it.moveToFirst() } ?: false }.getOrDefault(false)
            }; return true
        }
        return false
    }
    fun prepare(source: LocalSource, anchor: ((String) -> String?)? = null) = measured(EventStage.FILE_PREPARE) { context.fileArchives().prepare(source, anchor = anchor,
        open = { resolver.openInputStream(Uri.parse(it.getString("uri"))) ?: throw IllegalStateException(MoteI18n.text("文件无法打开")) },
        unchanged = { old -> metadata(Uri.parse(old.getString("uri")), source)?.let { context.fileArchives().signature(it) == context.fileArchives().signature(JSONObject(old.toString()).apply { remove("_relativePath") }) } ?: false }) }
}

object FileUpload {
    /** Bounded response decoding also works on Android 10–12 (no readNBytes API). */
    internal fun readResponse(input: java.io.InputStream): ByteArray {
        val limit = 1024 * 1024
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
            if (count < 0) break
            check(output.size() + count <= limit) { MoteI18n.text("中央响应超过 1 MiB") }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun request(context: Context, stage: EventStage, config: CollectorConfig, path: String, method: String, body: ByteArray? = null, binary: Boolean = false): JSONObject {
        val started = android.os.SystemClock.elapsedRealtime()
        SupportEvents.record(context, stage, EventCode.STARTED)
        val connection = URL(config.server.trimEnd('/') + path).openConnection() as HttpURLConnection
        var status: Int? = null
        try {
            connection.instanceFollowRedirects = false; connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.setRequestProperty("Accept-Language", MoteI18n.language())
            connection.setRequestProperty("Authorization", "Bearer ${config.token}")
            if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", if (binary) "application/octet-stream" else "application/json"); connection.setFixedLengthStreamingMode(body.size); connection.outputStream.use { out -> var offset = 0; while (offset < body.size) { val count = minOf(64 * 1024, body.size - offset); out.write(body, offset, count); offset += count; UploadMeter.add(count.toLong()) } } }
            status = connection.responseCode
            check(status in 200..299) { if (connection.responseCode == 404) MoteI18n.text("中央未支持文件同步，请先升级") else MoteI18n.text("中央未确认文件（HTTP {0}）", connection.responseCode) }
            val bytes = connection.inputStream.use { readResponse(it) }
            return JSONObject(String(bytes, Charsets.UTF_8)).also { SupportEvents.record(context, stage, EventCode.OK, android.os.SystemClock.elapsedRealtime() - started, status) }
        } catch (error: Exception) { SupportEvents.record(context, stage, status?.takeIf { it !in 200..299 }?.let { EventJournal.httpFailure(it) } ?: EventJournal.failure(error, stage), android.os.SystemClock.elapsedRealtime() - started, status); throw error } finally { connection.disconnect() }
    }
    /** At most two network parts per dispatch so other record queues can run. */
    fun sync(context: Context, source: LocalSource, config: CollectorConfig, stillSelected: () -> Boolean): Boolean {
        val queue = context.fileArchives(); val row = queue.next(source.id) ?: FileSources(context).prepare(source) { external ->
            check(stillSelected())
            val q = "sourceId=" + java.net.URLEncoder.encode(source.id, "UTF-8") + "&externalId=" + java.net.URLEncoder.encode(external, "UTF-8")
            val head = request(context, EventStage.FILE_UPLOAD, config, "/api/file-sync/v1/head?$q", "GET")
            check(!head.optBoolean("forgotten")) { MoteI18n.text("中央已忘记此文件，需要在中央重新允许同步") }
            head.optString("revision").takeIf { head.has("revision") && !head.isNull("revision") && it.isNotEmpty() }
        } ?: return queue.pendingCount(source.id) == 0
        fun checkSelection() { check(stillSelected()); check(SyncSchedule.waitingReason(context, config) == null) }
        checkSelection()
        val pending = row.getJSONObject("pending"); val manifest = pending.getJSONObject("manifest"); val item = manifest.getJSONObject("item")
        if (!manifest.has("sha256")) {
            val ack = request(context, EventStage.FILE_UPLOAD, config, "/api/file-sync/v1/revisions", "PUT", manifest.toString().toByteArray(Charsets.UTF_8)); checkSelection(); queue.acknowledge(source.id, row, ack); return queue.pendingCount(source.id) == 0
        }
        val begun = request(context, EventStage.FILE_UPLOAD, config, "/api/file-sync/v1/uploads", "POST", manifest.toString().toByteArray(Charsets.UTF_8))
        val uploadId = begun.getString("uploadId"); check(uploadId.matches(Regex("[a-fA-F0-9-]{36}"))); check(begun.getInt("partBytes") == FileArchiveQueue.PART_BYTES)
        begun.optJSONObject("ack")?.let { ack -> checkSelection(); queue.acknowledge(source.id, row, ack); return queue.pendingCount(source.id) == 0 }
        val parts = begun.getJSONArray("parts"); val received = (0 until parts.length()).map { parts.getJSONObject(it).getInt("part") }.toSet()
        val total = ((manifest.getLong("sizeBytes") + FileArchiveQueue.PART_BYTES - 1) / FileArchiveQueue.PART_BYTES).toInt(); var sent = 0
        for (part in 0 until total) if (part !in received) {
            if (sent++ >= 2) return false
            checkSelection(); val bytes = queue.part(source.id, part)
            val ack = request(context, EventStage.FILE_PART, config, "/api/file-sync/v1/uploads/$uploadId/parts/$part", "PUT", bytes, true)
            val hash = MessageDigestCompat.hash(bytes)
            check(ack.getInt("part") == part && ack.getInt("bytes") == bytes.size && ack.getString("hash") == hash) { MoteI18n.text("文件块确认不匹配") }
        }
        checkSelection(); val ack = request(context, EventStage.FILE_COMMIT, config, "/api/file-sync/v1/uploads/$uploadId/commit", "POST", "{}".toByteArray()); checkSelection(); queue.acknowledge(source.id, row, ack)
        return queue.pendingCount(source.id) == 0
    }
}
private object MessageDigestCompat { fun hash(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } }
