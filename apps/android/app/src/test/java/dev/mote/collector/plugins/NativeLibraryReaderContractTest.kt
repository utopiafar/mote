package dev.mote.collector.plugins

import dev.mote.collector.CentralClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Run by test-fixtures/library-source-native.ts against private generated
 * Central data. Ordinary JVM runs skip the external server. */
class NativeLibraryReaderContractTest {
    private val connection = System.getenv("MOTE_LIBRARY_NATIVE_CONNECTION").orEmpty()
    private lateinit var config: JSONObject
    private lateinit var origin: String
    private lateinit var reader: LibraryReader

    @Before fun requireRealLibrary() {
        assumeTrue("Use the Library reader native contract runner", connection.isNotEmpty())
        config = JSONObject(File(connection).readText())
        origin = config.getString("origin")
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(config.getBoolean("generatedOnly"))
        val client = CentralClient(origin, config.getString("token"), transport = { method, url, body, credential, mime -> http(method, url, credential, body, mime) })
        reader = NativeLibraryPlugin.reader { LibraryReader.Access(origin, 1, client) }
    }

    private fun http(method: String, url: String, credential: String, body: ByteArray? = null, mime: String = "application/json"): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $credential")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", mime)
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            return status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    }

    private fun materialRequest() = LibraryReader.Request(
        origin = origin, type = "material", source = config.getString("materialId"), revision = config.getString("revision"),
    )

    @Test fun realMaterialFirstPageAndRangeAreExact() {
        val page = (reader.open(materialRequest()) as LibraryReader.Available).page
        val expected = config.getJSONObject("first")
        assertEquals("material:" + config.getString("materialId") + "@" + config.getString("revision"), page.item.getString("ref"))
        assertEquals(config.getString("revision"), page.item.getString("revision"))
        assertEquals(expected.getString("text"), page.text)
        assertEquals(expected.getInt("offset"), page.range!!.getInt("offset"))
        assertEquals(expected.getInt("total"), page.range.getInt("total"))
        assertEquals(expected.getInt("nextOffset"), page.nextOffset)
        assertEquals(config.getInt("memberTotal"), page.members!!.getInt("total"))
    }

    @Test fun realMaterialContinuationExactPageStartsAtReturnedOffset() {
        val first = (reader.open(materialRequest()) as LibraryReader.Available).page
        val page = (reader.open(materialRequest(), offset = first.nextOffset!!) as LibraryReader.Available).page
        val expected = config.getJSONObject("second")
        assertEquals(expected.getString("text"), page.text)
        assertEquals(expected.getInt("offset"), page.range!!.getInt("offset"))
        assertEquals(expected.getInt("total"), page.range.getInt("total"))
        if (expected.isNull("nextOffset")) assertNull(page.nextOffset) else assertEquals(expected.getInt("nextOffset"), page.nextOffset)
    }

    @Test fun realEvidenceReferenceKeepsItsExactTextAndRange() {
        val expected = config.getJSONObject("evidence")
        val page = (reader.open(LibraryReader.Request(
            origin = origin, type = "evidence", source = "capture:" + expected.getString("captureId"),
        )) as LibraryReader.Available).page
        assertEquals(expected.getString("text"), page.text)
        assertEquals(expected.getInt("offset"), page.range!!.getInt("offset"))
        assertEquals(expected.getInt("total"), page.range.getInt("total"))
        assertEquals(expected.getInt("nextOffset"), page.nextOffset)
    }
}
