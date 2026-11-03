package dev.mote.collector.plugins

import dev.mote.collector.CaptureBundle
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.UUID

/** Run by test-fixtures/capture-upload-ingress.ts against private generated Central data. */
class CaptureUploadIngressContractTest {
    private val origin = System.getenv("MOTE_CAPTURE_INGRESS_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_CAPTURE_INGRESS_TOKEN").orEmpty()
    private val device = "generated-capture-ingress-device"
    private val pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="

    @Before fun requireRealIngress() {
        assumeTrue("Use the capture upload ingress runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty())
    }

    private fun envelope(source: String, at: String) = JSONObject().put("id", UUID.randomUUID().toString())
        .put("deviceId", device).put("deviceName", "Generated capture phone").put("platform", "android")
        .put("capturedAt", at).put("source", source)

    private fun screen(at: String) = envelope("screen", at).put("durationMs", 0)
        .put("appId", "generated.app").put("appName", "Generated app")
        .put("imageMime", "image/png").put("imageBase64", pixel).put("ocrText", "")
        .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "local").put("collection", "content"))

    private fun activity(at: String) = envelope("activity", at).put("durationMs", 15_000)
        .put("appId", "generated.app").put("appName", "Generated app")
        .put("metadata", JSONObject().put("version", 1).put("observedAt", at)
            .put("capture", JSONObject().put("intervalMs", 15_000)))
        .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "activity"))

    private fun notification(at: String) = envelope("notification", at).put("durationMs", 0)
        .put("appId", "generated.app").put("appName", "Generated app")
        .put("metadata", JSONObject().put("version", 1).put("observedAt", at)
            .put("collector", JSONObject().put("method", "notification_listener"))
            .put("observation", JSONObject().put("sessionId", UUID.randomUUID().toString()).put("elapsedRealtimeMs", 100))
            .put("notification", JSONObject().put("action", "posted").put("notificationKey", "ab".repeat(32))
                .put("postedAt", at).put("ongoing", false).put("groupSummary", false).put("title", "Generated notification")))
        .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))

    private fun post(bundle: ByteArray): Pair<Int, JSONObject?> {
        val connection = URL("$origin/api/captures/bundle").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $owner")
            connection.setRequestProperty("Content-Type", CaptureBundle.CONTENT_TYPE)
            connection.setRequestProperty("X-Mote-Ingress-Version", "2")
            connection.setFixedLengthStreamingMode(bundle.size)
            connection.outputStream.use { it.write(bundle) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            return status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    }

    private fun results(value: JSONObject?): JSONArray = value?.getJSONArray("results") ?: error("Central returned no results")

    @Test fun realKotlinCaptureBundleIsAcceptedByCentralIngress() {
        val at = Instant.now().toString()
        val captures = listOf(screen(at), activity(at), notification(at))
        val bundle = CaptureBundle.encode(captures)

        val first = post(bundle)
        assertEquals(200, first.first)
        val committed = results(first.second)
        assertEquals(captures.size, committed.length())
        for (index in captures.indices) {
            val receipt = committed.getJSONObject(index)
            assertEquals(201, receipt.getInt("status"))
            assertFalse(receipt.getBoolean("duplicate"))
            assertEquals(captures[index].getString("id"), receipt.getJSONObject("receipt").getString("id"))
            assertEquals("received", receipt.getJSONObject("receipt").getString("state"))
        }

        val duplicate = post(bundle)
        assertEquals(200, duplicate.first)
        val repeated = results(duplicate.second)
        assertEquals(captures.size, repeated.length())
        for (index in captures.indices) {
            val receipt = repeated.getJSONObject(index)
            assertEquals(200, receipt.getInt("status"))
            assertTrue(receipt.getBoolean("duplicate"))
            assertEquals(captures[index].getString("id"), receipt.getJSONObject("receipt").getString("id"))
        }
    }
}
