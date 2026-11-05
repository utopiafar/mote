package dev.mote.collector.recording

import dev.mote.collector.ByteCipher
import dev.mote.collector.RecordDraftStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.InputStream
import java.io.OutputStream

class RecordingDraftConcurrencyTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
        override fun seal(input: InputStream, output: OutputStream) { output.write(seal(input.readBytes())) }
    }

    @Test fun `an edit queued during rotation preserves the segment and a user removal`() {
        val store = RecordDraftStore(folder.newFolder("private-draft"), cipher)
        val kept = store.stage(byteArrayOf(1), "kept.txt", "text/plain")
        val removed = store.stage(byteArrayOf(2), "removed.txt", "text/plain")
        val origin = JSONObject().put("kind", "manual")
        store.edit("before", JSONArray().put(kept).put(removed), origin)
        val staleEdit = JSONArray().put(kept)
        val writer = SegmentedAudioWriter(folder.newFolder("generated-audio"), 44_100, 1)
        writer.write(byteArrayOf(10, 20, 30))
        val item = RecordingDraftSink(store).commit(writer.finish().single())
        val merged = mergeRecordedAttachments(staleEdit, store.draft().getJSONArray("attachments"), setOf(item.getString("id")))
        store.edit("edited during recording", merged, origin)

        val draft = store.draft()
        assertEquals("edited during recording", draft.getString("text"))
        assertEquals(2, draft.getJSONArray("attachments").length())
        assertEquals(kept.getString("id"), draft.getJSONArray("attachments").getJSONObject(0).getString("id"))
        assertEquals(item.getString("id"), draft.getJSONArray("attachments").getJSONObject(1).getString("id"))
        assertTrue(AdtsFrames.parse(store.bytes(item.getString("id"))).isNotEmpty())
        assertNotEquals(removed.getString("id"), draft.getJSONArray("attachments").getJSONObject(1).getString("id"))
    }
    @Test fun `reopening an editor recovers a killed session without moving the live one`() {
        val store = RecordDraftStore(folder.newFolder("recovery-draft"), cipher)
        val root = folder.newFolder("sessions")
        val abandoned = root.resolve("abandoned")
        val live = root.resolve("live")
        val oldWriter = SegmentedAudioWriter(abandoned, 44_100, 1)
        oldWriter.write(byteArrayOf(3, 4, 5)); oldWriter.finish()
        val liveWriter = SegmentedAudioWriter(live, 44_100, 1)
        liveWriter.write(byteArrayOf(6, 7, 8))
        val liveFile = checkNotNull(liveWriter.openFile)
        val liveBytes = liveFile.readBytes()
        val sink = RecordingDraftSink(store)

        recoverAbandonedRecordings(root, live, sink)
        assertFalse(abandoned.exists())
        assertTrue(liveFile.isFile)
        assertArrayEquals(liveBytes, liveFile.readBytes())
        assertEquals(1, store.draft().getJSONArray("attachments").length())
        liveWriter.write(byteArrayOf(9, 10, 11)); liveWriter.finish()
        recoverAbandonedRecordings(root, null, sink)
        assertEquals(2, store.draft().getJSONArray("attachments").length())
        recoverAbandonedRecordings(root, null, sink)
        assertEquals("Recovery is idempotent", 2, store.draft().getJSONArray("attachments").length())
    }

}
