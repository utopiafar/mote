package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class NoteDraftStoreTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun event(draft: NoteDraft) = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-09-13T00:00:00Z")
        .put("source", "note").put("ocrText", draft.text).put("mood", draft.mood).put("privacy", JSONObject().put("excluded", false))
    @Test fun `draft text survives recreation without plaintext storage`() {
        val dir = folder.newFolder(); val store = NoteDraftStore(dir, cipher)
        store.update("  原样保留的合成记录\n第二行", "平静")
        assertEquals(store.read().text, NoteDraftStore(dir, cipher).read().text)
        assertFalse(dir.listFiles()!!.any { String(it.readBytes()).contains("原样保留") })
    }
    @Test fun `crash after enqueue before clearing draft reuses submission and does not duplicate`() {
        val dir = folder.newFolder()
        val store = NoteDraftStore(dir, cipher)
        val origin = "https://fixture.example"
        val queueDir = folder.newFolder()
        fun openQueue() = DurableQueue(queueDir, cipher).apply { archiveOrigin = origin }
        store.update("合成草稿", "平静")
        val prepared = store.prepare(origin, ::event).prepared!!
        val id = prepared.getString("id")
        assertEquals(id, openQueue().enqueue(prepared, null))

        val reopened = NoteDraftStore(dir, cipher)
        val queue = openQueue()
        val retry = reopened.prepare(origin) { error("Must reuse original submission") }.prepared!!
        assertEquals(prepared.toString(), retry.toString())
        assertEquals(id, queue.enqueue(retry, null))
        assertEquals(1, queue.depth())
        assertEquals(id, queue.peek()?.getString("id"))

        queue.acknowledge(id)
        assertEquals(id, queue.enqueue(retry, null))
        assertEquals(1, queue.depth())
        assertTrue(queue.capture(id)!!.getBoolean("uploaded"))
        assertNull(queue.peek())
        reopened.clear()
        assertEquals(NoteDraft(), NoteDraftStore(dir, cipher).read())
    }
    @Test fun `only explicit edit or new note resets a prepared submission`() {
        val store = NoteDraftStore(folder.newFolder(), cipher); store.update("same text", "calm")
        val first = store.prepare("https://one.example", ::event).prepared!!.getString("id")
        store.update("same text", "calm")
        assertEquals(first, store.prepare("https://one.example", ::event).prepared!!.getString("id"))
        assertThrows(IllegalArgumentException::class.java) { store.prepare("https://two.example", ::event) }
        store.update("same text edited", "calm")
        assertNotEquals(first, store.prepare("https://two.example", ::event).prepared!!.getString("id"))
        store.clear(); store.update("same text", "calm")
        assertNotEquals(first, store.prepare("https://one.example", ::event).prepared!!.getString("id"))
    }
    @Test fun `unbound prepared note adopts its first destination without replacing its id`() {
        val store = NoteDraftStore(folder.newFolder(), cipher); store.update("generated local note", "")
        val before = store.prepare("", ::event).prepared!!.toString()
        val bound = store.prepare("https://first.example") { error("Must retain the local submission") }
        assertEquals(before, bound.prepared!!.toString())
        assertEquals("https://first.example", bound.server)
        assertThrows(IllegalArgumentException::class.java) { store.prepare("https://other.example", ::event) }
    }
}
