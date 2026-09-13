package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class ComplexNoteRoundTripTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun event(draft: NoteDraft): JSONObject = JSONObject().put("id", UUID.randomUUID().toString())
        .put("capturedAt", "2026-09-13T00:00:00Z").put("source", "note").put("ocrText", draft.text)
        .put("privacy", JSONObject().put("excluded", false)).also { if (draft.mood.isNotBlank()) it.put("mood", draft.mood) }

    @Test fun `three generated rounds retain exact unicode whitespace and ids across storage boundaries`() {
        repeat(3) { round ->
            ComplexNoteFixtures.cases(round).forEach { fixture ->
                val draftDir = folder.newFolder(); val queueDir = folder.newFolder()
                val drafts = NoteDraftStore(draftDir, cipher); drafts.update(fixture.text, fixture.mood)
                val first = drafts.prepare("https://fixture.example", ::event).prepared!!
                val restored = NoteDraftStore(draftDir, cipher)
                assertEquals(fixture.name, fixture.text, restored.read().text)
                assertEquals(fixture.mood, restored.read().mood)
                val same = restored.prepare("https://fixture.example") { error("Prepared submission must not be regenerated") }.prepared!!
                assertEquals(first.toString(), same.toString())
                val queue = DurableQueue(queueDir, cipher); queue.enqueue(same, null, 2_000_000)
                val restarted = DurableQueue(queueDir, cipher); restarted.recoverOrphans(); restarted.enqueue(first, null, 2_000_000)
                val actual = restarted.peek()!!
                assertEquals(1, restarted.depth()); assertEquals(fixture.text, actual.getString("ocrText"))
                assertEquals(first.getString("id"), actual.getString("id"))
                if (fixture.mood.isBlank()) assertFalse(actual.has("mood")) else assertEquals(fixture.mood, actual.getString("mood"))
                assertFalse(actual.has("imageBase64")); assertEquals(0, queueDir.listFiles()!!.count { it.extension == "blob" })
                assertThrows(IllegalStateException::class.java) { restarted.enqueue(JSONObject(actual.toString()).put("ocrText", "different"), null, 2_000_000) }
                restarted.acknowledge(actual.getString("id")); restored.clear(); assertEquals(0, restarted.depth()); assertEquals("", restored.read().text)
            }
        }
    }
    @Test fun `limit and queue failure preserve prior encrypted draft and prepared id`() {
        val dir = folder.newFolder(); val drafts = NoteDraftStore(dir, cipher)
        val fixture = ComplexNoteFixtures.cases(9).first { it.name == "maximum-length" }
        drafts.update(fixture.text, fixture.mood)
        assertThrows(IllegalArgumentException::class.java) { drafts.update(fixture.text + "界", fixture.mood) }
        assertEquals(fixture.text, drafts.read().text)
        val prepared = drafts.prepare("https://fixture.example", ::event).prepared!!
        val queue = DurableQueue(folder.newFolder(), cipher)
        assertThrows(QueueFull::class.java) { queue.enqueue(prepared, null, 100) }
        assertEquals(0, queue.depth())
        assertEquals(prepared.toString(), NoteDraftStore(dir, cipher).prepare("https://fixture.example", ::event).prepared!!.toString())
        queue.enqueue(prepared, null, 2_000_000)
        assertEquals(fixture.text, queue.peek()!!.getString("ocrText"))
    }
}
