package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Generated payloads only. Operation counts catch quadratic I/O independently of host speed. */
class QueuePerformanceTest {
    private class CountingCipher : ByteCipher {
        var opens = 0
        var records = 0
        var seals = 0
        override fun seal(bytes: ByteArray): ByteArray { seals++; return bytes.map { (it.toInt() xor 91).toByte() }.toByteArray() }
        override fun open(bytes: ByteArray): ByteArray {
            opens++
            return bytes.map { (it.toInt() xor 91).toByte() }.toByteArray().also {
                if (String(it).contains("GENERATED_PRIVATE_OCR")) records++
            }
        }
        fun reset() { opens = 0; records = 0; seals = 0 }
    }
    private val after = "2026-09-14T00:00:00Z"
    private val before = "2026-09-15T00:00:00Z"
    private fun event(index: Int) = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", java.time.Instant.parse(after).plusMillis(index.toLong()).toString())
        .put("privacy", JSONObject().put("excluded", false)).put("appId", "generated.app").put("appName", "Generated app")
        .put("imageMime", "image/png").put("ocrText", "GENERATED_PRIVATE_OCR".repeat(40))
    private fun copy(source: File, target: File) {
        target.mkdirs()
        source.listFiles()!!.forEach { file -> file.copyTo(File(target, file.name)).setLastModified(file.lastModified()) }
    }
    @Test fun twoThousandRecordColdPagesAndThousandDeletesHaveLinearDecryptionsAndBoundedIndexWrites() {
        val root = Files.createTempDirectory("mote-large-library").toFile()
        val cipher = CountingCipher()
        try {
            val source = File(root, "legacy").apply { mkdirs() }
            val image = ByteArray(4096) { (it % 251).toByte() }
            val hash = MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it) }
            File(source, "$hash.blob").writeBytes(cipher.seal(image))
            val ids = (0 until 2000).map { index ->
                val record = event(index).put("_blob", hash)
                record.getString("id").also { File(source, "$it.event").writeBytes(cipher.seal(record.toString().toByteArray())) }
            }
            val legacy = DurableQueue(source, cipher)
            cipher.reset()
            legacy.prepareIndex()
            assertEquals(2000, cipher.records)
            assertTrue("Legacy upgrade persists at most sixteen shards", cipher.seals <= 16)
            val restarted = File(root, "restarted"); copy(source, restarted)
            val queue = DurableQueue(restarted, cipher)
            cipher.reset()
            val start = System.nanoTime()
            val inventory = queue.inventory()
            assertEquals(2000, inventory.records); assertEquals(2000, inventory.images); assertEquals(1, inventory.imageFiles)
            assertEquals(0, cipher.records); assertTrue(cipher.opens <= 16)
            val first = queue.capturePage(after, before)
            val second = queue.capturePage(after, before, first.getString("nextCursor"))
            assertEquals(20, first.getJSONArray("items").length()); assertEquals(20, second.getJSONArray("items").length())
            assertEquals(40, cipher.records)
            val readMs = (System.nanoTime() - start) / 1_000_000
            cipher.reset()
            val deletionStart = System.nanoTime()
            queue.withDeferredIndexWrites {
                ids.drop(1).take(1000).forEach { id -> assertTrue(queue.resolveDedupe(id, hash, ids.first(), hash, null)) }
            }
            assertEquals("Only the candidate and retained event are decrypted per decision", 2000, cipher.records)
            assertTrue("A retained shared image is validated once", cipher.opens <= 2001)
            assertTrue("At most sixteen shard writes per batch", cipher.seals <= 16)
            assertEquals(1000, queue.inventory().images)
            assertArrayEquals(image, queue.image(ids.first()))
            println("Generated 2000-record fixture: cold inventory + two pages ${readMs} ms; 1000 deletes ${(System.nanoTime() - deletionStart) / 1_000_000} ms")
        } finally { root.deleteRecursively() }
    }
    @Test fun firstCaptureCanUseConservativeHeadroomBeforeLegacyIndexUpgradeWithoutBypassingQuota() {
        val root = Files.createTempDirectory("mote-capture-headroom").toFile()
        val cipher = CountingCipher()
        try {
            val roomy = File(root, "roomy").apply { mkdirs() }
            repeat(100) { index ->
                val row = event(index).put("source", "note").apply { remove("imageMime") }
                File(roomy, "${row.getString("id")}.event").writeBytes(cipher.seal(row.toString().toByteArray()))
            }
            cipher.reset()
            DurableQueue(roomy, cipher).enqueue(event(200), byteArrayOf(1), 100_000_000)
            assertEquals("Safe headroom must not deserialize the legacy library before capture", 0, cipher.records)
            val tight = File(root, "tight").apply { mkdirs() }
            repeat(2) { index ->
                val row = event(index).put("source", "note").put("ocr", JSONObject().put("status", "pending")).apply { remove("imageMime") }
                File(tight, "${row.getString("id")}.event").writeBytes(cipher.seal(row.toString().toByteArray()))
            }
            val queue = DurableQueue(tight, cipher)
            assertThrows(QueueFull::class.java) { queue.enqueue(event(3), byteArrayOf(2), 700_000) }
            assertEquals(2, queue.depth())
            assertEquals(2 * DurableQueue.OCR_RESERVE_BYTES, queue.reservedOcrBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun deferredIndexesStillCountTowardTheStorageLimit() {
        val root = Files.createTempDirectory("mote-index-quota").toFile()
        try {
            val queue = DurableQueue(root, CountingCipher())
            val cap = 32_000L
            var added = 0
            queue.withDeferredIndexWrites {
                repeat(100) { index ->
                    val note = event(index).put("source", "note").apply { remove("imageMime"); put("ocrText", "generated") }
                    try { queue.enqueue(note, null, cap); added++ } catch (_: QueueFull) { return@withDeferredIndexWrites }
                }
            }
            assertTrue(added in 1..99)
            assertTrue("Persisting deferred metadata must not overrun the accepted quota", queue.bytes() <= cap)
        } finally { root.deleteRecursively() }
    }
    @Test fun interruptedIndexBatchRebuildsAndPreservesSharedBlobReferences() {
        val root = Files.createTempDirectory("mote-index-interrupted").toFile()
        val cipher = CountingCipher()
        try {
            val source = File(root, "source"); val queue = DurableQueue(source, cipher)
            val rows = (0..3).map(::event)
            rows.forEach { queue.enqueue(it, byteArrayOf(1, 2, 3), 10_000_000) }
            val hash = queue.dedupeRow(rows.first().getString("id"))!!.getString("blob")
            val crashed = File(root, "crashed")
            queue.withDeferredIndexWrites {
                assertTrue(queue.resolveDedupe(rows[1].getString("id"), hash, rows[0].getString("id"), hash, null))
                // Snapshot before finally flushes the invalidated derived shard, as after process death.
                copy(source, crashed)
            }
            val restored = DurableQueue(crashed, cipher)
            assertEquals(3, restored.inventory().records)
            restored.recoverOrphans()
            assertArrayEquals(byteArrayOf(1, 2, 3), restored.image(rows[0].getString("id")))
            rows.filterIndexed { index, _ -> index != 1 }.forEach { restored.acknowledge(it.getString("id")) }
            assertEquals(0, restored.inventory().records)
            assertFalse(crashed.listFiles()!!.any { it.extension == "blob" })
        } finally { root.deleteRecursively() }
    }
    @Test fun warmReferenceValidationStillRejectsMissingOrChangedImageAndPreservesCandidate() {
        val root = Files.createTempDirectory("mote-reference-validation").toFile()
        val cipher = CountingCipher()
        try {
            val queue = DurableQueue(root, cipher)
            val reference = event(0); val first = event(1); val second = event(2)
            listOf(reference, first, second).forEach { queue.enqueue(it, byteArrayOf(4, 5, 6), 10_000_000) }
            val hash = queue.dedupeRow(reference.getString("id"))!!.getString("blob")
            assertTrue(queue.resolveDedupe(first.getString("id"), hash, reference.getString("id"), hash, null))
            File(root, "$hash.blob").writeBytes(cipher.seal(byteArrayOf(9, 9, 9, 9)))
            assertThrows(IllegalStateException::class.java) { queue.resolveDedupe(second.getString("id"), hash, reference.getString("id"), hash, null) }
            assertNotNull(queue.capture(second.getString("id")))
        } finally { root.deleteRecursively() }
    }
}
