package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.CaptureAttemptStore
import dev.mote.collector.CaptureReceiptStore
import dev.mote.collector.CaptureUploadAttempt
import dev.mote.collector.CaptureUploadCompletion
import dev.mote.collector.CaptureUploadReceipt
import dev.mote.collector.DurableQueue
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.UUID

/** Run by test-fixtures/durable-transport-ingress.ts against private generated Central data. */
class DurableTransportIngressContractTest {
    private val origin = System.getenv("MOTE_DURABLE_TRANSPORT_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_DURABLE_TRANSPORT_TOKEN").orEmpty()
    private val device = "generated-durable-device"
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 53).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    private class Store : CaptureReceiptStore, CaptureAttemptStore {
        val rows = linkedMapOf<String, CaptureUploadReceipt>()
        private val unfinished = linkedMapOf<String, CaptureUploadCompletion>()
        val attempts = mutableListOf<CaptureUploadAttempt>()
        override fun received(receipt: CaptureUploadReceipt): CaptureUploadCompletion {
            val first = rows.getOrPut(receipt.itemKey) { receipt }
            return unfinished.getOrPut(receipt.itemKey) { first.completion() }
        }
        override fun pending(scope: String) = unfinished.values.filter { it.scope == scope }
        override fun completed(itemKey: String) { unfinished.remove(itemKey) }
        override fun saveAttempt(attempt: CaptureUploadAttempt) {
            attempts.removeAll { it.id == attempt.id }
            attempts += attempt
        }
    }

    @Before fun requireRealIngress() {
        assumeTrue("Use the durable transport ingress runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty())
    }

    private fun event() = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", device)
        .put("deviceName", "Generated transport phone").put("platform", "android").put("source", "note")
        .put("capturedAt", "2026-10-26T00:00:00Z").put("durationMs", 0)
        .put("ocrText", "Generated durable transport ingress body")
        .put("privacy", JSONObject().put("excluded", false))

    /** JDK replaces only Android's bounded HTTP/meter boundary. */
    private fun post(event: JSONObject): Pair<Int, JSONObject?> {
        val connection = URL("$origin/api/captures").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $owner")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("X-Mote-Ingress-Version", "2")
            connection.outputStream.use { it.write(event.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            return status to text?.takeIf(String::isNotBlank)?.let(::JSONObject)
        } finally { connection.disconnect() }
    }

    @Test fun realIngressKeepsOneReceiptAcrossLostAckAndDuplicateRetry() {
        val directory = Files.createTempDirectory("mote-durable-transport-").toFile()
        try {
            val queue = DurableQueue(directory, cipher).apply { archiveOrigin = origin }
            val event = event(); queue.enqueue(event, null, 1_000_000)
            val store = Store()
            val transport = DurableCaptureTransport(queue, store, store, CaptureUploadReceipt.scope(origin, device),
                origin, device, UUID.randomUUID().toString(), process = "generated-contract")

            var committed: JSONObject? = null
            assertThrows(IOException::class.java) {
                transport.send(listOf(event), individual = true, bytes = event.toString().toByteArray().size.toLong()) {
                    val response = post(event)
                    assertTrue("Central committed the generated capture", response.first in 200..201)
                    committed = response.second
                    throw IOException("Generated loss after Central committed the capture")
                }
            }
            assertEquals(1, queue.pendingSync().count)
            assertEquals("unknown", store.attempts.single().state)
            assertTrue(store.rows.isEmpty())

            val outcome = transport.send(listOf(event), individual = true, bytes = event.toString().toByteArray().size.toLong()) { post(event) }
            assertEquals(200, outcome.response.first)
            assertEquals(1, outcome.acknowledged)
            val first = committed!!.getJSONObject("receipt")
            val retried = outcome.response.second!!.getJSONObject("receipt")
            assertEquals(event.getString("id"), first.getString("id"))
            assertEquals(first.getString("id"), retried.getString("id"))
            assertFalse(first.getBoolean("duplicate"))
            assertTrue(retried.getBoolean("duplicate"))
            assertEquals(0, queue.pendingSync().count)
            assertNull(queue.peek())
            assertEquals(1, store.rows.size)
            assertEquals(listOf("unknown", "received"), store.attempts.map { it.state })
        } finally { directory.deleteRecursively() }
    }
}
