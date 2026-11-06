package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.CentralClient
import dev.mote.collector.DurableQueue
import dev.mote.collector.HomeArchiveProbe
import dev.mote.collector.HomeFeed
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/home-read-native.ts against private generated Central
 * data. Central supplies the real capture page; the JDK replaces only
 * Android's missing HTTP boundary. */
class DailyHomeReadContractTest {
    private val origin = System.getenv("MOTE_HOME_READ_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_HOME_READ_TOKEN").orEmpty()
    private val evidence = System.getenv("MOTE_HOME_READ_EVIDENCE").orEmpty()
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes
        override fun open(bytes: ByteArray) = bytes
    }

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

    @Test fun acknowledgedLocalCopyJoinsTheRealCentralRowWithoutASecondHomeEntry() {
        val queue = DurableQueue(folder.newFolder(), cipher).apply { archiveOrigin = origin }
        val event = JSONObject().put("id", evidence).put("deviceId", "generated-home-device")
            .put("capturedAt", "2026-11-04T04:00:00Z").put("platform", "android").put("source", "note")
            .put("durationMs", 0).put("ocrText", "Generated home evidence")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
        queue.enqueue(event, null, 1_000_000)
        val localPage = queue.recentPage()
        val local = HomeFeed.localPage { localPage }
        assertTrue(local.single().saved)
        queue.acknowledge(evidence, retentionDays = 7)

        val central = HomeFeed.page(client()::get)
        val bindings = localPage.getJSONObject("bindings")
        val merged = HomeFeed.merge(local, mapOf(evidence to bindings.getString(evidence)), central, origin)
        val joined = merged.filter { it.id == evidence }
        assertEquals("the ACKed local id and real Central id are one row", 1, joined.size)
        assertTrue(joined.single().remote)
        assertFalse(joined.single().saved)
        assertEquals("Generated home evidence", joined.single().title)
    }
}
