package dev.mote.collector

import android.content.ContentResolver
import android.content.Context
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.CancellationSignal
import android.provider.DocumentsContract
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Process-local observers wake the existing worker and invalidate unfinished scans. */
internal object SafChanges {
    internal class Watch(val uri: String, val observer: ContentObserver, val sequence: AtomicLong, val id: String)
    private val watches = mutableMapOf<String, Watch>()
    private val executor = Executors.newSingleThreadExecutor()
    @Synchronized fun watch(context: Context, source: LocalSource, lease: SourceLease): Watch {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath + ":" + source.id
        watches[key]?.takeIf { it.uri == source.uri }?.let { return it }
        watches.remove(key)?.let { it.sequence.incrementAndGet(); app.contentResolver.unregisterContentObserver(it.observer) }
        val sequence = AtomicLong()
        val scheduled = AtomicBoolean()
        val observer = object : ContentObserver(null) {
            override fun onChange(selfChange: Boolean) {
                sequence.incrementAndGet()
                if (!scheduled.compareAndSet(false, true)) return
                executor.execute {
                    try {
                        val current = app.localSources().sources().firstOrNull { it.id == source.id && it.enabled && it.uri == source.uri } ?: return@execute
                        val currentLease = app.localSources().lease(current) ?: return@execute
                        app.fileArchives().providerChanged(current, currentLease)
                        SourceWork.schedule(app, manual = true)
                    } finally { scheduled.set(false) }
                }
            }
        }
        val authority = Uri.parse(source.uri).authority ?: throw SafScanIncomplete()
        app.contentResolver.registerContentObserver(Uri.Builder().scheme("content").authority(authority).build(), true, observer)
        val watch = Watch(source.uri!!, observer, sequence, UUID.randomUUID().toString())
        watches[key] = watch
        // A process may have been absent when the provider changed content without
        // changing size or mtime. Recheck bytes once after observing starts.
        app.fileArchives().providerChanged(source, lease)
        return watch
    }
    @Synchronized fun stop(context: Context, sourceId: String) {
        val app = context.applicationContext
        watches.remove(app.noBackupFilesDir.absolutePath + ":" + sourceId)?.let {
            it.sequence.incrementAndGet(); app.contentResolver.unregisterContentObserver(it.observer)
        }
    }
    @Synchronized fun version(context: Context, source: LocalSource): Pair<String, Long>? =
        watches[context.applicationContext.noBackupFilesDir.absolutePath + ":" + source.id]
            ?.takeIf { it.uri == source.uri }?.let { it.id to it.sequence.get() }
}

internal class AndroidSafProvider(private val context: Context, private val source: LocalSource,
                                  private val lease: SourceLease, private val cancel: CancellationSignal) : SafScanProvider {
    private val resolver = context.contentResolver
    private val tree = Uri.parse(source.uri)
    private val watch = SafChanges.watch(context, source, lease)
    private val sequence = watch.sequence.get()
    override val watcher = watch.id
    override fun checkAccess() {
        cancel.throwIfCanceled()
        if (!context.localSources().current(lease)) throw SourceLeaseRevoked()
        if (!SourceAccess.available(context, source)) throw SecurityException("Persisted document access was revoked")
        if (watch.sequence.get() != sequence) throw SafScanIncomplete()
    }
    override fun root(): SafDocument? {
        checkAccess()
        val uri = if (source.tree) DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)) else tree
        return readDocument(resolver, uri, cancel)
    }
    override fun document(uri: String): SafDocument? { checkAccess(); return readDocument(resolver, Uri.parse(uri), cancel) }
    override fun children(parent: String, visit: (SafDocument) -> Boolean): SafChildrenResult {
        checkAccess()
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        val cursor = resolver.query(uri, PROJECTION, null, null, null, cancel) ?: throw SafScanIncomplete()
        return cursor.use { c ->
            if (!complete(c)) return@use SafChildrenResult.INCOMPLETE
            while (c.moveToNext()) {
                val id = c.getString(0) ?: throw SafScanIncomplete()
                val document = decode(c, DocumentsContract.buildDocumentUriUsingTree(tree, id))
                if (!visit(document)) return@use SafChildrenResult.STOPPED
            }
            if (complete(c)) SafChildrenResult.COMPLETE else SafChildrenResult.INCOMPLETE
        }
    }
    override fun absent(uri: String): Boolean {
        checkAccess()
        val missing = readDocument(resolver, Uri.parse(uri), cancel) == null
        checkAccess()
        // Even an empty, reachable root must still be the originally selected root.
        if (root()?.let { !it.directory } != false) throw SafScanIncomplete()
        return missing
    }
    companion object {
        private val PROJECTION = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        private fun complete(cursor: Cursor): Boolean = !cursor.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false) && !cursor.extras.containsKey(DocumentsContract.EXTRA_ERROR)
        private fun decode(c: Cursor, uri: Uri): SafDocument {
            val id = c.getString(0) ?: throw SafScanIncomplete()
            val mime = c.getString(2) ?: "application/octet-stream"
            return SafDocument(id, uri.toString(), c.getString(1) ?: "file", mime,
                if (c.isNull(3)) null else c.getLong(3), if (c.isNull(4)) null else c.getLong(4), mime == DocumentsContract.Document.MIME_TYPE_DIR)
        }
        fun readDocument(resolver: ContentResolver, uri: Uri, cancel: CancellationSignal): SafDocument? {
            val cursor = resolver.query(uri, PROJECTION, null, null, null, cancel) ?: throw SafScanIncomplete()
            return cursor.use { c ->
                if (!complete(c)) throw SafScanIncomplete()
                if (!c.moveToFirst()) return@use null
                val document = decode(c, uri)
                if (SafIdentity.document(uri.toString())?.second != document.id) throw SafScanIncomplete()
                if (!complete(c)) throw SafScanIncomplete()
                document
            }
        }
    }
}
