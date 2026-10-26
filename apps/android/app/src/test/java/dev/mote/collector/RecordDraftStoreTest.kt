package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

class RecordDraftStoreTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private fun event(draft: JSONObject) = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "note").put("ocrText", draft.getString("text")).put("capturedAt", "2026-10-25T00:00:00Z").put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
    @Test fun historyCompletionRequiresOriginalAttachmentHashAndKeepsDraft() {
        val store=RecordDraftStore(folder.newFolder(),cipher); val bytes=byteArrayOf(1,2,3)
        val attachment=store.stage(bytes,"generated.bin","application/octet-stream")
        store.edit("Generated draft",JSONArray().put(attachment),JSONObject().put("kind","manual"))
        val record=store.prepare("https://generated.example",::event)
        val hash=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val identity=ItemUploadIdentity("attachment","scope","capture","https://generated.example","device","target","source","external","revision","fingerprint",hash,3,record.getString("id"),attachment.getString("id"))
        val id=UUID.randomUUID().toString()
        assertFalse(store.acknowledgeExact(identity.copy(sha256="wrong"),id))
        assertFalse(store.acknowledgeExact(identity.copy(origin="https://other.example"),id))
        assertEquals(0,store.record(record.getString("id"))!!.getJSONObject("acks").length())
        assertTrue(store.acknowledgeExact(identity,id))
        assertFalse(store.acknowledgeExact(identity,UUID.randomUUID().toString()))
        assertEquals(id,store.record(record.getString("id"))!!.getJSONObject("acks").getString(attachment.getString("id")))
        assertEquals("Generated draft",store.draft().getString("text")); assertArrayEquals(bytes,store.bytes(attachment.getString("id")))
    }

    @Test fun `offline combined record survives restart and lost enqueue confirmation without duplication`() {
        val directory = folder.newFolder(); val store = RecordDraftStore(directory, cipher)
        val attachment = store.stage("generated original attachment".toByteArray(), "fixture.txt", "text/plain")
        store.edit("Generated comment", JSONArray().put(attachment), JSONObject().put("kind", "manual"))
        val prepared = store.prepare("https://fixture.example", ::event)
        assertTrue(store.hasPrepared())
        val queue = DurableQueue(folder.newFolder(), cipher); queue.enqueue(prepared, null, 100000)
        val reopened = RecordDraftStore(directory, cipher)
        val retry = reopened.prepare("https://fixture.example") { error("No new ID after crash") }
        queue.enqueue(retry, null, 100000)
        assertEquals(1, queue.depth()); assertEquals(prepared.toString(), retry.toString())
        assertEquals("generated original attachment", String(reopened.bytes(attachment.getString("id"))))
        assertFalse(directory.listFiles()!!.any { String(it.readBytes()).contains("Generated comment") || String(it.readBytes()).contains("generated original attachment") })
        reopened.finish(retry.getString("id")); assertFalse(reopened.hasPrepared()); assertEquals("", reopened.draft().getString("text"))
        assertEquals(1, reopened.record(retry.getString("id"))!!.getJSONArray("attachments").length())
    }
    @Test fun `attachment only and shared original are valid but an empty record is not`() {
        val store = RecordDraftStore(folder.newFolder(), cipher)
        assertThrows(IllegalArgumentException::class.java) { store.prepare("", ::event) }
        val attachment = store.stage(byteArrayOf(1, 2, 3), "fixture.jpg", "image/jpeg")
        store.edit("", JSONArray().put(attachment), JSONObject().put("kind", "manual"))
        val image = store.prepare("", ::event); assertEquals("", image.getString("ocrText")); store.finish(image.getString("id"))
        store.edit("", JSONArray(), JSONObject().put("kind", "share").put("text", "Third party source"))
        assertEquals("", store.prepare("", ::event).getString("ocrText"))
        assertEquals("Third party source", store.draft().getJSONObject("origin").getString("text"))
    }
    @Test fun `partial attachment ACK survives restart and prepared owner cannot change`() {
        val directory = folder.newFolder(); val store = RecordDraftStore(directory, cipher)
        val a = store.stage(byteArrayOf(1), "a.bin", "application/octet-stream")
        val b = store.stage(byteArrayOf(2), "b.bin", "application/octet-stream")
        store.edit("", JSONArray().put(a).put(b), JSONObject().put("kind", "manual"))
        val prepared = store.prepare("https://one.example", ::event); val ack = UUID.randomUUID().toString()
        store.acknowledge(prepared.getString("id"), a.getString("id"), ack)
        val reopened = RecordDraftStore(directory, cipher)
        assertEquals(ack, reopened.record(prepared.getString("id"))!!.getJSONObject("acks").getString(a.getString("id")))
        assertFalse(reopened.record(prepared.getString("id"))!!.getJSONObject("acks").has(b.getString("id")))
        assertThrows(IllegalArgumentException::class.java) { reopened.prepare("https://two.example", ::event) }
        reopened.edit("explicit edit", JSONArray().put(a).put(b), JSONObject().put("kind", "manual"))
        assertNotEquals(prepared.getString("id"), reopened.prepare("https://two.example", ::event).getString("id"))
    }
    @Test fun `concurrent save preparation cannot allocate multiple submission identities`() {
        val store = RecordDraftStore(folder.newFolder(), cipher)
        store.edit("Concurrent generated record", JSONArray(), JSONObject().put("kind", "manual"))
        val executor = java.util.concurrent.Executors.newFixedThreadPool(6)
        val start = java.util.concurrent.CountDownLatch(1)
        try {
            val calls = (0 until 6).map { executor.submit<String> { start.await(); store.prepare("https://fixture.example", ::event).getString("id") } }
            start.countDown()
            assertEquals(1, calls.map { it.get(5, java.util.concurrent.TimeUnit.SECONDS) }.toSet().size)
        } finally { executor.shutdownNow() }
    }
    @Test fun `retention keeps draft and retained original and removes pruned capture mapping`() {
        val store = RecordDraftStore(folder.newFolder(), cipher)
        val attachment = store.stage(byteArrayOf(1, 2), "fixture.bin", "application/octet-stream")
        store.edit("Generated retained note", JSONArray().put(attachment), JSONObject().put("kind", "manual"))
        val event = store.prepare("", ::event); store.finish(event.getString("id"))
        store.prune { true }; assertNotNull(store.record(event.getString("id")))
        assertArrayEquals(byteArrayOf(1, 2), store.bytes(attachment.getString("id")))
        store.prune { false }; assertNull(store.record(event.getString("id")))
    }

    @Test fun `combined local quota rejects attachment without destroying existing draft or prepared submission`() {
        val directory = folder.newFolder(); var available = 4096L
        val store = RecordDraftStore(directory, cipher) { available }
        store.edit("Quota protected draft", JSONArray(), JSONObject().put("kind", "manual"))
        val prepared = store.prepare("https://fixture.example", ::event)
        available = store.diskBytes() + 8
        assertThrows(QueueFull::class.java) { store.stage(ByteArray(20), "too-large.bin", "application/octet-stream") }
        assertEquals(prepared.toString(), store.prepare("https://fixture.example") { error("Keep stable identity") }.toString())
        assertEquals("Quota protected draft", store.draft().getString("text"))
        assertTrue(store.hasPrepared())
    }

    @Test fun `ordinary capture writers count existing record originals in the same queue limit`() {
        val store = RecordDraftStore(folder.newFolder(), cipher)
        store.stage(ByteArray(32000) { 1 }, "fixture.bin", "application/octet-stream")
        val queue = DurableQueue(folder.newFolder(), cipher).apply { externalStorageBytes = { store.diskBytes() } }
        val capture = event(JSONObject().put("text", "Generated ordinary capture"))
        assertThrows(QueueFull::class.java) { queue.enqueue(capture, null, 32000) }
        assertEquals(0, queue.depth())
        queue.enqueue(capture, null, 1000000); assertEquals(1, queue.depth())
    }
    @Test fun `failed native media staging remains journaled across reopening until explicit completion`() {
        val directory = folder.newFolder(); val store = RecordDraftStore(directory, cipher)
        val media = JSONObject().put("id", UUID.randomUUID().toString()).put("path", "/generated/private/pending.m4a").put("name", "pending.m4a").put("mime", "audio/mp4")
        store.holdMedia(media)
        val reopened = RecordDraftStore(directory, cipher)
        assertEquals(media.toString(), reopened.pendingMedia().getJSONObject(0).toString())
        reopened.edit("Kept comment", JSONArray(), JSONObject().put("kind", "manual"))
        assertEquals(1, reopened.pendingMedia().length())
        reopened.finishMedia(media.getString("id")); assertEquals(0, reopened.pendingMedia().length())
    }

}
