package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.CentralStateFile
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.UUID

/** Run by test-fixtures/ask-query.ts against private generated Central data.
 * Central performs the real query admission, run and conversation writes; the
 * JDK replaces only Android's missing HTTP boundary. */
class NativeAskQueryContractTest {
    private val origin = System.getenv("MOTE_ASK_QUERY_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_ASK_QUERY_TOKEN").orEmpty()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 41).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    @Before fun requireRealIngress() {
        assumeTrue("Use the Ask query ingress runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty())
    }

    private fun http(method: String, path: String, body: JSONObject? = null, authenticated: Boolean = true): Pair<Int, JSONObject?> {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            if (authenticated) connection.setRequestProperty("Authorization", "Bearer $owner")
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

    private fun started(directory: java.io.File): Pair<NativePluginHost, NativeAskController> {
        val registry = NativePluginRegistry().apply { NativeAskPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.ask", "generated-installation", NativeAskPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeAskPlugin.CAPABILITY), requires = listOf(NativeAskPlugin.requirement()))) as PluginResult.Ok).value
        val storage = NativeAskDraftStorage(CentralStateFile(directory, "ask", cipher))
        return host to NativeAskPlugin.open(scope, storage).controller(directory)
    }

    @Test fun realAdmissionRunAndConversationReachTheAskControllerWithoutASecondSubmit() {
        val directory = Files.createTempDirectory("mote-ask-query-").toFile()
        var released = false
        try {
            val (_, controller) = started(directory)
            controller.readDraft()
            val request = requireNotNull(controller.admission("Generated real native ask question", "UTC"))
            controller.persistNow()

            val accepted = http("POST", "/api/query-runs", request)
            assertEquals(202, accepted.first)
            val acceptedRun = requireNotNull(accepted.second)
            controller.receive(acceptedRun, request.getString("id"), request)
            assertEquals("running", controller.state.getString("runStatus"))

            val listed = http("GET", "/api/query-runs")
            assertEquals(200, listed.first)
            val runs = requireNotNull(listed.second).getJSONArray("items")
            assertEquals(1, runs.length())
            val recreated = NativeAskController(
                NativeAskDraftStorage(CentralStateFile(directory, "ask", cipher)),
            )
            val restored = recreated.restore(runs)
            assertEquals(request.getString("id"), restored.getString("runId"))
            assertEquals("running", restored.getString("runStatus"))
            assertFalse(restored.has("pending"))
            assertNull("the recreated Activity never submits a running ticket again", recreated.admission("Generated later question", "UTC"))

            assertEquals(200, http("POST", "/__fixture/release-query", JSONObject(), authenticated = false).first)
            released = true
            var run = acceptedRun
            val deadline = System.currentTimeMillis() + 30_000
            while (run.getString("status") == "running" && System.currentTimeMillis() < deadline) {
                Thread.sleep(50)
                val read = http("GET", "/api/query-runs/" + request.getString("id"))
                assertEquals(200, read.first)
                run = requireNotNull(read.second)
            }
            assertEquals("completed", run.getString("status"))
            val update = recreated.receive(run, request.getString("id"))
            assertTrue(update.clearDraft)
            assertEquals("completed", update.status)
            assertEquals("", recreated.state.getString("question"))
            assertEquals(0, recreated.state.optJSONArray("attachments")?.length() ?: 0)
            val conversationId = requireNotNull(update.conversationId)

            val conversation = http("GET", "/api/conversations/$conversationId")
            assertEquals(200, conversation.first)
            val turns = requireNotNull(conversation.second).getJSONArray("turns")
            assertEquals(1, turns.length())
            val turn = turns.getJSONObject(0)
            val presentation = recreated.readTurn(turn)
            assertNotNull(presentation.result)
            assertEquals("Generated real native ask answer", presentation.result!!.getString("answer"))
            assertEquals("Generated real native ask answer", recreated.formatAnswer(presentation.result!!.getString("answer"), emptyList()).text)
            assertEquals(1, http("GET", "/api/query-runs").second!!.getJSONArray("items").length())
        } finally {
            if (!released) runCatching { http("POST", "/__fixture/release-query", JSONObject(), authenticated = false) }
            directory.deleteRecursively()
        }
    }
}
