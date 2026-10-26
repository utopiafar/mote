package dev.mote.collector

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.File

/** Independent current-format metadata for non-capture lanes. Never stores original bodies. */
internal class ItemUploadHistory(private val file: File, private val cipher: ByteCipher) {
    companion object { private val lock = Any() }
    private fun <T> database(action: (SQLiteDatabase) -> T): T = try { synchronized(lock) {
        check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            db.rawQuery("PRAGMA secure_delete=ON", null).use { check(it.moveToFirst() && it.getInt(0) == 1) }
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { check(it.moveToFirst() && it.getString(0).equals("delete", true)) }
            check(db.version in 0..1)
            if (db.version == 0) {
                db.beginTransaction()
                try {
                    for (table in listOf("attempts", "received", "pending_completion")) {
                        db.execSQL("CREATE TABLE $table (id TEXT PRIMARY KEY, scope TEXT NOT NULL, lane TEXT NOT NULL, at INTEGER NOT NULL, payload BLOB NOT NULL)")
                        db.execSQL("CREATE INDEX ${table}_scope_time ON $table(scope, at DESC, id)")
                    }
                    db.version = 1; db.setTransactionSuccessful()
                } finally { db.endTransaction() }
            }
            action(db)
        }
    } } catch (error: Exception) { throw if (error is UploadHistoryUnavailable) error else UploadHistoryUnavailable(error) }
    private fun payload(value: JSONObject) = cipher.seal(value.toString().toByteArray(Charsets.UTF_8))
    private fun decode(value: ByteArray) = JSONObject(String(cipher.open(value), Charsets.UTF_8))
    private fun get(db: SQLiteDatabase, table: String, id: String): JSONObject? = db.rawQuery("SELECT payload FROM $table WHERE id=?", arrayOf(id)).use { if (it.moveToFirst()) decode(it.getBlob(0)) else null }
    private fun put(db: SQLiteDatabase, table: String, id: String, identity: ItemUploadIdentity, at: Long, value: JSONObject) {
        val row = ContentValues().apply { put("id", id); put("scope", identity.scope); put("lane", identity.lane); put("at", at); put("payload", payload(value)) }
        check(db.insertWithOnConflict(table, null, row, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
    }
    fun save(attempt: ItemUploadAttempt) { database { put(it, "attempts", attempt.id, attempt.identity, attempt.startedAt, attempt.json()) } }
    /** Confirm + marker precede local completion; expired history cannot be revived by a marker. */
    fun received(receipt: ItemUploadReceipt): ItemUploadReceipt = database { db ->
        db.beginTransaction()
        try {
            val pending = get(db, "pending_completion", receipt.identity.key)?.let(ItemUploadReceipt::parse)
            val existing = get(db, "received", receipt.identity.key)?.let(ItemUploadReceipt::parse)
            val canonical = existing ?: pending ?: receipt
            check(canonical.captureId == receipt.captureId) { "Confirmed item locator changed for the same exact identity" }
            if (existing != null || pending == null) put(db, "received", receipt.identity.key, canonical.identity, canonical.receivedAt, canonical.json())
            // A fresh validated replay may update the local target binding, never the first receipt time.
            val completion = receipt.copy(receivedAt = canonical.receivedAt)
            put(db, "pending_completion", receipt.identity.key, completion.identity, completion.receivedAt, completion.json())
            db.setTransactionSuccessful(); completion
        } finally { db.endTransaction() }
    }
    fun completed(key: String) { database { it.delete("pending_completion", "id=?", arrayOf(key)) } }
    fun pending(scope: String, lane: String): List<ItemUploadReceipt> = database { db ->
        db.rawQuery("SELECT payload FROM pending_completion WHERE scope=? AND lane=? ORDER BY id", arrayOf(scope, lane)).use { cursor ->
            buildList { while (cursor.moveToNext()) add(ItemUploadReceipt.parse(decode(cursor.getBlob(0)))) }
        }
    }
    private fun page(table: String, scope: String, before: Pair<Long, String>?, limit: Int, days: Int, now: Long): List<JSONObject> = database { db ->
        require(limit in 1..100); UploadHistoryRetention.validate(days)
        val seek = if (before == null) "" else " AND (at<? OR (at=? AND id>?))"
        val args = arrayOf(scope, (now - days * 86_400_000L).toString()) + (before?.let { arrayOf(it.first.toString(), it.first.toString(), it.second) } ?: emptyArray()) + arrayOf(limit.toString())
        db.rawQuery("SELECT payload FROM $table WHERE scope=? AND at>?$seek ORDER BY at DESC,id LIMIT ?", args).use { cursor -> buildList { while(cursor.moveToNext()) add(decode(cursor.getBlob(0))) } }
    }
    fun attempts(scope: String, before: Pair<Long, String>? = null, limit: Int = 100, days: Int = 30, now: Long = System.currentTimeMillis()) = page("attempts", scope, before, limit, days, now).map(ItemUploadAttempt::parse)
    fun receipts(scope: String, before: Pair<Long, String>? = null, limit: Int = 100, days: Int = 30, now: Long = System.currentTimeMillis()) = page("received", scope, before, limit, days, now).map(ItemUploadReceipt::parse)
    fun recoverInterrupted(scope: String, lane: String, process: String, includeCurrent: Boolean = false) { database { db ->
        val rows = db.rawQuery("SELECT payload FROM attempts WHERE scope=? AND lane=?", arrayOf(scope, lane)).use { cursor -> buildList { while(cursor.moveToNext()) add(ItemUploadAttempt.parse(decode(cursor.getBlob(0)))) } }
        rows.filter { it.state == "sending" && (includeCurrent || it.process != process) }.forEach { old ->
            val next = old.copy(state = "unknown", reason = "interrupted")
            put(db, "attempts", next.id, next.identity, next.startedAt, next.json())
        }
    } }
    fun prune(days: Int, now: Long = System.currentTimeMillis()): Int = database { db ->
        UploadHistoryRetention.validate(days); db.beginTransaction()
        try {
            val args = arrayOf((now - days * 86_400_000L).toString())
            val count = db.delete("attempts", "at<=?", args) + db.delete("received", "at<=?", args)
            db.setTransactionSuccessful(); count
        } finally { db.endTransaction() }
    }
}
internal fun Context.itemUploadHistory(): ItemUploadHistory {
    LocalDataFormat.requireCurrent(this)
    return ItemUploadHistory(File(noBackupFilesDir, "upload-history/items.sqlite"), secretBox())
}
