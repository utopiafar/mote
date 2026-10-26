package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CalendarCapabilityPublisherTest {
    @Test fun lostDeclarationResponseAndRecreatedPublisherDoNotInvalidateScopeButPermissionLossDoes() {
        var declaration: JSONObject? = null
        var writes = 0
        var loseAck = true
        val calendars = JSONArray().put(JSONObject().put("id", "generated").put("title", "Generated"))
        val transport: (String, JSONObject?) -> JSONObject = { path, body ->
            when (path) {
                "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("deviceId", "generated-device"))
                "/api/device-action-capabilities" -> if (body == null) JSONObject().put("connectionId", "generated-connection").put("declaration", declaration ?: JSONObject.NULL) else {
                    assertEquals(declaration?.getLong("revision") ?: 0L, body.getLong("expectedRevision"))
                    writes++
                    declaration = JSONObject(body.toString()).put("revision", writes).put("connectionId", "generated-connection").put("connectionActive", true)
                    if (loseAck) { loseAck = false; throw IllegalStateException("Generated lost response") }
                    declaration!!
                }
                else -> error("Unexpected execution or review request: $path")
            }
        }
        assertThrows(IllegalStateException::class.java) { CalendarCapabilityPublisher("generated-device", transport).publish(calendars) }
        CalendarCapabilityPublisher("generated-device", transport).publish(calendars)
        assertEquals(1, writes)
        CalendarCapabilityPublisher("generated-device", transport).publish(null)
        assertEquals(2, writes)
        assertEquals("required", declaration!!.getString("permission"))
        assertEquals(0, declaration!!.getJSONArray("calendars").length())
        CalendarCapabilityPublisher("generated-device", transport).publish(calendars)
        assertEquals(3, writes)
    }

    @Test fun unboundOwnerCannotDeclareAndForeignDeviceIdentityIsRejected() {
        var device: String? = null
        val publisher = CalendarCapabilityPublisher("generated-device") { path, _ ->
            assertEquals("/api/connections/self", path)
            JSONObject().put("credential", JSONObject().put("scope", "owner").apply { device?.let { put("deviceId", it) } })
        }
        publisher.publish(JSONArray())
        device = "foreign-device"
        assertThrows(IllegalArgumentException::class.java) { publisher.publish(JSONArray()) }
    }
}
