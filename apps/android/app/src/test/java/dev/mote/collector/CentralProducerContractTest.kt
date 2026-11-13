package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import dev.mote.collector.plugins.WorkspaceDecode
import dev.mote.collector.plugins.WorkspaceTemplate
import java.io.File
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

    @Test fun persistentCardsFeedTheNativeNotificationReaderWithoutLosingSuppressedCards() {
        val id = System.getenv("MOTE_KOTLIN_CONTRACT_NOTIFICATION").orEmpty()
        val evidence = System.getenv("MOTE_KOTLIN_CONTRACT_NOTIFICATION_EVIDENCE").orEmpty()
        val plain = System.getenv("MOTE_KOTLIN_CONTRACT_PLAIN_CARD").orEmpty()
        val api = client(); val reader = AssistantNotificationReader(api)
        val snapshot = reader.snapshot(); val event = AssistantNotice.snapshot(snapshot).single()
        assertEquals(id, event.id); assertEquals(2L, event.revision)
        assertEquals("Generated current notification result v2", reader.card(id).body)
        assertTrue(reader.page().items.any { it.id == plain && it.readAt == null })
        var cursor: AssistantNoticeCursor? = null; var posts = 0; var visible = false
        fun presenter() = AssistantNoticePresenter({ cursor }, { cursor = it }, { posts++; visible = true }, { visible = false })
        val denied = presenter(); denied.update(origin, snapshot, false)
        assertEquals(0, posts); assertNull(cursor); assertNull(reader.card(id).readAt)
        denied.update(origin, snapshot, true); denied.update(origin, reader.snapshot(), true)
        assertEquals(1, posts); denied.clear()
        val reconnected = presenter(); reconnected.update(origin, reader.snapshot(), true)
        assertEquals(1, posts); assertFalse(visible)
        assertNotNull(reader.card(id, true).readAt)
        assertTrue(AssistantNotice.snapshot(reader.snapshot()).isEmpty())
        assertTrue("Showing or reading one result never removes another useful card", reader.page().items.any { it.id == plain })
        api.delete("/api/captures/$evidence")
        reconnected.update(origin, reader.snapshot(), true); assertFalse(visible)
        val missing = assertThrows(CentralFailure::class.java) { reader.card(id) }
        assertEquals(404, missing.status)
    }



    @Test fun realAssistantProjectionsSupportBothWorkAndLifeFeedbackTasksAndWithdrawal() {
        val fixture = JSONObject(java.io.File(requireNotNull(System.getenv("MOTE_KOTLIN_CONTRACT_ASSISTANT"))).readText()).getJSONArray("items")
        assertEquals(2, fixture.length())
        for (index in 0 until fixture.length()) {
            val generated = fixture.getJSONObject(index)
            val scope = AssistantScope(generated.getJSONObject("scope"))
            val api = CentralAssistant(client(), scope)
            val disk = CentralStateFile(folder.newFolder(), "generated-assistant", object : ByteCipher {
                override fun seal(bytes: ByteArray) = bytes
                override fun open(bytes: ByteArray) = bytes
            })
            val model = AssistantFeedViewModel(api, disk::read, disk::write)
            model.refresh(); assertNull(model.error)
            val card = model.cards.single()
            assertEquals(generated.getString("cardId"), card.id)
            assertEquals("two", card.version); assertTrue(card.body.contains(generated.getString("kind")))
            assertEquals(generated.getString("evidenceId"), card.evidence.single().id)
            assertEquals(generated.getString("taskId"), card.acceptedTaskId)
            assertEquals(card.acceptedTaskId, model.tasks[card.id]!!.id)
            // Pending/blocked work is whatever Central reports; accepting a
            // suggestion did not manufacture a completed result on the phone.
            assertEquals(api.task(card.acceptedTaskId!!).state, model.tasks[card.id]!!.state)
            model.feedback(card.id, card.revision, "later"); assertNull(model.error)
            val later = model.cards.single(); assertEquals("later", later.feedback.last())
            model.feedback(card.id, later.revision, "ignore"); assertNull(model.error)
            assertEquals("ignore", model.cards.single().feedback.last())
            assertEquals(card.evidence, model.cards.single().evidence)
            assertEquals(2, model.history(card.id).getJSONArray("items").length())

            val matter = AssistantMatterDetail.read(generated.getJSONObject("matter"))
            assertEquals(card.matterId, matter.id); assertEquals(card.acceptedTaskId, matter.tasks.single().first)
            assertEquals(listOf(generated.getString("evidenceId")), matter.evidence.map { it.first })
            val commitment = AssistantCommitment.read(generated.getJSONObject("commitment"))
            assertEquals("confirmed", commitment.status); assertEquals("unknown", commitment.dueState)
            assertEquals(card.evidence.single().id, commitment.timeline.single().evidence.single().id)
            assertNull(commitment.timeline.single().occurredAt); assertEquals("proposal", commitment.timeline.single().origin)
            val rule = AssistantRoutine.read(generated.getJSONObject("routine"))
            assertEquals(rule.nextDue, api.routine(rule.id).nextDue)
            val paused = api.updateRoutine(rule.id, JSONObject().put("expectedRevision", rule.revision).put("enabled", false))
            assertFalse(paused.enabled); assertNull(paused.nextDue)
            assertEquals(409, assertThrows(CentralFailure::class.java) {
                api.updateRoutine(rule.id, JSONObject().put("expectedRevision", rule.revision).put("enabled", true))
            }.status)
            client().delete("/api/captures/" + generated.getString("evidenceId"))
            model.refresh(); assertNull(model.error); assertTrue(model.cards.isEmpty()); assertTrue(model.tasks.isEmpty())
            assertEquals(404, assertThrows(CentralFailure::class.java) { api.card(card.id) }.status)
        }
    }
    @Test fun everyRealWorkbenchTemplateOutputDecodesThroughTheProductionKotlinDecoder() {
        val path = System.getenv("MOTE_KOTLIN_CONTRACT_WORKBENCH").orEmpty()
        assertTrue("The contract runner must provide real workbench responses", path.isNotEmpty())
        val views = JSONArray(File(path).readText()).let { array ->
            assertEquals(4, array.length())
            (0 until array.length()).map { WorkspaceDecode.read(array.getJSONObject(it)) }
        }
        assertEquals(
            listOf(WorkspaceTemplate.PROJECT, WorkspaceTemplate.PERSON, WorkspaceTemplate.TRAVEL, WorkspaceTemplate.READING),
            views.map { it.request.template },
        )
        views.forEach { view ->
            assertEquals("declarative-view", view.descriptor.kind)
            assertTrue(view.descriptor.platforms.contains("android"))
            assertEquals(listOf("refresh"), view.commands.map { it.id })
            assertTrue(view.spec.components.isNotEmpty())
        }
    }


    @Test fun safReferenceManifestProducesTheSharedFileViewConsumedByKotlin() {
        val api = client(collector); val source = LocalSource(id = "generated-saf-" + UUID.randomUUID(), name = "Generated SAF", kind = "local-files",
            retention = "reference", uri = "content://generated/tree/root", tree = true, extensions = "txt")
        api.post("/api/sources", source.registration(device))
        val queue = FileArchiveQueue(folder.newFolder(), object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes })
        val doc = SafDocument("doc", "content://generated/tree/root/document/doc", "generated.txt", "text/plain", 7, time, false)
        queue.observe(source, doc.item(source, doc.uri), queue.configure(source).getString("generation"))
        val row = queue.prepare(source, { error("Reference must never open a provider stream") }, { error("Reference must not read bytes") })!!
        val manifest = row.getJSONObject("pending").getJSONObject("manifest")
        val ack = api.put("/api/file-sync/v1/revisions", manifest)
        queue.acknowledge(source.id, row, ack)
        val view = CentralFileView.read(client().get("/api/files/" + ack.getString("id") + "/view"))
        assertEquals(source.id, view.sourceId); assertEquals(doc.uri, view.externalId)
        assertEquals("reference", view.retention); assertFalse(view.hasOriginal); assertFalse(view.canOpenOriginal)
        assertEquals("unsupported", view.extraction.status); assertFalse(view.bodyAvailable)
        assertEquals(0, queue.pendingCount(source.id))
    }

    @Test fun newAuthorizedOriginConsumesImmediateReuseReceiptWithoutSendingBytes() {
        val bytes = ("Generated Kotlin reuse " + UUID.randomUUID()).toByteArray()
        val original = file(bytes); val api = client(collector)
        val first = upload(api, original, UUID.randomUUID().toString())
        val parts = exchanges.count { it.path.contains("/parts/") }
        val commits = exchanges.count { it.path.endsWith("/commit") }
        assertEquals(1, parts); assertEquals(1, commits)

        val second = upload(api, original, UUID.randomUUID().toString())
        assertNotEquals(first, second)
        val reuse = begins().last().response!!.getJSONObject("ack")
        assertFalse(reuse.getBoolean("duplicate"))
        assertEquals(second, reuse.getString("id"))
        assertEquals("received", reuse.getJSONObject("receipt").getString("state"))
        assertEquals(parts, exchanges.count { it.path.contains("/parts/") })
        assertEquals(commits, exchanges.count { it.path.endsWith("/commit") })
        val downloaded = java.io.ByteArrayOutputStream()
        client().download("/api/files/$second/content", downloaded, bytes.size.toLong())
        assertArrayEquals(bytes, downloaded.toByteArray())
    }

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

    @Test fun realPartialAndLostFinalAcksResumeExactRevisionWithoutResendingConfirmedParts() {        val bytes = ByteArray(4 * 1024 * 1024 + 157) { (it % 251).toByte() }
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
        val view = CentralFileView.read(client().get("/api/files/$id/view"))
        assertEquals(id, view.captureId); assertTrue(view.hasOriginal); assertTrue(view.canOpenOriginal)
        assertEquals("pending", view.extraction.status); assertFalse(view.bodyAvailable)
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
