package dev.mote.collector.plugins

import dev.mote.collector.CentralClient
import dev.mote.collector.HomeArchiveProbe
import dev.mote.collector.HomeFeed
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/home-read-native.ts against private generated Central
 * data. Central supplies the real capture page; the JDK replaces only
 * Android's missing HTTP boundary. */
class DailyHomeReadContractTest {
    private val origin = System.getenv("MOTE_HOME_READ_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_HOME_READ_TOKEN").orEmpty()
    private val evidence = System.getenv("MOTE_HOME_READ_EVIDENCE").orEmpty()

    @Before fun requireRealHomeRead() {
        assumeTrue("Use the home read ingress runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty())
        assertTrue(evidence.isNotEmpty())
    }

    /** JDK replaces only Android's bounded HTTP/meter boundary. */
    private fun client() = CentralClient(origin, owner, transport = { method, url, _, credential, _ ->
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $credential")
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    })

    @Test fun realCapturePageReachesTheHomeReadWithoutStartingAQuery() {
        val api = client()
        val rows = HomeFeed.page(api::get)
        val original = rows.firstOrNull { it.id == evidence }
        assertNotNull("the generated original is visible", original)
        assertEquals("generated-home-device", original!!.deviceId)
        assertEquals("note", original.source)
        assertFalse("the generated evidence makes the archive non-empty", HomeArchiveProbe.empty(api::get))
    }
}
