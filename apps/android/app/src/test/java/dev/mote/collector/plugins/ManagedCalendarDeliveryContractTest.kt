package dev.mote.collector.plugins

import dev.mote.collector.CalendarCapabilityPublisher
import dev.mote.collector.ManagedCalendarJournal
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/managed-calendar-ack.ts against the existing generated
 * managed-calendar Central fixture. Central performs the real grant, delivery,
 * claim and receipt writes; the JDK replaces only Android's missing HTTP
 * boundary. The emulator native-write journey remains separately gated. */
class ManagedCalendarDeliveryContractTest {
    private val origin = System.getenv("MOTE_MANAGED_CALENDAR_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_MANAGED_CALENDAR_TOKEN").orEmpty()

    @Before fun requireRealFixture() {
        assumeTrue("Use the managed calendar delivery runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty())
    }

    private fun http(method: String, path: String, body: JSONObject? = null, token: String = owner): Pair<Int, JSONObject?> {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            return status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    }

    private fun ok(method: String, path: String, body: JSONObject? = null): JSONObject {
        val (status, value) = http(method, path, body)
        check(status in 200..299 && value != null) { "Generated Central response $status for $path" }
        return value
    }

    @Test fun onlyTheGrantedDeviceClaimsAndARetainedAckIsIdempotent() {
        val pair = ok("GET", "/fixture/pair")
        val deviceId = pair.getString("deviceId")
        assertEquals("generated-device", deviceId)
        val deviceToken = pair.getString("token")
        val transport: (String, JSONObject?) -> JSONObject = { path, body ->
            val (status, value) = http(if (body == null) "GET" else "POST", path, body, deviceToken)
            check(status in 200..299 && value != null) { "Generated Central response $status for $path" }
            value
        }
        CalendarCapabilityPublisher(deviceId, transport).publish(JSONArray().put(JSONObject().put("id", "generated-calendar").put("title", "Generated calendar")))

        val action = ok("POST", "/fixture/add", JSONObject())
        val id = action.getString("id")
        val beforeGrant = ok("GET", "/fixture/delivery/$id")
        assertFalse("A device without an approved grant receives no delivery", beforeGrant.has("operationId"))
        ok("POST", "/fixture/grant", JSONObject().put("calendarId", "generated-calendar"))
        val delivery = ok("GET", "/fixture/delivery/$id")
        val operation = delivery.getString("operationId")

        val disk = mutableMapOf<String, String>()
        val journal = ManagedCalendarJournal(deviceId, transport, disk::get, { key, value -> disk[key] = value })
        val claimed = requireNotNull(journal.claim(id, operation) { })
        assertEquals(id, claimed.getString("id"))
        assertEquals(operation, claimed.getString("operationId"))
        assertEquals(deviceId, claimed.getJSONObject("target").getString("deviceId"))
        journal.remember(claimed)

        disk[operation] = "generated-native-event"
        assertNull("A retained receipt is acknowledged without another claim", journal.claim(id, operation) { fail("Receipt replay must not claim") })
        val first = ok("GET", "/fixture/action/$id")
        assertEquals("succeeded", first.getString("status"))
        assertEquals("generated-native-event", first.getString("externalId"))

        assertNull("A repeated acknowledgement never claims or writes again", journal.claim(id, operation) { fail("Second ACK must not claim") })
        val second = ok("GET", "/fixture/action/$id")
        assertEquals(first.getString("status"), second.getString("status"))
        assertEquals(first.getString("externalId"), second.getString("externalId"))

        val foreign = http("POST", "/api/managed-calendar/$id/claim", JSONObject().put("deviceId", "generated-other-device"), deviceToken)
        assertEquals("A device identity mismatch never claims the action", 403, foreign.first)
    }
}
