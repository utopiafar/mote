package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class ImageDedupeDiagnosticsStoreTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        private val key = SecretKeySpec(ByteArray(32) { (it * 7 + 3).toByte() }, "AES")
        override fun seal(bytes: ByteArray): ByteArray {
            val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
            return nonce + Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce)); doFinal(bytes) }
        }
        override fun open(bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            require(bytes.size >= 28)
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            doFinal(bytes.copyOfRange(12, bytes.size))
        }
    }
    private val reference = "GENERATED-REFERENCE-IMAGE-BYTES".repeat(5).toByteArray()
    private val duplicate = "GENERATED-DUPLICATE-IMAGE-BYTES".repeat(5).toByteArray()
    private fun metadata() = JSONObject().put("mode", "balanced").put("reason", "generated-similarity").put("score", 0.975)

    @Test fun `both generated images and metadata survive restart without plaintext on disk`() {
        val directory = folder.newFolder(); val input = metadata()
        val id = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1000 }).record(input, reference, duplicate)!!
        assertFalse(input.has("id")); assertFalse(input.has("retainedAt"))
        val entries = directory.listFiles()!!; assertEquals(1, entries.size); assertEquals("$id.enc", entries.single().name)
        val stored = entries.single().readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(stored.contains("GENERATED-REFERENCE")); assertFalse(stored.contains("GENERATED-DUPLICATE")); assertFalse(stored.contains("generated-similarity"))
        val reopened = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1001 })
        val detail = reopened.read(id)!!
        assertArrayEquals(reference, detail.referenceImage); assertArrayEquals(duplicate, detail.duplicateImage)
        assertEquals(id, detail.metadata.getString("id")); assertEquals(1000L, detail.metadata.getLong("retainedAt")); assertEquals(0.975, detail.metadata.getDouble("score"), 0.0)
        val listed = reopened.list().single(); assertFalse(listed.has("referenceImage")); assertFalse(listed.has("duplicateImage"))
        listed.put("reason", "changed outside store")
        assertEquals("generated-similarity", reopened.list().single().getString("reason"))
    }

    @Test fun `count eviction keeps the newest pairs and read also enforces the exact age boundary`() {
        val directory = folder.newFolder(); var time = 1000L
        val store = ImageDedupeDiagnosticsStore(directory, cipher, now = { time }, maxRecords = 2, maxAgeMs = 100)
        val first = store.record(metadata(), reference, duplicate)!!; time++
        val second = store.record(metadata(), reference, duplicate)!!; time++
        val third = store.record(metadata(), reference, duplicate)!!
        assertEquals(listOf(third, second), store.list().map { it.getString("id") }); assertNull(store.read(first)); assertEquals(2, directory.listFiles()!!.size)
        time = 1101; assertNull(store.read(second)); assertNotNull(store.read(third))
        time = 1102; assertNull(store.read(third)); assertTrue(directory.listFiles()!!.isEmpty())
    }

    @Test fun `actual encrypted byte quota includes envelope overhead and evicts oldest first`() {
        val directory = folder.newFolder(); var time = 1000L
        var store = ImageDedupeDiagnosticsStore(directory, cipher, now = { time })
        val first = store.record(metadata(), reference, duplicate)!!
        val size = File(directory, "$first.enc").length()
        store = ImageDedupeDiagnosticsStore(directory, cipher, now = { time }, maxBytes = size * 2)
        time++; val second = store.record(metadata(), reference, duplicate)!!
        assertEquals(size * 2, directory.listFiles()!!.sumOf { it.length() })
        time++; val third = store.record(metadata(), reference, duplicate)!!
        assertNull(store.read(first)); assertEquals(listOf(third, second), store.list().map { it.getString("id") })
        assertEquals(size * 2, directory.listFiles()!!.sumOf { it.length() })
        assertNull(ImageDedupeDiagnosticsStore(folder.newFolder(), cipher, now = { time }, maxBytes = size - 1).record(metadata(), reference, duplicate))
        val reduced = ImageDedupeDiagnosticsStore(directory, cipher, now = { time }, maxBytes = size)
        reduced.prune(); assertEquals(listOf(third), reduced.list().map { it.getString("id") }); assertEquals(size, directory.listFiles()!!.sumOf { it.length() })
    }

    @Test fun `disabled storage clears existing pairs and creates no files for new captures`() {
        val parent = folder.newFolder(); val directory = File(parent, "diagnostic-only"); var allowed = false
        val store = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1000 }, enabled = { allowed })
        assertNull(store.record(metadata(), reference, duplicate)); assertFalse(directory.exists())
        allowed = true; val id = store.record(metadata(), reference, duplicate)!!
        allowed = false; assertNull(store.read(id)); assertTrue(directory.listFiles()!!.isEmpty())
        allowed = true; store.record(metadata(), reference, duplicate)
        allowed = false; assertTrue(store.list().isEmpty()); assertTrue(directory.listFiles()!!.isEmpty())
        allowed = true; store.record(metadata(), reference, duplicate)
        allowed = false; store.prune(); assertTrue(directory.listFiles()!!.isEmpty())
    }

    @Test fun `corrupt ciphertext invalid names abandoned files and forged envelopes are evicted`() {
        val directory = folder.newFolder(); val store = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1000 })
        val valid = store.record(metadata(), reference, duplicate)!!
        val corrupt = store.record(metadata(), reference, duplicate)!!
        val corruptedFile = File(directory, "$corrupt.enc")
        val bytes = corruptedFile.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); corruptedFile.writeBytes(bytes)
        File(directory, "not-an-id.enc").writeBytes(reference)
        File(directory, "${UUID.randomUUID()}.tmp").writeBytes(cipher.seal(reference))
        File(directory, "${UUID.randomUUID()}.enc").writeBytes(cipher.seal(ByteArray(20)))
        assertEquals(listOf(valid), store.list().map { it.getString("id") }); assertEquals(listOf("$valid.enc"), directory.listFiles()!!.map { it.name })
        // A valid authenticated envelope copied under another identity is not admitted.
        File(directory, "${UUID.randomUUID()}.enc").writeBytes(File(directory, "$valid.enc").readBytes())
        store.prune(); assertEquals(1, directory.listFiles()!!.size)
    }

    @Test fun `deletion rejects traversal and neither clearing nor pruning follows symlinks`() {
        val directory = folder.newFolder(); val outside = folder.newFile("outside-generated.enc").apply { writeBytes(reference) }
        val store = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1000 })
        val id = store.record(metadata(), reference, duplicate)!!
        assertFalse(store.delete("../outside-generated")); assertNull(store.read("../outside-generated")); assertFalse(store.delete(outside.absolutePath))
        Files.createSymbolicLink(File(directory, "${UUID.randomUUID()}.enc").toPath(), outside.toPath())
        store.prune(); assertArrayEquals(reference, outside.readBytes()); assertEquals(1, store.list().size)
        assertTrue(store.delete(id)); assertFalse(store.delete(id)); assertNull(store.read(id))
        Files.createSymbolicLink(File(directory, "unexpected.tmp").toPath(), outside.toPath())
        val nested = File(directory, "unexpected-directory").apply { mkdirs() }
        File(nested, "interrupted-cache.enc").writeBytes(cipher.seal(reference))
        Files.createSymbolicLink(File(nested, "external").toPath(), outside.toPath())
        store.clear(); assertArrayEquals(reference, outside.readBytes()); assertTrue(directory.listFiles()!!.isEmpty())
        val alias = File(folder.newFolder(), "alias"); Files.createSymbolicLink(alias.toPath(), directory.toPath())
        assertThrows(IllegalStateException::class.java) { ImageDedupeDiagnosticsStore(alias, cipher).clear() }
    }

    @Test fun `encryption failure creates no partial pair and preserves older entries`() {
        val directory = folder.newFolder(); val id = ImageDedupeDiagnosticsStore(directory, cipher, now = { 1000 }).record(metadata(), reference, duplicate)!!
        val broken = object : ByteCipher {
            override fun seal(bytes: ByteArray): ByteArray = error("Generated encryption failure")
            override fun open(bytes: ByteArray): ByteArray = cipher.open(bytes)
        }
        val store = ImageDedupeDiagnosticsStore(directory, broken, now = { 1001 }, maxRecords = 1)
        assertThrows(IllegalStateException::class.java) { store.record(metadata(), reference, duplicate) }
        assertEquals(listOf("$id.enc"), directory.listFiles()!!.map { it.name }); assertNotNull(store.read(id))
    }

    @Test fun `disabling during encryption prevents a retained pair`() {
        val directory = folder.newFolder(); var allowed = true
        val switched = object : ByteCipher {
            override fun seal(bytes: ByteArray): ByteArray = cipher.seal(bytes).also { allowed = false }
            override fun open(bytes: ByteArray): ByteArray = cipher.open(bytes)
        }
        val store = ImageDedupeDiagnosticsStore(directory, switched, enabled = { allowed })
        assertNull(store.record(metadata(), reference, duplicate)); assertTrue(directory.listFiles()!!.isEmpty())
    }
}
