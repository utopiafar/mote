package dev.mote.collector

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.File

/** Current-format private metadata, independent of original retention and the bounded operation log. */
internal class CaptureUploadHistory(private val file: File, private val cipher: ByteCipher) : CaptureReceiptStore, CaptureAttemptStore {
    companion object { private val lock = Any() }
    private fun <T> database(action: (SQLiteDatabase) -> T): T = try { synchronized(lock) {
        check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            // Expired ciphertext must also leave free database pages, journals and WAL files.
            db.rawQuery("PRAGMA secure_delete=ON", null).use { check(it.moveToFirst() && it.getInt(0) == 1) }
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { check(it.moveToFirst() && it.getString(0).equals("delete", ignoreCase = true)) }
            check(db.version in 0..1) { MoteI18n.text(LocalDataFormat.RESET_MESSAGE) }
            if (db.version == 0) {
                db.beginTransaction()
                try {
                    db.execSQL("CREATE TABLE received (item_key TEXT PRIMARY KEY, scope TEXT NOT NULL, received_at INTEGER NOT NULL, payload BLOB NOT NULL)")
                    db.execSQL("CREATE INDEX received_scope_time ON received(scope, received_at DESC, item_key)")
                    db.execSQL("CREATE TABLE pending_completion (item_key TEXT PRIMARY KEY, scope TEXT NOT NULL, payload BLOB NOT NULL)")
                    db.execSQL("CREATE TABLE attempts (id TEXT PRIMARY KEY, scope TEXT NOT NULL, started_at INTEGER NOT NULL, process TEXT NOT NULL, state TEXT NOT NULL, payload BLOB NOT NULL)")
                    db.execSQL("CREATE INDEX attempts_scope_time ON attempts(scope, started_at DESC, id)")
                    db.execSQL("CREATE INDEX attempts_unfinished ON attempts(scope, state, process)")
                    db.version = 1; db.setTransactionSuccessful()
                } finally { db.endTransaction() }
            }
            action(db)
        }
    } } catch (error: Exception) { throw if (error is UploadHistoryUnavailable) error else UploadHistoryUnavailable(error) }
    override fun received(receipt: CaptureUploadReceipt): CaptureUploadCompletion = database { db ->
        db.beginTransaction()
        try {
            val unfinished = db.rawQuery("SELECT payload FROM pending_completion WHERE item_key=?", arrayOf(receipt.itemKey)).use { if (it.moveToFirst()) decodeCompletion(it.getBlob(0)) else null }
            val existing = db.rawQuery("SELECT payload FROM received WHERE item_key=?", arrayOf(receipt.itemKey)).use { if (it.moveToFirst()) decode(it.getBlob(0)) else null }
            val canonical = existing ?: receipt
            val payload = cipher.seal(canonical.json().toString().toByteArray(Charsets.UTF_8))
            val values = ContentValues().apply { put("item_key", receipt.itemKey); put("scope", receipt.scope); put("received_at", receipt.receivedAt); put("payload", payload) }
            // If history expired while transport completion was interrupted, a duplicate must
            // not resurrect it or restart its clock. The minimal marker is sufficient to finish.
            if (unfinished == null || existing != null) db.insertWithOnConflict("received", null, values, SQLiteDatabase.CONFLICT_IGNORE).let { result ->
                // IGNORE is allowed only for an existing exact identity, never for a failed write.
                if (result == -1L) db.rawQuery("SELECT item_key FROM received WHERE item_key=?", arrayOf(receipt.itemKey)).use { check(it.moveToFirst()) }
            }
            val completion = ContentValues().apply { put("item_key", receipt.itemKey); put("scope", receipt.scope); put("payload", cipher.seal((unfinished ?: canonical.completion()).json().toString().toByteArray(Charsets.UTF_8))) }
            check(db.insertWithOnConflict("pending_completion", null, completion, SQLiteDatabase.CONFLICT_IGNORE) != -1L ||
                db.rawQuery("SELECT item_key FROM pending_completion WHERE item_key=?", arrayOf(receipt.itemKey)).use { it.moveToFirst() })
            val saved = db.rawQuery("SELECT payload FROM pending_completion WHERE item_key=?", arrayOf(receipt.itemKey)).use { check(it.moveToFirst()); decodeCompletion(it.getBlob(0)) }
            db.setTransactionSuccessful()
            saved
        } finally { db.endTransaction() }
    }
    override fun pending(scope: String): List<CaptureUploadCompletion> = database { db ->
        db.rawQuery("SELECT payload FROM pending_completion WHERE scope=? ORDER BY item_key", arrayOf(scope)).use { cursor ->
            buildList { while (cursor.moveToNext()) add(decodeCompletion(cursor.getBlob(0))) }
        }
    }
    override fun completed(itemKey: String) { database { it.delete("pending_completion", "item_key=?", arrayOf(itemKey)) } }
    override fun saveAttempt(attempt: CaptureUploadAttempt) { database { db ->
        val values = ContentValues().apply { put("id", attempt.id); put("scope", attempt.scope); put("started_at", attempt.startedAt); put("process", attempt.process); put("state", attempt.state); put("payload", cipher.seal(attempt.json().toString().toByteArray(Charsets.UTF_8))) }
        check(db.insertWithOnConflict("attempts", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
    } }
    /** Only the exclusive capture worker may include its own process; app startup can overlap it. */
    fun recoverInterrupted(scope: String, process: String, includeCurrentProcess: Boolean = false) {
        database { db ->
            val processFilter = if (includeCurrentProcess) "" else " AND process<>?"
            val args = if (includeCurrentProcess) arrayOf(scope) else arrayOf(scope, process)
            val rows = db.rawQuery("SELECT payload FROM attempts WHERE scope=? AND state='sending'$processFilter", args).use { cursor ->
                buildList { while (cursor.moveToNext()) add(CaptureUploadAttempt.parse(JSONObject(String(cipher.open(cursor.getBlob(0)), Charsets.UTF_8)))) }
            }
            rows.filter { it.state == "sending" && (includeCurrentProcess || it.process != process) }.forEach { attempt ->
                val values = ContentValues().apply { put("state", "unknown"); put("payload", cipher.seal(attempt.copy(state = "unknown", reason = "interrupted").json().toString().toByteArray(Charsets.UTF_8))) }
                db.update("attempts", values, "id=?", arrayOf(attempt.id))
            }
        }
    }
    fun attempts(scope: String, before: Pair<Long, String>? = null, limit: Int = 50, days: Int = UploadHistoryRetention.DEFAULT_DAYS, now: Long = System.currentTimeMillis()): List<CaptureUploadAttempt> = database { db ->
        require(limit in 1..100); UploadHistoryRetention.validate(days)
        val seek = if (before == null) "" else " AND (started_at<? OR (started_at=? AND id>?))"
        val args = arrayOf(scope, (now - days * 86_400_000L).toString()) + (before?.let { arrayOf(it.first.toString(), it.first.toString(), it.second) } ?: emptyArray()) + arrayOf(limit.toString())
        db.rawQuery("SELECT payload FROM attempts WHERE scope=? AND started_at>?$seek ORDER BY started_at DESC,id LIMIT ?", args).use { cursor ->
            buildList { while (cursor.moveToNext()) add(CaptureUploadAttempt.parse(JSONObject(String(cipher.open(cursor.getBlob(0)), Charsets.UTF_8)))) }
        }
    }
    private fun decode(bytes: ByteArray) = CaptureUploadReceipt.parse(JSONObject(String(cipher.open(bytes), Charsets.UTF_8)))
    private fun decodeCompletion(bytes: ByteArray) = CaptureUploadCompletion.parse(JSONObject(String(cipher.open(bytes), Charsets.UTF_8)))
    fun page(scope: String, before: Pair<Long, String>? = null, limit: Int = 50, days: Int = UploadHistoryRetention.DEFAULT_DAYS, now: Long = System.currentTimeMillis()): List<CaptureUploadReceipt> = database { db ->
        require(limit in 1..100)
        UploadHistoryRetention.validate(days)
        val seek = if (before == null) "" else " AND (received_at<? OR (received_at=? AND item_key>?))"
        val args = arrayOf(scope, (now - days * 86_400_000L).toString()) + (before?.let { arrayOf(it.first.toString(), it.first.toString(), it.second) } ?: emptyArray()) + arrayOf(limit.toString())
        db.rawQuery("SELECT payload FROM received WHERE scope=? AND received_at>?$seek ORDER BY received_at DESC,item_key LIMIT ?", args).use { cursor ->
            buildList { while (cursor.moveToNext()) add(decode(cursor.getBlob(0))) }
        }
    }
    /** Only user-visible upload history expires. Unfinished completion markers are transport state. */
    fun prune(days: Int, now: Long = System.currentTimeMillis()): Int = database { db ->
        UploadHistoryRetention.validate(days)
        val args = arrayOf((now - days * 86_400_000L).toString())
        db.beginTransaction()
        try {
            val count = db.delete("received", "received_at<=?", args) + db.delete("attempts", "started_at<=?", args)
            db.setTransactionSuccessful(); count
        } finally { db.endTransaction() }
    }
}

internal object UploadHistoryRetention {
    const val DEFAULT_DAYS = 30
    val choices = listOf(7, 30, 90, 365)
    fun validate(days: Int) { require(days in choices) }
    fun read(context: Context): Int = context.getSharedPreferences("upload-history", Context.MODE_PRIVATE).getInt("days", DEFAULT_DAYS).also(::validate)
    fun save(context: Context, days: Int) {
        validate(days)
        check(context.getSharedPreferences("upload-history", Context.MODE_PRIVATE).edit().putInt("days", days).commit())
        context.captureUploadHistory().prune(days)
    }
}

internal fun Context.captureUploadHistory(): CaptureUploadHistory {
    LocalDataFormat.requireCurrent(this)
    return CaptureUploadHistory(File(noBackupFilesDir, "upload-history/received.sqlite"), secretBox())
}
