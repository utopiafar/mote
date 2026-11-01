package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64
import java.util.UUID

class DurableQueueTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun event(excluded: Boolean = false) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("capturedAt", "2026-01-01T00:00:00Z").put("platform", "android").put("durationMs", 30000)
        .put("privacy", JSONObject().put("excluded", excluded))
    @Test fun `new captures can pass a 400 day history without losing the historical queue`() {
        val queue = DurableQueue(folder.newFolder(), cipher)
        val historicalIds = (0 until 400).map { i ->
            queue.enqueue(event().put("source", "note").put("ocrText", "Generated history $i").put("capturedAt", java.time.Instant.parse("2024-01-01T00:00:00Z").plusSeconds(i * 86400L).toString()), null, 16L * 1024 * 1024)
        }.toSet()
        val since = System.currentTimeMillis() + 1
        while (System.currentTimeMillis() < since) Thread.yield()
        val fresh = event().put("source", "note").put("ocrText", "Generated fresh note")
        queue.enqueue(fresh, null, 16L * 1024 * 1024)
        val first = queue.peekBatch(maxCount = 25, preferSince = since)
        assertEquals(fresh.getString("id"), first.first().getString("id"))
        queue.acknowledge(fresh.getString("id")); assertEquals(400, queue.depth())
        val historical = queue.peekBatch(maxCount = 25)
        assertTrue(historical.isNotEmpty())
        assertTrue(historical.all { it.getString("ocrText").startsWith("Generated history ") })
        val retainedIds = mutableSetOf<String>()
        var after: String? = null
        var page: List<String>
        do {
            page = queue.syncIds(after = after)
            retainedIds.addAll(page)
            after = page.lastOrNull()
        } while (page.size == 100)
        assertEquals(historicalIds, retainedIds)
    }
    @Test fun `batch selection is bounded and partial acknowledgement survives restart`() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, cipher)
        repeat(4) { queue.enqueue(event(), ByteArray(500) { it.toByte() }, 100000) }
        assertEquals(2, queue.peekBatch(2).size)
        assertEquals(1, queue.peekBatch(25, 10).size)
        val selected = queue.peekBatch()
        assertEquals(4, queue.depth())
        queue.acknowledge(selected.first().getString("id"))
        val remaining = DurableQueue(dir, cipher).peekBatch()
        assertEquals(3, remaining.size)
        assertFalse(remaining.any { it.getString("id") == selected.first().getString("id") })
        assertTrue(remaining.all { it.getString("imageBase64").isNotBlank() })
    }
    @Test fun `retries and process restart preserve exact id metadata and bytes`() {
        val dir = folder.newFolder()
        val queue = DurableQueue(dir, cipher)
        val event = event()
        val fixture = "generated-image-only".toByteArray()
        queue.enqueue(event, fixture, 100000)
        val first = queue.peek()!!.toString()
        val restarted = DurableQueue(dir, cipher)
        restarted.recoverOrphans()
        assertEquals(first, restarted.peek()!!.toString())
        assertEquals(1, restarted.depth())
        assertArrayEquals(fixture, Base64.getDecoder().decode(restarted.peek()!!.getString("imageBase64")))
        restarted.acknowledge(event.getString("id"))
        assertEquals(0, restarted.depth())
        assertEquals(0, restarted.bytes())
    }
    @Test fun `identical images share one blob until last acknowledgement`() {
        val dir = folder.newFolder()
        val queue = DurableQueue(dir, cipher)
        val first = event(); val second = event()
        queue.enqueue(first, byteArrayOf(1, 2, 3), 100000)
        queue.enqueue(second, byteArrayOf(1, 2, 3), 100000)
        assertEquals(1, dir.listFiles()!!.count { it.extension == "blob" })
        queue.acknowledge(first.getString("id"))
        assertEquals(1, dir.listFiles()!!.count { it.extension == "blob" })
        assertEquals(second.getString("id"), queue.peek()!!.getString("id"))
        queue.acknowledge(second.getString("id"))
        assertEquals(0, dir.listFiles()!!.count { it.extension == "blob" })
    }
    @Test fun `full queue preserves older events without silent deletion`() {
        val queue = DurableQueue(folder.newFolder(), cipher)
        queue.enqueue(event(), ByteArray(100), 100000)
        val before = queue.peek()!!.toString()
        assertThrows(QueueFull::class.java) { queue.enqueue(event(), ByteArray(1000), queue.bytes() + 20) }
        assertEquals(before, queue.peek()!!.toString())
        assertEquals(1, queue.depth())
    }
    @Test fun `excluded frame cannot enter storage`() {
        val queue = DurableQueue(folder.newFolder(), cipher)
        assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event(true), byteArrayOf(1), 10000) }
        assertEquals(0, queue.bytes())
    }
    @Test fun `crash leftovers removed without losing valid observations`() {
        val dir = folder.newFolder()
        val queue = DurableQueue(dir, cipher)
        queue.enqueue(event(), byteArrayOf(1, 2), 100000)
        File(dir, "interrupted.tmp").writeText("fixture")
        File(dir, "orphan.blob").writeText("fixture")
        queue.recoverOrphans()
        assertEquals(1, queue.depth())
        assertFalse(File(dir, "interrupted.tmp").exists())
        assertFalse(File(dir, "orphan.blob").exists())
        assertNotNull(queue.peek())
    }
    @Test fun `corrupt event is surfaced instead of silently discarded`() {
        val dir = folder.newFolder()
        LocalDataFormat.requireCurrent(dir)
        File(dir, "broken.event").writeText("corruption-fixture")
        val queue = DurableQueue(dir, cipher)
        assertThrows(Exception::class.java) { queue.recoverOrphans() }
        assertEquals(1, queue.depth())
    }
    @Test fun `manual notes persist without fabricated image across restart and acknowledgement`() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, cipher)
        val note = event().put("source", "note").put("ocrText", "合成随手记：今天心情不错").put("mood", "平静")
        queue.enqueue(note, null, 100000)
        assertEquals(0, dir.listFiles()!!.count { it.extension == "blob" })
        val restarted = DurableQueue(dir, cipher); restarted.recoverOrphans()
        val actual = restarted.peek()!!
        assertFalse(actual.has("imageBase64")); assertFalse(actual.has("imageMime")); assertFalse(actual.has("_blob"))
        assertEquals(note.toString(), actual.toString())
        restarted.acknowledge(note.getString("id")); assertEquals(0, restarted.depth()); assertEquals(0L, restarted.bytes())
    }

    @Test fun `library version callback does not hold the queue lock`() {
        val queue = DurableQueue(folder.newFolder(), cipher).apply { archiveOrigin = "https://generated.example" }
        val note = event().put("source", "note").put("ocrText", "Generated note")
        queue.enqueue(note, null, 100000)
        val lockProbe = Thread { DurableQueue.exclusive { } }.apply { isDaemon = true }
        try {
            val page = queue.capturePage("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", source = "note",
                libraryBindings = true, libraryVersion = { original, hash ->
                    lockProbe.start()
                    lockProbe.join(2000)
                    assertFalse("Version calculation must let attachment ACKs acquire the queue lock", lockProbe.isAlive)
                    assertEquals(note.getString("id"), original.getString("id"))
                    assertEquals("Generated note", original.getString("ocrText"))
                    assertTrue(hash.isNullOrBlank())
                    CaptureLibraryVersion.of(original, hash)
                })
            val id = note.getString("id")
            assertEquals(CaptureLibraryVersion.of(note), page.getJSONObject("versions").getString(id))
            assertEquals("https://generated.example", page.getJSONObject("bindings").getString(id))
            assertEquals(1, page.getInt("totalCount"))
            assertTrue(page.isNull("nextCursor"))
            assertEquals("Generated note", page.getJSONArray("items").getJSONObject(0).getString("textPreview"))
        } finally {
            // A failing pre-fix callback releases the lock before this cleanup joins the probe.
            lockProbe.join(2000)
            assertFalse("Queue lock probe must finish", lockProbe.isAlive)
        }
    }

    @Test fun `library page versions preserve original text blob and binding across display projection`() {
        val queue = DurableQueue(folder.newFolder(), cipher).apply { archiveOrigin = "https://generated.example" }
        val older = event().put("source", "note").put("ocrText", "Generated older note")
        val note = event().put("source", "note").put("ocrText", "Generated original body ".repeat(10))
            .put("capturedAt", "2026-01-01T01:00:00Z")
            .put("metadata", JSONObject().put("noteOrigin", JSONObject().put("kind", "share").put("text", "Generated quoted source")))
        val image = byteArrayOf(1, 2, 3)
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it) }
        queue.enqueue(older, null, 100000); queue.enqueue(note, image, 100000)
        queue.acknowledge(note.getString("id"), retentionDays = 7)
        queue.cacheCentralDerived(JSONObject().put("id", note.getString("id")).put("textPreview", "Generated central preview")
            .put("ocr", JSONObject().put("status", "completed")), 100000)
        queue.archiveOrigin = "https://other.example"

        val page = queue.capturePage("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", limit = 1, source = "note", libraryBindings = true)
        val id = note.getString("id"); val item = page.getJSONArray("items").getJSONObject(0)
        assertEquals(CaptureLibraryVersion.of(note, hash), page.getJSONObject("versions").getString(id))
        assertEquals("https://generated.example", page.getJSONObject("bindings").getString(id))
        assertEquals(id, item.getString("id")); assertEquals("Generated central preview", item.getString("textPreview"))
        assertTrue(item.getBoolean("hasImage")); assertTrue(item.getBoolean("uploaded"))
        assertFalse(item.has("ocrText")); assertFalse(item.has("_blob")); assertFalse(item.has("_archiveOrigin"))
        assertEquals(2, page.getInt("totalCount"))

        val next = queue.capturePage("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", cursor = page.getString("nextCursor"),
            limit = 1, source = "note", libraryBindings = true)
        val olderId = older.getString("id")
        assertEquals(olderId, next.getJSONArray("items").getJSONObject(0).getString("id"))
        assertEquals(CaptureLibraryVersion.of(older), next.getJSONObject("versions").getString(olderId))
        assertEquals("https://generated.example", next.getJSONObject("bindings").getString(olderId))
        assertEquals(2, next.getInt("totalCount")); assertTrue(next.isNull("nextCursor"))
    }

}
