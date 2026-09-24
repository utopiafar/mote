package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class IngressV2ProtocolTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private fun ack(kind: String, sourceId: String? = null): JSONObject {
        val id = UUID.randomUUID().toString()
        val inner = JSONObject().put("version", 2).put("id", id).put("kind", kind)
            .put("state", "received").put("duplicate", false)
        val outer = JSONObject().put("id", id).put("duplicate", false)
        if (sourceId != null) {
            for ((key, value) in mapOf("sourceId" to sourceId, "externalId" to "generated-item", "revision" to "generated-revision")) {
                inner.put(key, value); outer.put(key, value)
            }
        }
        return outer.put("receipt", inner)
    }

    @Test fun `upload writes carry version while reads do not`() {
        for (path in listOf("/api/captures", "/api/captures/bundle", "/api/capture-browser/id/ocr", "/api/sources", "/api/sources/id/items", "/api/file-sync/v1/commit")) {
            assertTrue(IngressV2Protocol.uploadWrite("POST", "http://127.0.0.1:47842$path"))
        }
        assertFalse(IngressV2Protocol.uploadWrite("GET", "http://127.0.0.1:47842/api/captures"))
        assertFalse(IngressV2Protocol.uploadWrite("POST", "http://127.0.0.1:47842/api/devices/heartbeat"))
    }

    @Test fun `only matched nested v2 receipts release captures and source revisions`() {
        val capture = ack("capture")
        assertTrue(IngressV2Protocol.validCapture(capture.getString("id"), capture))
        assertFalse(IngressV2Protocol.validCapture(capture.getString("id"), JSONObject(capture.toString()).apply { remove("receipt") }))
        assertFalse(IngressV2Protocol.validCapture(capture.getString("id"), JSONObject(capture.toString()).apply { getJSONObject("receipt").put("version", 1) }))
        assertFalse(IngressV2Protocol.validCapture(capture.getString("id"), JSONObject(capture.toString()).apply { getJSONObject("receipt").put("kind", "source-item") }))
        val source = ack("source-item", "generated-source")
        val item = JSONObject().put("externalId", "generated-item").put("revision", "generated-revision")
        assertTrue(IngressV2Protocol.validSource("generated-source", item, source))
        assertFalse(IngressV2Protocol.validSource("other-source", item, source))
        assertFalse(IngressV2Protocol.validSource("generated-source", item, JSONObject(source.toString()).apply { getJSONObject("receipt").put("revision", "wrong") }))
        val file = ack("file-revision", "generated-source")
        assertTrue(IngressV2Protocol.validFile("generated-source", item, file))
        assertFalse(IngressV2Protocol.validSource("generated-source", item, file))
    }

    @Test fun `409 is a pause only when the authorized source listing confirms disabled state`() {
        val paused = JSONObject().put("items", org.json.JSONArray().put(JSONObject().put("id", "generated-source").put("enabled", false)))
        val active = JSONObject().put("items", org.json.JSONArray().put(JSONObject().put("id", "generated-source").put("enabled", true)))
        assertTrue(IngressV2Protocol.sourcePaused("generated-source", paused))
        assertFalse(IngressV2Protocol.sourcePaused("generated-source", active))
        assertFalse(IngressV2Protocol.sourcePaused("other-source", paused))
        assertFalse(IngressV2Protocol.sourcePaused("generated-source", JSONObject().put("items", org.json.JSONArray())))
        assertFalse(IngressV2Protocol.sourcePaused("generated-source", null))
    }

    @Test fun `protocol cleanup preserves configured sources and draft text but discards old work`() {
        val captureDir = folder.newFolder("captures")
        val queue = DurableQueue(captureDir, cipher)
        val pending = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "note")
            .put("ocrText", "generated pending").put("capturedAt", "2026-09-24T00:00:00Z")
            .put("privacy", JSONObject().put("excluded", false))
        val retained = JSONObject(pending.toString()).put("id", UUID.randomUUID().toString()).put("ocrText", "generated retained")
        queue.enqueue(pending, null, 100000)
        queue.enqueue(retained, null, 100000)
        queue.acknowledge(retained.getString("id"), retentionDays = 7)
        assertEquals(1, queue.discardLegacyOutbox())
        assertEquals(1, queue.depth())
        assertFalse(queue.syncIds().contains(pending.getString("id")))
        assertTrue(queue.syncIds().contains(retained.getString("id")))

        val sourceDir = folder.newFolder("sources")
        val sources = LocalSourceStore(sourceDir, cipher)
        val source = LocalSource(id = "generated-source", name = "Generated", kind = "local-files", uri = "content://fixture/document/root")
        sources.save(source); sources.selectTarget(source.id, "old-target")
        assertTrue(File(sourceDir, "config.enc").exists())
        sources.resetForProtocolUpgrade()
        assertEquals(listOf(source), LocalSourceStore(sourceDir, cipher).sources())
        assertFalse(LocalSourceStore(sourceDir, cipher).state(source.id).has("target"))

        val archiveDir = folder.newFolder("archives")
        val archive = FileArchiveQueue(archiveDir, cipher)
        archive.saveState(source.id, JSONObject().put("generation", "old-generation"))
        archive.resetForProtocolUpgrade()
        assertFalse(FileArchiveQueue(archiveDir, cipher).state(source.id).has("generation"))

        val drafts = NoteDraftStore(folder.newFolder("draft"), cipher)
        drafts.update("generated note", "calm")
        drafts.prepare("https://old.example") { draft -> JSONObject().put("id", UUID.randomUUID().toString())
            .put("source", "note").put("ocrText", draft.text).put("mood", draft.mood) }
        drafts.clearPreparedForProtocolUpgrade()
        assertEquals("generated note", drafts.read().text)
        assertEquals("calm", drafts.read().mood)
        assertNull(drafts.read().prepared)
        assertNull(drafts.read().server)
    }
}
