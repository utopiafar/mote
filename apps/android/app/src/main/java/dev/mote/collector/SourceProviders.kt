package dev.mote.collector

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.CancellationSignal
import android.provider.CalendarContract
import android.provider.DocumentsContract
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import org.json.JSONObject

fun Context.localSources(): LocalSourceStore {
    IngressV2Migration.ensure(this)
    return LocalSourceStore(File(noBackupFilesDir, "local-sources"), localContentCipher()).apply {
        onMutation = { LocalStateChanges.changed() }
    }
}

object SourceAccess {
    fun available(context: Context, source: LocalSource): Boolean = SourceAdapters.default.forKind(source.kind).available(context, source)
}

data class CalendarChoice(val id: Long, val name: String, val visible: Boolean)
class SourceProviders(private val resolver: ContentResolver, private val cancellation: CancellationSignal = CancellationSignal(),
    private val calendarsUri: Uri = CalendarContract.Calendars.CONTENT_URI, private val instancesUri: Uri = CalendarContract.Instances.CONTENT_URI) {
    fun calendars(): List<CalendarChoice> = resolver.query(calendarsUri,
        arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.VISIBLE), null, null, CalendarContract.Calendars._ID + " ASC", cancellation)?.use { cursor ->
        buildList { while (cursor.moveToNext()) { check(size < 1000); add(CalendarChoice(cursor.getLong(0), cursor.getString(1) ?: MoteI18n.text("未命名日历"), cursor.getInt(2) != 0)) } }
    } ?: throw IllegalStateException(MoteI18n.text("日历提供者不可用"))

    fun scan(source: LocalSource, now: Instant = Instant.now()): SourceScan = if (source.kind == "local-calendar") calendar(source, now) else files(source, now)
    private fun calendar(source: LocalSource, now: Instant): SourceScan {
        check(calendars().any { it.id == source.calendarId && it.visible }) { MoteI18n.text("已选择日历不可用，请重新连接；不会把权限丢失视为删除") }
        val from = now.minusSeconds(source.daysBefore * 86400L).toEpochMilli(); val until = now.plusSeconds(source.daysAfter * 86400L).toEpochMilli()
        val uri = instancesUri.buildUpon().also { ContentUris.appendId(it, from); ContentUris.appendId(it, until) }.build()
        val projection = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
            CalendarContract.Events.TITLE, if (source.retention == "reference") CalendarContract.Events.TITLE else CalendarContract.Events.DESCRIPTION,
            if (source.retention == "reference") CalendarContract.Events.TITLE else CalendarContract.Events.EVENT_LOCATION,
            CalendarContract.Events.ALL_DAY, CalendarContract.Events.EVENT_TIMEZONE, CalendarContract.Events.STATUS,
            CalendarContract.Events.ORIGINAL_INSTANCE_TIME, CalendarContract.Events.RRULE, CalendarContract.Events.RDATE, CalendarContract.Events.ORIGINAL_ID)
        val items = mutableListOf<JSONObject>(); var complete = true; var bytes = 0; var skipped = 0
        resolver.query(uri, projection, "${CalendarContract.Events.CALENDAR_ID}=?", arrayOf(source.calendarId.toString()), CalendarContract.Instances.BEGIN + " ASC", cancellation)?.use { cursor ->
            while (cursor.moveToNext()) {
                cancellation.throwIfCanceled()
                if (items.size >= SourceRules.SCAN_ITEMS) { complete = false; skipped++; break }
                val eventId = cursor.getLong(0); val begin = cursor.getLong(1); val end = cursor.getLong(2)
                val title = cursor.getString(3) ?: ""; val description = cursor.getString(4) ?: ""; val location = cursor.getString(5) ?: ""
                if (title.length > 2000 || description.length + location.length + 8 > 100000 || end < begin) { complete = false; skipped++; continue }
                val status = when (cursor.getInt(8)) { CalendarContract.Events.STATUS_CANCELED -> "cancelled"; CalendarContract.Events.STATUS_TENTATIVE -> "tentative"; else -> "confirmed" }
                val instance = if (cursor.isNull(9)) begin else cursor.getLong(9)
                val recurring = !cursor.isNull(9) || !cursor.getString(10).isNullOrBlank() || !cursor.getString(11).isNullOrBlank()
                val stableEvent = if (cursor.isNull(12)) eventId else cursor.getLong(12)
                val externalId = "calendar:${source.calendarId}:$stableEvent" + if (recurring) ":$instance" else ""
                val body = JSONObject().put("externalId", externalId).put("observedAt", now.toString())
                    .put("title", title).put("text", if (source.retention == "reference") "" else description + if (location.isNotEmpty()) MoteI18n.text("\n地点：{0}", location) else "")
                    .put("kind", "calendar").put("layer", source.retention).put("uri", ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId).toString())
                    .put("calendar", JSONObject().put("start", Instant.ofEpochMilli(begin).toString()).put("end", Instant.ofEpochMilli(end).toString())
                        .put("allDay", cursor.getInt(6) != 0).put("timeZone", cursor.getString(7) ?: "UTC").put("status", status))
                bytes += body.toString().toByteArray().size
                if (bytes > SourceRules.SCAN_BYTES) { complete = false; skipped++; break }
                items.add(body)
            }
        } ?: throw IllegalStateException(MoteI18n.text("日历提供者没有返回扫描结果"))
        return SourceScan(items, complete, now.toString(), from, until, skipped)
    }
    private data class Document(val id: String, val name: String, val mime: String, val size: Long?, val modified: Long?)
    private val documentProjection = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
    private fun row(cursor: Cursor) = Document(cursor.getString(0), cursor.getString(1) ?: "", cursor.getString(2) ?: "application/octet-stream",
        if (cursor.isNull(3)) null else cursor.getLong(3), if (cursor.isNull(4)) null else cursor.getLong(4))
    private fun files(source: LocalSource, now: Instant): SourceScan {
        val root = Uri.parse(source.uri); val items = mutableListOf<JSONObject>(); val visited = mutableSetOf<String>()
        var complete = true; var skipped = 0; var bytes = 0; var examined = 0
        fun accept(doc: Document, uri: Uri, path: String) {
            if (!SourceRules.include(path, source)) return
            if (items.size >= SourceRules.SCAN_ITEMS || doc.name.length > 2000 || uri.toString().length > 1000 || (doc.size ?: 0) > SourceRules.FILE_BYTES) { complete = false; skipped++; return }
            var text = ""
            if (source.retention == "snapshot") {
                try {
                    resolver.openInputStream(uri)?.use { input ->
                        val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { cancellation.throwIfCanceled(); val count = input.read(buffer); if (count < 0) break; check(output.size() + count <= SourceRules.FILE_BYTES); output.write(buffer, 0, count) }
                        text = SourceRules.utf8(output.toByteArray())
                    } ?: throw IllegalStateException(MoteI18n.text("文件不可读"))
                } catch (error: SecurityException) { throw error }
                catch (error: android.os.OperationCanceledException) { throw error }
                catch (_: Exception) { complete = false; skipped++; return }
            }
            val body = JSONObject().put("externalId", uri.toString()).put("observedAt", now.toString()).put("title", doc.name).put("text", text)
                .put("uri", uri.toString()).put("kind", "file").put("layer", source.retention).put("mimeType", doc.mime.take(200))
            doc.modified?.takeIf { it > 0 }?.let { body.put("modifiedAt", Instant.ofEpochMilli(it).toString()) }
            doc.size?.takeIf { it >= 0 }?.let { body.put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", it))) }
            bytes += body.toString().toByteArray().size
            if (bytes > SourceRules.SCAN_BYTES) { complete = false; skipped++; return }
            items.add(body)
        }
        fun walk(id: String, path: String, depth: Int) {
            if (depth > 12 || examined >= 2000 || items.size >= SourceRules.SCAN_ITEMS || bytes > SourceRules.SCAN_BYTES) { complete = false; skipped++; return }
            if (!visited.add(id)) { complete = false; skipped++; return }
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, id)
            resolver.query(children, documentProjection, null, null, null, cancellation)?.use { cursor ->
                while (cursor.moveToNext()) {
                    cancellation.throwIfCanceled(); examined++
                    if (examined > 2000) { complete = false; skipped++; break }
                    val doc = row(cursor); val childPath = if (path.isEmpty()) doc.name else "$path/${doc.name}"
                    if (SourceRules.patterns(source.excluded).any { it.matches(childPath) }) continue
                    if (doc.mime == DocumentsContract.Document.MIME_TYPE_DIR) walk(doc.id, childPath, depth + 1)
                    else accept(doc, DocumentsContract.buildDocumentUriUsingTree(root, doc.id), childPath)
                }
            } ?: throw IllegalStateException(MoteI18n.text("文件目录不可用"))
        }
        if (source.tree) walk(DocumentsContract.getTreeDocumentId(root), "", 0)
        else resolver.query(root, documentProjection, null, null, null, cancellation)?.use { cursor ->
            check(cursor.moveToFirst()) { MoteI18n.text("所选文件暂不可用；不会把访问失败视为删除") }; accept(row(cursor), root, cursor.getString(1) ?: "")
        } ?: throw IllegalStateException(MoteI18n.text("文件提供者不可用"))
        return SourceScan(items, complete, now.toString(), skipped = skipped)
    }
}
