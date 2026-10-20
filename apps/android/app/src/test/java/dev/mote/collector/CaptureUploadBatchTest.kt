package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64

/** Generated records exercise the same selection call used by UploadWorker. */
class CaptureUploadBatchTest {
    @get:Rule val folder = TemporaryFolder()
    private class CountingCipher : ByteCipher {
        val blobOpens = mutableListOf<Int>()
        override fun seal(bytes: ByteArray) = bytes
        override fun open(bytes: ByteArray): ByteArray {
            // JSON events and derived metadata begin with '{' or '['. Only our
            // generated blob fixture begins with this marker.
            if (bytes.firstOrNull() == 0x5a.toByte()) blobOpens.add(bytes[1].toInt())
            return bytes
        }
    }
    private fun id(number: Int) = "00000000-0000-4000-8000-${number.toString().padStart(12, '0')}"
    private fun event(number: Int, capturedAt: String = "2026-10-20T00:00:00Z", note: Boolean = false) = JSONObject()
        .put("id", id(number)).put("source", if (note) "note" else "screen")
        .put("capturedAt", capturedAt).put("platform", "android").put("durationMs", 0)
        .put("privacy", JSONObject().put("excluded", false))
        .apply { if (note) put("ocrText", "Generated note $number") else put("imageMime", "image/png") }
    private fun blob(number: Int, size: Int = 16 * 1024) = ByteArray(size) { ((it + number) % 251).toByte() }
        .apply { this[0] = 0x5a; this[1] = number.toByte() }
    private fun enqueue(queue: DurableQueue, dir: File, number: Int, modified: Long, bytes: ByteArray? = blob(number), capturedAt: String = "2026-10-20T00:00:00Z") {
        queue.enqueue(event(number, capturedAt, note = bytes == null), bytes, 32L * 1024 * 1024)
        assertTrue(File(dir, "${id(number)}.event").setLastModified(modified))
    }
    private fun List<JSONObject>.ids() = map { it.getString("id") }

    @Test fun nonPackedOnlyOpensTheFirstBlobAndRetryKeepsExactPayload() {
        val dir = folder.newFolder(); val cipher = CountingCipher(); val queue = DurableQueue(dir, cipher)
        for (number in 1..8) enqueue(queue, dir, number, number * 1000L)
        cipher.blobOpens.clear()
        val first = queue.peekUploadBatch(100, false, 10, null).single()
        assertEquals(id(1), first.getString("id"))
        assertArrayEquals(blob(1), Base64.getDecoder().decode(first.getString("imageBase64")))
        assertEquals(listOf(1), cipher.blobOpens)
        assertEquals(first.toString(), queue.peekUploadBatch(100, false, 10, null).single().toString())
        assertEquals(listOf(1, 1), cipher.blobOpens)
        assertEquals(8, queue.depth())
        queue.acknowledge(id(1))
        val restarted = DurableQueue(dir, cipher)
        assertEquals(7, restarted.depth())
        assertEquals(id(2), restarted.peekUploadBatch(99, false, 10, null).single().getString("id"))
        assertArrayEquals(blob(8), restarted.image(id(8)))
    }

    @Test fun packedUsesTheOriginalCountOrderingAndPayloads() {
        val dir = folder.newFolder(); val cipher = CountingCipher(); val queue = DurableQueue(dir, cipher)
        // Deliberately reverse insertion and tie modification times.
        for (number in 4 downTo 1) enqueue(queue, dir, number, 1000)
        val original = queue.peekBatch(3, 4 * 1024 * 1024, 10)
        cipher.blobOpens.clear()
        val selected = queue.peekUploadBatch(3, true, 10, null)
        assertEquals(listOf(id(1), id(2), id(3)), selected.ids())
        assertEquals(original.map { it.toString() }, selected.map { it.toString() })
        assertEquals(listOf(1, 2, 3), cipher.blobOpens)
        assertEquals(id(1), queue.peekUploadBatch(3, false, 10, null).single().getString("id"))
    }

    @Test fun metadataWindowsAndMixedImageSelectionStayInQueueOrder() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, CountingCipher())
        enqueue(queue, dir, 1, 1000, null, "2026-10-20T00:00:00Z")
        enqueue(queue, dir, 2, 2000)
        enqueue(queue, dir, 3, 3000, null, "2026-10-20T00:09:59Z")
        enqueue(queue, dir, 4, 4000, null, "2026-10-20T00:10:00Z")
        assertEquals(listOf(id(1), id(3)), queue.peekUploadBatch(4, true, 10, null).ids())
        assertEquals(listOf(id(1)), queue.peekUploadBatch(4, false, 10, null).ids())
        assertEquals(listOf(id(1)), queue.peekUploadBatch(4, true, 1, null).ids())
        queue.acknowledge(id(1))
        assertEquals(id(2), queue.peekUploadBatch(3, false, 10, null).single().getString("id"))
    }

    @Test fun oversizedFirstRecordIsReturnedAloneForExistingTransportRejection() {
        val dir = folder.newFolder(); val cipher = CountingCipher(); val queue = DurableQueue(dir, cipher)
        val oversized = blob(1, 4 * 1024 * 1024)
        enqueue(queue, dir, 1, 1000, oversized); enqueue(queue, dir, 2, 2000)
        for (packed in listOf(false, true)) {
            cipher.blobOpens.clear()
            val selected = queue.peekUploadBatch(100, packed, 10, null).single()
            assertEquals(id(1), selected.getString("id"))
            assertTrue(selected.toString().toByteArray().size > 4 * 1024 * 1024)
            assertArrayEquals(oversized, Base64.getDecoder().decode(selected.getString("imageBase64")))
            assertEquals(listOf(1), cipher.blobOpens)
            assertEquals(2, queue.depth())
        }
    }

    @Test fun livePreferenceAndHistoricalTurnKeepTheirOriginalFirstRecord() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, CountingCipher())
        enqueue(queue, dir, 1, 1000); enqueue(queue, dir, 2, 3000); enqueue(queue, dir, 3, 4000)
        for (packed in listOf(false, true)) {
            val live = queue.peekUploadBatch(3, packed, 10, 2000)
            assertEquals(id(2), live.first().getString("id"))
            assertEquals(queue.peekBatch(if (packed) 3 else 1, 4 * 1024 * 1024, 10, 2000).ids(), live.ids())
            assertEquals(id(1), queue.peekUploadBatch(3, packed, 10, null).first().getString("id"))
        }
        assertEquals(3, queue.depth())
    }
}
