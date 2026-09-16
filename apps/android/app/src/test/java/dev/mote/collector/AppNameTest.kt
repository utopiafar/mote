package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class AppNameTest {
    @get:Rule val folder = TemporaryFolder()
    private val plain = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
    private fun event() = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
        .put("appId", "generated.app").put("appName", "生成的应用").put("capturedAt", "2026-09-16T00:00:00Z")
        .put("imageMime", "image/png").put("privacy", JSONObject().put("excluded", false))

    @Test fun appNamesAreRequiredAndPreservedAcrossQueueRestartAndUpload() {
        val dir = folder.newFolder(); val queue = DurableQueue(dir, plain)
        for (name in listOf(null, "", " \t\n", "A".repeat(201))) {
            assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event().put("appName", name), byteArrayOf(1), 1_000_000) }
        }
        assertEquals(0, queue.depth())
        val record = event(); queue.enqueue(record, byteArrayOf(1), 1_000_000)
        val restarted = DurableQueue(dir, plain)
        val uploaded = restarted.peek()!!
        assertEquals("generated.app", uploaded.getString("appId")); assertEquals("生成的应用", uploaded.getString("appName"))
        assertFalse(uploaded.has("metadata"))
        assertEquals(uploaded.toString(), restarted.peek()!!.toString())
    }
    @Test fun embeddedMediaAppNamesAreRequiredEvenInScreenRecords() {
        val queue = DurableQueue(folder.newFolder(), plain)
        val session = JSONObject().put("appId", "generated.player").put("appName", "  ")
        val record = event().put("metadata", JSONObject().put("media", JSONObject().put("sessions", JSONArray().put(session))))
        assertThrows(IllegalArgumentException::class.java) { queue.enqueue(record, byteArrayOf(1), 1_000_000) }
        session.put("appName", "生成的播放器")
        queue.enqueue(record, byteArrayOf(1), 1_000_000)
        assertEquals("生成的播放器", queue.peek()!!.getJSONObject("metadata").getJSONObject("media").getJSONArray("sessions").getJSONObject(0).getString("appName"))
    }
}
