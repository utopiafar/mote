package dev.mote.collector.plugins

import dev.mote.collector.ProtocolCompatibility
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/native-capability-publisher.ts against a generated
 * Central node. Central performs the real declaration writes and projection;
 * the JDK replaces only Android's missing HTTP boundary. No emulator, device
 * calendar or OS grant is involved. */
class NativeCapabilityPublicationContractTest {
    private val origin = System.getenv("MOTE_CAPABILITY_ORIGIN").orEmpty()
    private val token = System.getenv("MOTE_CAPABILITY_TOKEN").orEmpty()
    private val deviceId = System.getenv("MOTE_CAPABILITY_DEVICE").orEmpty()

    @Before fun requireRealFixture() {
        assumeTrue("Use the native capability publisher runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(token.isNotEmpty())
        assertTrue(deviceId.isNotEmpty())
    }

    private fun http(method: String, path: String, body: JSONObject? = null): JSONObject {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $token")
            // The production client sends the same wire metadata before it attests a capability.
            ProtocolCompatibility.headers.forEach(connection::setRequestProperty)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            check(status in 200..299 && text != null) { "Generated Central response $status for ${connection.requestMethod} $path" }
            return JSONObject(text)
        } finally { connection.disconnect() }
    }

    @Test fun realCentralAcceptsThePublisherPayloadAndProjectsSeparateFacts() {
        val registry = NativePluginRegistry().apply { ManagedCalendarPlugin.register(this, "generated-build") }
        val transport: (String, JSONObject?) -> JSONObject = { path, body -> http(if (body == null) "GET" else "POST", path, body) }
        val publisher = NativeCapabilityPublisher(deviceId, transport, availability = { registry.availability(ManagedCalendarPlugin.requirement()) })
        val calendars = JSONArray().put(JSONObject().put("id", "generated-calendar").put("title", "Generated calendar"))

        val granted = publisher.publish(calendars)
        assertEquals(CapabilityActionState.ACTIVE, granted.state)
        assertEquals("granted", granted.declaration!!.getString("permission"))
        assertEquals("generated-calendar", granted.declaration!!.getJSONArray("calendars").getJSONObject(0).getString("id"))
        val grantedProjection = granted.projection!!
        assertFalse("installation is the enabled provider, not a device declaration", grantedProjection.getBoolean("installed"))
        assertEquals("granted", grantedProjection.getString("grant"))
        assertTrue(grantedProjection.getBoolean("available"))
        assertFalse("a declaration is never an owner grant", grantedProjection.getBoolean("authorized"))
        assertFalse(grantedProjection.getBoolean("waitingDevice"))

        val revoked = publisher.publish(null)
        assertEquals(CapabilityActionState.BLOCKED, revoked.state)
        assertEquals("required", revoked.declaration!!.getString("permission"))
        assertEquals(0, revoked.declaration!!.getJSONArray("calendars").length())
        val revokedProjection = revoked.projection!!
        assertEquals("required", revokedProjection.getString("grant"))
        assertFalse(revokedProjection.getBoolean("available"))
        assertFalse(revokedProjection.getBoolean("authorized"))
        assertFalse(revokedProjection.getBoolean("waitingDevice"))
    }
}
