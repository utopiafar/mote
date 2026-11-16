package dev.mote.collector

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileTransferTest {
    @get:Rule val folder = TemporaryFolder()
    private val id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val hash = "a".repeat(64)
    private fun row(part: Int, bytes: Int = FileTransfer.PART_BYTES) = JSONObject().put("part", part).put("bytes", bytes).put("hash", hash)
    private fun page(parts: JSONArray, next: Int? = null) = JSONObject().put("uploadId", id).put("partBytes", FileTransfer.PART_BYTES).put("parts", parts).put("nextPart", next ?: JSONObject.NULL)

    @Test fun byteAndPartArithmeticUsesTheExactJsonBoundaryRatherThanAnIntTotal() {
        assertEquals(2147483648L, FileTransfer.count(FileTransfer.MAX_BYTES))
        assertEquals(Int.MAX_VALUE, FileTransfer.index(2147483647L))
        assertEquals(FileTransfer.PART_BYTES - 1, FileTransfer.length(FileTransfer.MAX_BYTES, 2147483647L))
        for (bad in listOf(-1L, FileTransfer.MAX_BYTES + 1, Long.MAX_VALUE)) assertThrows(Exception::class.java) { FileTransfer.count(bad) }
        for (bad in listOf("1", 1.5, -1L, FileTransfer.MAX_BYTES + 1, JSONObject.NULL)) assertThrows(Exception::class.java) { FileTransfer.number(JSONObject().put("bytes", bad), "bytes") }
    }
    @Test fun pagedReceiptsKeepOrderAndFetchOnlyTheNextBoundedPage() {
        val first = JSONArray(); repeat(256) { first.put(row(it)) }; var calls = 0
        val receipts = FilePartReceipts(page(first, 255), 300L * FileTransfer.PART_BYTES, "uploadId", id) { after ->
            assertEquals(255L, after); calls++; val remaining = JSONArray(); for (part in 256 until 300) remaining.put(row(part)); page(remaining)
        }
        repeat(300) { assertEquals(it, receipts.receipt(it.toLong())!!.getInt("part")) }; receipts.finish(); assertEquals(1, calls)
    }
    @Test fun sparseReceiptsDoNotPretendThatMissingPartsWereAcknowledged() {
        val receipts = FilePartReceipts(page(JSONArray().put(row(1)).put(row(3))), 4L * FileTransfer.PART_BYTES, "uploadId", id) { error("No next page") }
        assertNull(receipts.receipt(0)); assertNotNull(receipts.receipt(1)); assertNull(receipts.receipt(2)); assertNotNull(receipts.receipt(3)); receipts.finish()
    }
    @Test fun malformedDuplicateOrCrossAdmissionPagesNeverBecomeReceipts() {
        val invalid = listOf(page(JSONArray().put(row(0)).put(row(0))), page(JSONArray().put(row(1)).put(row(0))), page(JSONArray(), 0), page(JSONArray().put(row(0)), 1), page(JSONArray().put(row(0, 1))), page(JSONArray().put(row(0).put("hash", "forged"))), page(JSONArray()).put("uploadId", UUID.randomUUID().toString()))
        for (value in invalid) assertThrows(Exception::class.java) { FilePartReceipts(value, 2L * FileTransfer.PART_BYTES, "uploadId", id) { error("No next page") } }
        val first = JSONArray(); repeat(256) { first.put(row(it)) }
        val repeating = FilePartReceipts(page(first, 255), 300L * FileTransfer.PART_BYTES, "uploadId", id) { page(JSONArray().put(row(255))) }
        repeat(256) { repeating.receipt(it.toLong()) }; assertThrows(Exception::class.java) { repeating.finish() }
    }
    @Test fun anArchivedImportKeepsItsReceiptAndInputWhenPreviewCapacityFailsAndRetriesCleanup() {
        val directory = folder.newFolder(); val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        val upload = UUID.randomUUID().toString(); val fileId = UUID.randomUUID().toString(); val bytes = "Generated retained original".toByteArray()
        val state = CentralStateFile(directory, "import", plain); state.write(JSONObject().put("manifest", JSONObject().put("id", upload).put("name", "generated.txt").put("sizeBytes", bytes.size)).put("requestId", UUID.randomUUID().toString()).put("instruction", "Generated instruction"))
        val original = File(directory, "part-0.enc"); original.writeBytes(bytes); var committed = false; var commits = 0; var writes = 0
        val client = object : CentralUploadClient {
            override fun post(path: String, body: JSONObject): JSONObject = when (path) {
                "/api/import-uploads" -> JSONObject().put("id", upload).put("partBytes", FileTransfer.PART_BYTES).put("parts", JSONArray()).also { if (committed) it.put("fileId", fileId) }
                "/api/import-uploads/$upload/commit" -> JSONObject().put("id", fileId).also { committed = true; commits++ }
                "/api/imports" -> throw CentralFailure(413, "generated_processing_capacity")
                else -> error(path)
            }
            override fun bytes(method: String, path: String, body: ByteArray?, mime: String): JSONObject {
                check(!committed); writes++; return JSONObject().put("part", 0).put("bytes", body!!.size).put("hash", java.security.MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) })
            }
        }
        val imports = CentralImports(directory, plain)
        repeat(2) { assertThrows(CentralFailure::class.java) { imports.send(client) { _, _ -> } }; assertEquals(fileId, imports.pending().getString("archivedFileId")); assertTrue(original.isFile) }
        assertEquals(1, writes); assertEquals(2, commits)
    }
}
