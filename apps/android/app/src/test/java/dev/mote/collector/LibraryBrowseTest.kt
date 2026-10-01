package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

/** Generated records and synthetic image bytes exercise the shared library without capture or model calls. */
class LibraryBrowseTest {
    @get:Rule val directory = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes
        override fun open(bytes: ByteArray) = bytes
    }
    private fun fixture(source: String, hour: Int) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("source", source).put("capturedAt", "2026-10-01T${hour.toString().padStart(2, '0')}:00:00Z")
        .put("ocrText", "Generated $source fixture").put("privacy", JSONObject().put("excluded", false))

    @Test fun allTypesShareOnePagedLibraryWithoutLosingSourceFilters() {
        val queue = DurableQueue(directory.newFolder(), cipher)
        val records = listOf(fixture("screen", 8), fixture("note", 9), fixture("screen", 10), fixture("note", 11))
        records.forEach { record ->
            val image = if (record.getString("source") == "screen") byteArrayOf(1, 2, 3) else null
            if (image != null) record.put("imageMime", "image/png")
            queue.enqueue(record, image, 1000000)
        }
        val after = "2026-10-01T00:00:00Z"; val before = "2026-10-02T00:00:00Z"
        val first = queue.capturePage(after, before, limit = 2, source = "")
        assertEquals(4, first.getInt("totalCount"))
        assertEquals(records[3].getString("id"), first.getJSONArray("items").getJSONObject(0).getString("id"))
        val second = queue.capturePage(after, before, first.getString("nextCursor"), limit = 2, source = "")
        val ids = listOf(first, second).flatMap { page -> (0 until page.getJSONArray("items").length()).map { page.getJSONArray("items").getJSONObject(it).getString("id") } }
        assertEquals(records.map { it.getString("id") }.toSet(), ids.toSet()); assertEquals(4, ids.size)
        assertTrue(second.isNull("nextCursor"))
        val notes = queue.capturePage(after, before, source = "note")
        assertEquals(2, notes.getInt("totalCount"))
        assertEquals(2, queue.capturePage(after, before).getInt("totalCount")) // Existing screen-only callers keep their default.
        assertEquals(0, queue.capturePage(after, before, source = "media").getJSONArray("items").length())
        assertEquals(4, queue.depth()) // Browsing has no retention or acknowledgement side effects.
    }
}
