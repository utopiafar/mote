package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class LocalContentCipherTest {
    /** Same wire framing as SecretBox, with a generated-test key rather than Android Keystore. */
    private class LegacyCipher : ByteCipher {
        private val key = SecretKeySpec(ByteArray(16) { it.toByte() }, "AES")
        override fun seal(bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key); byteArrayOf(iv.size.toByte()) + iv + doFinal(bytes)
        }
        override fun open(bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13))); doFinal(bytes.copyOfRange(13, bytes.size))
        }
    }
    private fun event() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("capturedAt", "2026-09-14T00:00:00Z").put("privacy", JSONObject().put("excluded", false))
        .put("ocrText", "generated fixture text")
    @Test fun normalJsonAndImageBytesArePlaintextWhileLegacyFramesAndAmbiguousBinaryRoundTrip() {
        val legacy = LegacyCipher(); val codec = LocalContentCipher(legacy)
        for (plain in listOf(event().toString().toByteArray(), byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47), byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()))) {
            assertArrayEquals(plain, codec.seal(plain)); assertArrayEquals(plain, codec.open(codec.seal(plain)))
            val encrypted = legacy.seal(plain)
            assertTrue(codec.isLegacy(encrypted)); assertArrayEquals(plain, codec.open(encrypted))
        }
        for (plain in listOf(ByteArray(50) { if (it == 0) 12 else 7 }, "MOTE-LOCAL-PLAIN-V1\u0000generated".toByteArray())) {
            val stored = codec.seal(plain)
            assertFalse(codec.isLegacy(stored)); assertArrayEquals(plain, codec.open(stored))
        }
        val broken = legacy.seal(event().toString().toByteArray()).also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { codec.open(broken) }
    }
    @Test fun optionalEncryptionTracksCurrentPolicyAndExplicitPlaintextOverride() {
        val legacy = LegacyCipher(); var enabled = false
        val codec = LocalContentCipher(legacy) { enabled }
        val bytes = event().toString().toByteArray()
        assertArrayEquals(bytes, codec.seal(bytes))
        enabled = true
        val encrypted = codec.seal(bytes)
        assertTrue(codec.isLegacy(encrypted)); assertArrayEquals(bytes, codec.open(encrypted))
        assertArrayEquals(bytes, codec.open(bytes))
        codec.withPlaintextWrites { assertArrayEquals(bytes, codec.seal(bytes)) }
        assertTrue(codec.isLegacy(codec.seal(bytes)))
        enabled = false
        assertArrayEquals(bytes, codec.seal(bytes))
    }
    @Test fun queueMigrationIsResumableAtomicAndKeepsPayloadsAndPendingTime() {
        val root = Files.createTempDirectory("mote-plain-migration").toFile()
        val legacy = LegacyCipher(); val codec = LocalContentCipher(legacy, encryptWrites = true)
        try {
            val old = File(root, "old"); val oldQueue = DurableQueue(old, legacy)
            val first = event(); val second = event()
            val image = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1, 2, 3)
            listOf(first, second).forEach { oldQueue.enqueue(it, image, 10_000_000) }
            val target = File(root, "restarted").apply { mkdirs() }
            old.listFiles()!!.forEach { it.copyTo(File(target, it.name)).setLastModified(it.lastModified()) }
            val queue = DurableQueue(target, codec)
            val before = queue.pendingSync()
            var checked = 0
            queue.migrateLegacyContent { checked++ >= 1 }
            assertNotNull(queue.capture(first.getString("id")))
            queue.migrateLegacyContent()
            assertEquals(0, queue.migrateLegacyContent())
            assertEquals(before, queue.pendingSync())
            assertEquals(2, queue.inventory().images); assertEquals(1, queue.inventory().imageFiles)
            listOf(first, second).forEach { row ->
                val file = File(target, "${row.getString("id")}.event")
                assertEquals(row.getString("id"), JSONObject(file.readText()).getString("id"))
                assertArrayEquals(image, queue.image(row.getString("id")))
            }
            assertArrayEquals(image, target.listFiles()!!.single { it.extension == "blob" }.readBytes())
            queue.verifyIntegrity()
        } finally { root.deleteRecursively() }
    }
    @Test fun corruptLegacyFileIsNeverOverwrittenDuringMigration() {
        val root = Files.createTempDirectory("mote-plain-failed").toFile()
        val legacy = LegacyCipher(); val codec = LocalContentCipher(legacy)
        try {
            val row = event()
            val broken = legacy.seal(row.toString().toByteArray()).also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
            val file = File(root, "${row.getString("id")}.event").apply { writeBytes(broken) }
            assertThrows(Exception::class.java) { DurableQueue(root, codec).migrateLegacyContent() }
            assertArrayEquals(broken, file.readBytes())
        } finally { root.deleteRecursively() }
    }
}
