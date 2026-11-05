package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

/** Run by test-fixtures/central-kotlin-contract.ts against its private real Central. */
class CentralProducerContractTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = System.getenv("MOTE_KOTLIN_CONTRACT_ORIGIN").orEmpty()
    private val owner = System.getenv("MOTE_KOTLIN_CONTRACT_TOKEN").orEmpty()
    private val collector = System.getenv("MOTE_KOTLIN_CONTRACT_COLLECTOR").orEmpty()
    private val device = "generated-kotlin-phone"
    private val time = 1790848800000L
    private data class Exchange(val method: String, val path: String, val request: JSONObject?, val status: Int, val response: JSONObject?)
    private val exchanges = mutableListOf<Exchange>()

    @Before fun requireRealProducer() {
        // The dedicated runner makes absent/skipped cases a failure. Other JVM
        // unit selections do not implicitly launch Node or require npm inputs.
        assumeTrue("Use the Central Kotlin contract runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(owner.isNotEmpty() && collector.isNotEmpty())
    }

    /** JDK adapter replaces only Android's clock/meter/OS transport boundary;
     * response bytes are decoded unchanged and consumed by production classes. */
    private fun http(method: String, url: String, body: ByteArray?, credential: String, mime: String, ingress: Boolean = true): Pair<Int, JSONObject?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $credential")
            if (ingress && IngressV2Protocol.uploadWrite(method, url)) connection.setRequestProperty(IngressV2Protocol.HEADER, IngressV2Protocol.VERSION)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", mime)
                // JDK fixed-length streaming hides 401 bodies behind its HTTP
                // authentication retry handling. Buffer these generated bodies.
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            val response = text?.takeIf { it.isNotBlank() }?.let(::JSONObject)
            val request = if (mime == "application/json" && body != null) JSONObject(String(body, Charsets.UTF_8)) else null
            exchanges += Exchange(method, URL(url).path, request, status, response)
            return status to response
        } finally { connection.disconnect() }
    }
    private fun client(token: String = owner, unauthorized: () -> Unit = {}) = CentralClient(origin, token,
        transport = { method, url, body, credential, mime -> http(method, url, body, credential, mime) }, unauthorized = unauthorized)
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun file(bytes: ByteArray = "Generated original body; no personal data.\n".toByteArray()) = folder.newFile().apply { writeBytes(bytes) }
    private fun upload(client: CentralClient, file: java.io.File, scope: String, deviceId: String = device, progress: (Int, Int) -> Unit = { _, _ -> }) =
        CentralAttachments.upload(client, file, "Generated original.txt", "text/plain", deviceId, { time }, identityScope = scope, progress = progress)
    private fun begins() = exchanges.filter { it.path == "/api/file-sync/v1/uploads" }

    @Test fun deviceContactProjectionKeepsReportedDeviceRowsReadableByCentralClient() {
        val result = client().get("/api/devices")
        val devices = result.getJSONArray("items")
        val device = (0 until devices.length()).map { devices.getJSONObject(it) }
            .single { it.getString("deviceId") == "generated-contact-contract" }
        assertEquals("capturing", device.getString("status"))
        assertEquals("interval", device.getJSONObject("sync").getString("mode"))
        assertFalse("Contact loss is a Central projection, not a reported device field", device.has("disconnected"))
        val lost = result.getJSONArray("disconnectedDeviceIds")
        assertTrue((0 until lost.length()).any { lost.getString(it) == "generated-contact-contract" })
        val denied = assertThrows(CentralFailure::class.java) { client(collector).get("/api/devices") }
        assertEquals(403, denied.status)
    }

    @Test fun realPartialAndLostFinalAcksResumeExactRevisionWithoutResendingConfirmedParts() {
        val bytes = ByteArray(4 * 1024 * 1024 + 157) { (it % 251).toByte() }
        val original = file(bytes); val scope = UUID.randomUUID().toString()
        var losePart = true; var loseCommit = true
        val api = CentralClient(origin, collector, transport = { method, url, body, credential, mime ->
            val result = http(method, url, body, credential, mime)
            if (result.first in 200..299 && url.endsWith("/parts/0") && losePart) {
                losePart = false; throw IOException("Generated loss after Central stored part zero")
            }
            if (result.first in 200..299 && url.endsWith("/commit") && loseCommit) {
                loseCommit = false; throw IOException("Generated loss after Central committed the original")
            }
            result
        })
        assertThrows(IOException::class.java) { upload(api, original, scope) }
        val progress = mutableListOf<Pair<Int, Int>>()
        assertThrows(IOException::class.java) { upload(api, original, scope, progress = { part, total -> progress += part to total }) }
        val committed = exchanges.single { it.path.endsWith("/commit") }.response!!
        val id = upload(api, original, scope)
        assertEquals(committed.getString("id"), id)
        assertEquals(id, UUID.fromString(id).toString())
        assertEquals(listOf(1 to 2, 2 to 2), progress)
        assertEquals(1, exchanges.count { it.path.endsWith("/parts/0") })
        assertEquals(1, exchanges.count { it.path.endsWith("/parts/1") })
        assertEquals(1, exchanges.count { it.path.endsWith("/commit") })
        assertEquals(3, begins().size)
        val manifest = begins().first().request!!
        begins().forEach { assertEquals("Retry preserves the whole manifest", manifest.toString(), it.request!!.toString()) }
        assertEquals(hash(bytes), manifest.getJSONObject("item").getString("revision"))
        assertEquals(time, java.time.Instant.parse(manifest.getJSONObject("item").getString("observedAt")).toEpochMilli())
        val initial = begins()[0].response!!; val resumed = begins()[1].response!!
        assertEquals(initial.getString("uploadId"), resumed.getString("uploadId"))
        assertEquals(0, initial.getJSONArray("parts").length())
        assertEquals(1, resumed.getJSONArray("parts").length())
        val duplicate = begins()[2].response!!.getJSONObject("ack")
        assertTrue(duplicate.getJSONObject("receipt").getBoolean("duplicate"))
        assertEquals(id, FileUploadConfirmation.canonicalId(manifest.getString("sourceId"), manifest, duplicate))
        val detail = client().get("/api/files/$id")
        assertTrue(detail.getBoolean("hasOriginal"))
        assertEquals(hash(bytes), detail.getJSONObject("item").getString("revision"))
        assertEquals(manifest.getJSONObject("item").getString("externalId"), detail.getJSONObject("item").getString("externalId"))
        val downloaded = java.io.ByteArrayOutputStream()
        client().download("/api/files/$id/content", downloaded, bytes.size.toLong())
        assertArrayEquals(bytes, downloaded.toByteArray())
        val head = api.get("/api/file-sync/v1/head?sourceId=notes-$device&externalId=" + java.net.URLEncoder.encode(manifest.getJSONObject("item").getString("externalId"), "UTF-8"))
        assertEquals(hash(bytes), head.getString("revision")); assertFalse(head.getBoolean("forgotten"))
    }

    @Test fun realPermissionErrorsAreTypedAndOnlyUnauthorizedClearsTheSession() {
        var signedOut = 0
        val limited = client(collector) { signedOut++ }
        val forbidden = assertThrows(CentralFailure::class.java) { upload(limited, file(), UUID.randomUUID().toString(), "generated-other-device") }
        assertEquals(403, forbidden.status); assertEquals("connection_scope_denied", forbidden.code)
        assertEquals(0, signedOut); assertTrue(begins().isEmpty())
        val denied = assertThrows(CentralFailure::class.java) { limited.get("/api/files") }
        assertEquals(403, denied.status); assertEquals("connection_scope_denied", denied.code)
        assertEquals(0, signedOut)
        val invalid = client("generated-invalid-credential") { signedOut++ }
        val unauthorized = assertThrows(CentralFailure::class.java) { upload(invalid, file(), UUID.randomUUID().toString()) }
        assertEquals(401, unauthorized.status); assertEquals("unauthorized", unauthorized.code)
        assertEquals(1, signedOut)
        assertEquals(MoteI18n.text("访问凭据已失效，请重新连接。"), unauthorized.message)
    }

    @Test fun missingCurrentIngressCapabilityFailsBeforePartsOrFallback() {
        var signedOut = 0
        val outdated = CentralClient(origin, collector, transport = { method, url, body, credential, mime -> http(method, url, body, credential, mime, ingress = false) }, unauthorized = { signedOut++ })
        val failure = assertThrows(CentralFailure::class.java) { upload(outdated, file(), UUID.randomUUID().toString()) }
        assertEquals(426, failure.status); assertEquals("ingress_protocol_upgrade_required", failure.code)
        assertEquals(listOf("/api/sources", "/api/file-sync/v1/uploads"), exchanges.map { it.path })
        assertEquals(426, begins().single().status)
        assertEquals("2", begins().single().response!!.getString("requiredVersion"))
        assertEquals(0, signedOut)
    }

    @Test fun forgottenOriginalCannotBeConfirmedOrRecreatedBySameIdentityRetry() {
        val original = file(); val scope = UUID.randomUUID().toString(); val api = client()
        val id = upload(api, original, scope)
        api.delete("/api/files/$id")
        val writes = exchanges.count { it.path.contains("/parts/") || it.path.endsWith("/commit") }
        val gone = assertThrows(CentralFailure::class.java) { upload(api, original, scope) }
        assertEquals(410, gone.status)
        assertEquals(writes, exchanges.count { it.path.contains("/parts/") || it.path.endsWith("/commit") })
        val unavailable = assertThrows(CentralFailure::class.java) { api.get("/api/files/$id") }
        assertEquals(404, unavailable.status)
        assertArrayEquals("Generated original body; no personal data.\n".toByteArray(), original.readBytes())
    }

    @Test fun lateSuccessfulBeginAfterSessionInvalidationCannotStartPartOrCommit() {
        var active = true
        val api = CentralClient(origin, collector, transport = { method, url, body, credential, mime ->
            http(method, url, body, credential, mime).also { if (url.endsWith("/api/file-sync/v1/uploads")) active = false }
        }, active = { active })
        val failure = assertThrows(IllegalStateException::class.java) { upload(api, file(), UUID.randomUUID().toString()) }
        assertEquals(MoteI18n.text("登录会话已变更，请重新打开中央页面。"), failure.message)
        assertEquals(200, begins().single().status)
        assertEquals(0, exchanges.count { it.path.contains("/parts/") || it.path.endsWith("/commit") })
    }

    @Test fun ordinaryDeletionKeepsTheRealSavedAnswerButDeniesItsHistoricalReference() {
        val conversationId = System.getenv("MOTE_KOTLIN_CONTRACT_CONVERSATION").orEmpty()
        val evidenceId = System.getenv("MOTE_KOTLIN_CONTRACT_HISTORY_EVIDENCE").orEmpty()
        assertEquals(conversationId, UUID.fromString(conversationId).toString())
        assertEquals(evidenceId, UUID.fromString(evidenceId).toString())
        val api = client()
        assertTrue(CentralConversationReference.available(api, conversationId, evidenceId))
        assertFalse(CentralConversationReference.available(api, conversationId, UUID.randomUUID().toString()))
        assertThrows(CentralFailure::class.java) { CentralConversationReference.available(client(collector), conversationId, evidenceId) }
        api.delete("/api/captures/$evidenceId")
        val turn = api.get("/api/conversations/$conversationId").getJSONArray("turns").getJSONObject(0)
        val shown = CentralConversationPresentation.read(turn)
        assertEquals(MoteI18n.text("引用原文已删除，历史问答仍保留。"), shown.notice)
        assertEquals("Generated saved answer", shown.result!!.getString("answer"))
        assertEquals(evidenceId, shown.result.getJSONArray("citations").getJSONObject(0).getString("id"))
        assertFalse(CentralConversationReference.available(api, conversationId, evidenceId))
        assertEquals(404, assertThrows(CentralFailure::class.java) { api.get("/api/captures/$evidenceId") }.status)
        assertFalse(turn.optBoolean("evidenceDeleted"))
        assertEquals(evidenceId, turn.getJSONObject("scope").getJSONArray("evidenceIds").getString(0))
    }
}
