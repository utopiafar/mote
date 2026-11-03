package dev.mote.collector

import dev.mote.collector.plugins.NoteSaveReceipt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID

/** The dedicated runner supplies a response produced by a real Central POST
 * /api/notes. Ordinary JVM runs use the same receipt shape without Node. */
class NotesPluginContractTest {
    private val fixture = System.getenv("MOTE_NOTE_NATIVE_FIXTURE").orEmpty()
    private val result = System.getenv("MOTE_NOTE_NATIVE_RESULT").orEmpty()
    private val expected = System.getenv("MOTE_NOTE_NATIVE_ID").orEmpty()

    private fun response(id: String) = JSONObject()
        .put("id", id).put("duplicate", false)
        .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "capture").put("state", "received").put("duplicate", false))

    @Test fun `central note save receipt is parsed by the notes plugin`() {
        val id = if (fixture.isNotBlank()) {
            require(result.isNotBlank() && expected.isNotBlank()) { "The real Central note runner supplies fixture, result and id" }
            JSONObject(File(fixture).readText())
        } else {
            response(UUID.randomUUID().toString()).let { JSONObject().put("first", it).put("duplicate", JSONObject(it.toString()).put("duplicate", true).put("receipt", JSONObject(it.getJSONObject("receipt").toString()).put("duplicate", true))) }
        }
        val first = NoteSaveReceipt.parse(id.getJSONObject("first"))
        val duplicate = NoteSaveReceipt.parse(id.getJSONObject("duplicate"))
        assertEquals(first.id, duplicate.id)
        assertFalse(first.duplicate)
        assertTrue(duplicate.duplicate)
        if (fixture.isNotBlank()) {
            assertEquals(expected, first.id)
            File(result).writeText(JSONObject().put("id", first.id).put("duplicate", duplicate.duplicate).toString())
        }
    }
}
