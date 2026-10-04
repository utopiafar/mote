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
        for (path in listOf("/api/captures", "/api/captures/bundle", "/api/capture-browser/reconcile", "/api/sources", "/api/sources/id/items", "/api/file-sync/v1/commit")) {
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


}
