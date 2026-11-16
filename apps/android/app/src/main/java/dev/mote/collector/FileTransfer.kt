package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Exact JSON byte offsets and fixed request resources, independent of storage policy. */
internal object FileTransfer {
    const val MAX_BYTES = 9007199254740991L
    const val PART_BYTES = 4 * 1024 * 1024
    const val RECEIPTS = 256
    fun count(size: Long): Long { require(size in 0..MAX_BYTES); return (size + PART_BYTES - 1) / PART_BYTES }
    fun index(part: Long): Int { require(part in 0..Int.MAX_VALUE.toLong()); return part.toInt() }
    fun length(size: Long, part: Long): Int { require(part >= 0 && part < count(size)); return minOf(PART_BYTES.toLong(), size - part * PART_BYTES).toInt() }
    fun number(value: JSONObject, key: String): Long {
        val raw = value.get(key); require(raw is Number)
        val number = raw.toDouble(); val integer = raw.toLong()
        require(number.isFinite() && integer in 0..MAX_BYTES && number == integer.toDouble())
        return integer
    }
}

/** Keeps at most one status page; every next page belongs to the same admission. */
internal class FilePartReceipts(initial: JSONObject, private val size: Long, private val identityKey: String, private val identity: String, private val read: (Long) -> JSONObject) {
    private var parts = JSONArray()
    private var position = 0
    private var next: Long? = null
    private var requested = -1L
    init { FileTransfer.count(size); load(initial, -1) }
    private fun load(page: JSONObject, after: Long) {
        check(page.getString(identityKey) == identity && FileTransfer.number(page, "partBytes") == FileTransfer.PART_BYTES.toLong())
        val rows = page.getJSONArray("parts"); check(rows.length() <= FileTransfer.RECEIPTS); var previous = after
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index); val part = FileTransfer.number(row, "part")
            check(part > previous && row.get("hash") is String && row.getString("hash").matches(Regex("[a-f0-9]{64}")) && FileTransfer.number(row, "bytes") == FileTransfer.length(size, part).toLong())
            previous = part
        }
        val cursor = if (!page.has("nextPart") || page.isNull("nextPart")) null else FileTransfer.number(page, "nextPart")
        check(cursor == null || rows.length() > 0 && cursor == previous && cursor > after)
        parts = rows; position = 0; next = cursor
    }
    private fun peek(): JSONObject? {
        while (position == parts.length() && next != null) { val after = next!!; load(read(after), after) }
        return if (position < parts.length()) parts.getJSONObject(position) else null
    }
    fun receipt(part: Long): JSONObject? {
        check(part > requested && part < FileTransfer.count(size)); requested = part
        val row = peek() ?: return null; val current = FileTransfer.number(row, "part"); check(current >= part)
        return if (current == part) row.also { position++ } else null
    }
    fun finish() { check(peek() == null) }
}
