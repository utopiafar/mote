package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class CaptureAlbumsTest {
    private class CountingCipher : ByteCipher {
        var opens = 0
        var records = 0
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 90).toByte() }.toByteArray()
        override fun open(bytes: ByteArray): ByteArray {
            opens++
            return seal(bytes).also { if (String(it).contains("GENERATED_OCR")) records++ }
        }
    }
    private val after = "2026-09-14T00:00:00Z"
    private val before = "2026-09-15T00:00:00Z"
    private fun event(at: String, app: String = "fixture.app") = JSONObject()
        .put("id", UUID.randomUUID().toString()).put("source", "screen").put("capturedAt", at)
        .put("appId", app).put("appName", "Generated App").put("imageMime", "image/jpeg")
        .put("ocrText", "GENERATED_OCR".repeat(1000)).put("ocr", JSONObject().put("status", "pending"))
        .put("privacy", JSONObject().put("excluded", false))
    private fun fixture(test: (File, CountingCipher) -> Unit) {
        val root = Files.createTempDirectory("mote-albums").toFile()
        try { test(root, CountingCipher()) } finally { root.deleteRecursively() }
    }
    private fun copy(source: File, target: File) {
        target.mkdirs()
        source.listFiles()!!.forEach { file -> file.copyTo(File(target, file.name)).setLastModified(file.lastModified()) }
    }

    @Test fun coldAlbumAndGridReadOnlyEncryptedProjectionAndStayPaginated() = fixture { root, cipher ->
        val source = File(root, "source"); val queue = DurableQueue(source, cipher)
        repeat(1000) { i -> queue.enqueue(event(java.time.Instant.parse("2026-09-14T12:00:00Z").plusMillis(i.toLong()).toString()).put("ocr", JSONObject().put("status", "completed")), byteArrayOf(1, 2, 3), 100_000_000) }
        val target = File(root, "restarted"); copy(source, target)
        cipher.opens = 0; cipher.records = 0
        val restarted = DurableQueue(target, cipher)
        val started = System.nanoTime()
        val albums = restarted.albumPage(after, before)
        assertEquals(1, albums.getInt("albumCount")); assertEquals(1000, albums.getInt("totalCount"))
        val album = albums.getJSONArray("items").getJSONObject(0)
        val first = restarted.albumImages(album.getString("after"), album.getString("before"), "fixture.app")
        val second = restarted.albumImages(album.getString("after"), album.getString("before"), "fixture.app", first.getString("nextCursor"))
        assertEquals(20, first.getJSONArray("items").length()); assertEquals(20, second.getJSONArray("items").length())
        assertEquals(0, cipher.records); assertTrue("At most sixteen encrypted shards", cipher.opens <= 16)
        assertFalse(first.toString().contains("ocr")); assertFalse(first.toString().contains("blob"))
        println("Generated fixture: cold albums + two grid pages = ${(System.nanoTime() - started) / 1_000_000} ms; decryptions=${cipher.opens}; full records=${cipher.records}")
        source.listFiles()!!.filter { it.name.startsWith(".browse-") }.forEach { assertFalse(it.readText().contains("fixture.app")) }
    }
    @Test fun clockWindowsAppsDatesAndMetadataOnlyRowsStaySeparate() = fixture { root, cipher ->
        val queue = DurableQueue(root, cipher)
        for ((at, app) in listOf("2026-09-14T12:14:59Z" to "a", "2026-09-14T12:15:00Z" to "a", "2026-09-14T12:15:01Z" to "b", "2026-09-15T00:00:00Z" to "a")) {
            queue.enqueue(event(at, app), byteArrayOf(1), 100_000_000)
        }
        assertEquals(3, queue.albumPage(after, before).getInt("albumCount"))
        assertEquals(1, queue.albumImages("2026-09-14T12:15:00Z", "2026-09-14T12:30:00Z", "a").getInt("totalCount"))
    }
    @Test fun missingOrDamagedIndexRebuildsWithoutReadingImagesAndDeletionDropsThumbnail() = fixture { root, cipher ->
        val source = File(root, "source"); val queue = DurableQueue(source, cipher)
        val item = event("2026-09-14T12:00:00Z"); val id = item.getString("id")
        queue.enqueue(item, byteArrayOf(1), 100_000_000)
        queue.cacheThumbnail(id, byteArrayOf(4, 5), 100_000_000)
        val target = File(root, "restarted"); copy(source, target)
        target.listFiles()!!.filter { it.name.startsWith(".browse-") }.forEach { it.writeText("corrupt derived fixture") }
        cipher.records = 0
        val restarted = DurableQueue(target, cipher)
        assertEquals(1, restarted.albumPage(after, before).getInt("totalCount")); assertEquals(1, cipher.records)
        assertArrayEquals(byteArrayOf(4, 5), restarted.thumbnail(id))
        restarted.acknowledge(id); restarted.completeOcr(id, "", "completed", 100_000_000); restarted.acknowledgeOcr(id)
        assertEquals(0, restarted.albumPage(after, before).getInt("totalCount")); assertNull(restarted.thumbnail(id))
        assertFalse(target.listFiles()!!.any { it.extension in setOf("thumb", "blob") })
    }
    @Test fun incomingCapturesDoNotShiftGridPagination() = fixture { root, cipher ->
        val queue = DurableQueue(root, cipher)
        repeat(3) { i -> queue.enqueue(event("2026-09-14T12:00:0${i}Z"), byteArrayOf(1), 100_000_000) }
        val first = queue.albumImages(after, before, "fixture.app", limit = 2)
        queue.enqueue(event("2026-09-14T12:00:05Z"), byteArrayOf(1), 100_000_000)
        val second = queue.albumImages(after, before, "fixture.app", first.getString("nextCursor"), 2)
        assertEquals(1, second.getJSONArray("items").length())
        assertEquals("2026-09-14T12:00:00Z", second.getJSONArray("items").getJSONObject(0).getString("capturedAt"))
    }
    @Test fun interruptedCommitAndLegacyRecordsRebuildFromAuthoritativeFiles() = fixture { root, cipher ->
        val source = File(root, "source"); val queue = DurableQueue(source, cipher)
        val item = event("2026-09-14T12:00:00Z"); queue.enqueue(item, byteArrayOf(1), 100_000_000)
        val eventFile = File(source, "${item.getString("id")}.event")
        QueueBrowseIndex(source, cipher).invalidate(item.getString("id"))
        val raw = JSONObject(String(cipher.open(eventFile.readBytes()))).put("appId", "changed.app")
        eventFile.writeBytes(cipher.seal(raw.toString().toByteArray()))
        val target = File(root, "restarted"); copy(source, target)
        val restarted = DurableQueue(target, cipher)
        assertEquals("changed.app", restarted.albumPage(after, before).getJSONArray("items").getJSONObject(0).getString("appId"))
        assertNotNull(restarted.image(item.getString("id")))
    }
}
