package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.CentralConversationMessage
import dev.mote.collector.CentralConversationSettings
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
 * Central performs the real queue admission, accepted message updates,
 * conversation paging and settings writes; the JDK replaces only Android's
 * missing HTTP boundary. */
class NativeAskQueryContractTest {
    private val origin = System.getenv("MOTE_ASK_QUERY_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_ASK_QUERY_TOKEN").orEmpty()
    private val evidenceId = System.getenv("MOTE_ASK_QUERY_EVIDENCE").orEmpty()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 41).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }

    @Before fun requireRealIngress() {
        assumeTrue("Use the Ask query ingress runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty() && evidenceId.isNotEmpty())
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

    @Test fun realQueueAdmissionRetryPagingAndSettingsReachTheAskController() {
        val directory = Files.createTempDirectory("mote-ask-query-").toFile()
        var released = false
        try {
            val (_, controller) = started(directory)
            controller.restore()
            val main = http("GET", "/api/conversations/main")
            assertEquals(200, main.first)
            val conversationId = requireNotNull(main.second).getString("id")
            controller.attachConversation(conversationId)
            assertTrue(controller.selectEvidence(evidenceId, label = "Generated evidence scope"))
            val request = requireNotNull(controller.admission("Generated real native ask question", "UTC"))
            assertEquals(conversationId, request.getString("conversationId"))
            assertEquals("all", request.getJSONObject("scope").getString("kind"))
            assertEquals(evidenceId, request.getJSONArray("anchorEvidenceIds").getString(0))
            controller.persistNow()

            val recreated = started(directory).second
            val restored = recreated.restore()
            assertEquals(request.getString("clientRequestId"), restored.getJSONObject("pending").getString("clientRequestId"))
            assertEquals("the recreated Activity keeps the exact retry identity",
                request.toString(), requireNotNull(recreated.admission("Generated edited question", "UTC")).toString())

            val accepted = http("POST", "/api/conversations/messages", request)
            assertEquals(202, accepted.first)
            val message = requireNotNull(accepted.second)
            val receipt = CentralConversationMessage.read(message)
            assertEquals(request.getString("clientRequestId"), receipt.clientRequestId)
            assertEquals(conversationId, receipt.conversationId)
            assertTrue(receipt.status in CentralConversationMessage.statuses)
            assertEquals(evidenceId, message.getJSONArray("anchorEvidenceIds").getString(0))

            recreated.receive(message, request)
            assertEquals(receipt.id, recreated.messageId())
            assertFalse(recreated.state.has("pending"))
            assertEquals(receipt.status, recreated.status())
            assertNull("an accepted message is never submitted twice", recreated.admission("Generated later question", "UTC"))

            val replay = http("POST", "/api/conversations/messages", request)
            assertEquals(202, replay.first)
            assertEquals("a lost response retries the same message", receipt.id, requireNotNull(replay.second).getString("id"))

            val restoredAgain = started(directory).second
            restoredAgain.restore()
            assertEquals(receipt.id, restoredAgain.messageId())
            assertNull("process recreation never resubmits an accepted message", restoredAgain.admission("Generated later question", "UTC"))

            assertEquals(200, http("POST", "/__fixture/release-query", JSONObject(), authenticated = false).first)
            released = true
            var current = message
            val deadline = System.currentTimeMillis() + 30_000
            while (current.getString("status") !in setOf("completed", "failed", "cancelled") && System.currentTimeMillis() < deadline) {
                Thread.sleep(50)
                val read = http("GET", "/api/conversations/$conversationId/messages/${receipt.id}")
                assertEquals(200, read.first)
                current = requireNotNull(read.second)
            }
            assertEquals("completed", current.getString("status"))
            val update = restoredAgain.receive(current)
            assertTrue(update.clearDraft)
            assertEquals(receipt.id, update.messageId)

            val page = http("GET", "/api/conversations/$conversationId")
            assertEquals(200, page.first)
            val turn = (0 until requireNotNull(page.second).getJSONArray("turns").length())
                .map { page.second!!.getJSONArray("turns").getJSONObject(it) }
                .single { it.getString("id") == receipt.id }
            val presentation = restoredAgain.readTurn(turn)
            assertEquals("completed", presentation.status)
            assertNotNull(presentation.result)
            assertEquals("Generated real native ask answer", presentation.result!!.getString("answer"))

            val configuration = http("GET", "/api/configuration")
            assertEquals(200, configuration.first)
            val preferences = CentralConversationSettings.read(requireNotNull(configuration.second))
            assertFalse(preferences.multipleConversations)
            assertEquals(0.5, preferences.context.historyRatio, 0.0)
            assertEquals("conservative", preferences.context.contextWindowSource)

            val enabled = http("PUT", "/api/configuration/conversations",
                CentralConversationSettings.payload(preferences, true, 0.25, 0.4, "configured", 16000))
            assertEquals(200, enabled.first)
            val updated = CentralConversationSettings.read(requireNotNull(enabled.second))
            assertTrue(updated.multipleConversations)
            assertEquals(ConversationPreferencesForTest(0.25, 0.4, 16000, "configured"), ConversationPreferencesForTest(updated))
            val reset = http("PUT", "/api/configuration/conversations",
                CentralConversationSettings.payload(updated, false, 0.5, 0.5, "conservative", null))
            assertEquals(200, reset.first)
            assertFalse(CentralConversationSettings.read(requireNotNull(reset.second)).multipleConversations)
        } finally {
            if (!released) runCatching { http("POST", "/__fixture/release-query", JSONObject(), authenticated = false) }
            directory.deleteRecursively()
        }
    }

    private data class ConversationPreferencesForTest(
        val historyRatio: Double,
        val lowWatermarkRatio: Double,
        val contextWindow: Long?,
        val contextWindowSource: String,
    ) {
        constructor(value: dev.mote.collector.ConversationPreferences) : this(
            value.context.historyRatio, value.context.lowWatermarkRatio, value.context.contextWindow, value.context.contextWindowSource)
    }
}
