package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Looper
import android.speech.RecognizerIntent
import android.text.Spanned
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.mote.collector.plugins.CapturePlugin
import dev.mote.collector.plugins.DurableTransportPlugin
import dev.mote.collector.plugins.NativeAskPlugin
import dev.mote.collector.plugins.NotesPlugin
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.io.DataInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.time.Duration
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, sdk = [35], shadows = [
    AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class,
])
@LooperMode(LooperMode.Mode.PAUSED)
class NativeAskHostTest {
    private val app get() = RuntimeEnvironment.getApplication() as MoteApplication
    private val conversation = UUID.randomUUID().toString()
    private val turn = UUID.randomUUID().toString()
    private val evidence = UUID.randomUUID().toString()
    private val excerpt = "generated excerpt at the second line"
    private val question = "Generated question"
    private val answer = "Generated answer [$evidence]"
    private val turns = CopyOnWriteArrayList<JSONObject>()
    private val admissions = CopyOnWriteArrayList<JSONObject>()
    private val requests = CopyOnWriteArrayList<Pair<String, String>>()
    private val fixtureFailure = AtomicReference<Throwable?>()
    private val openActivities = mutableListOf<ActivityController<out Activity>>()
    private lateinit var server: ServerSocket
    private val network = Executors.newSingleThreadExecutor()
    private lateinit var origin: String
    @Volatile private var dropAdmissions = false
    @Volatile private var calendar: JSONObject? = null
    @Volatile private var tasks = JSONArray()

    @Before fun generatedCentral() {
        server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        network.execute {
            try {
                while (!server.isClosed) server.accept().use(::respond)
            } catch (error: Exception) {
                if (!server.isClosed) fixtureFailure.set(error)
            } catch (error: AssertionError) {
                fixtureFailure.set(error)
            }
        }
        origin = "http://127.0.0.1:" + server.localPort
        Settings(app).read()
    }

    @After fun closeGeneratedProfile() {
        openActivities.asReversed().forEach { it.pause().stop().destroy() }
        assertTrue(app.pluginHost.quit().isEmpty())
        server.close()
        network.shutdown()
        assertTrue(network.awaitTermination(5, TimeUnit.SECONDS))
        fixtureFailure.get()?.let { throw AssertionError("Generated chat fixture failed", it) }
    }

    private fun connect(authorized: Boolean = true) {
        val token = CredentialValue(RuntimeProfile.current, app.secretBox())
            .encode(if (authorized) "generated-chat-only-" + "a".repeat(32) else "")
        assertTrue(app.getSharedPreferences("mote", 0).edit().putString("server", origin).putString("centralEndpoint", origin)
            .putString("dataOrigin", origin).putString("token", token).putString("deviceName", "Generated phone")
            .putBoolean("debugHttp", true).putString("syncMode", "manual").commit())
    }

    private fun respond(socket: Socket) {
        socket.soTimeout = 15000
        val input = DataInputStream(socket.getInputStream().buffered())
        fun line(): String = buildString {
            while (true) {
                val byte = input.read()
                if (byte < 0 || byte == 10) break
                if (byte != 13) append(byte.toChar())
            }
        }
        val requestLine = line()
        if (requestLine.isEmpty()) return
        val (method, target) = requestLine.split(' ')
        val path = target.substringBefore('?')
        var size = 0
        while (true) {
            val header = line()
            if (header.isEmpty()) break
            if (header.substringBefore(':').equals("Content-Length", ignoreCase = true)) size = header.substringAfter(':').trim().toInt()
        }
        val incoming = ByteArray(size).also(input::readFully)
        requests += method to path
        val body = when (path) {
            "/api/conversations/main" -> JSONObject().put("id", conversation)
            "/api/conversations/messages" -> {
                assertEquals("POST", method)
                val request = JSONObject(String(incoming, Charsets.UTF_8))
                admissions += request
                if (dropAdmissions) return
                assertEquals(conversation, request.getString("conversationId"))
                val requestId = request.getString("clientRequestId")
                val existing = turns.firstOrNull { it.optString("clientRequestId") == requestId }
                val row = existing ?: message(request.getString("question"), "completed", UUID.randomUUID().toString(), requestId)
                    .also(turns::add)
                receipt(row)
            }
            "/api/conversations/$conversation" -> JSONObject().put("id", conversation).put("scope", JSONObject())
                .put("revision", 1).put("turns", JSONArray(turns))
            "/api/conversations/$conversation/messages/$turn/cancel" -> {
                assertEquals("POST", method)
                val current = turns.single()
                val cancelled = JSONObject(current.toString()).put("status", "cancelled").put("version", 2)
                turns[0] = cancelled
                receipt(cancelled)
            }
            "/api/conversations/$conversation/references/$evidence" -> JSONObject().put("id", evidence).put("available", true)
            "/api/capture-browser/$evidence" -> JSONObject().put("id", evidence).put("source", "note").put("libraryVersion", "generated-version")
                .put("deviceId", "generated-phone").put("capturedAt", "2026-11-20T08:00:00Z").put("ocrText", "Generated original\n$excerpt")
            "/api/conversations/$conversation/messages/$turn/assistant-tasks" -> JSONObject().put("items", tasks)
            "/api/conversations/$conversation/assistant-tasks" -> JSONObject().put("items", JSONArray())
            calendar?.let { "/api/actions/" + it.getString("id") } -> requireNotNull(calendar)
            else -> error("Unexpected generated request $method $path")
        }
        val bytes = body.toString().toByteArray()
        socket.getOutputStream().use {
            it.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
            it.write(bytes)
        }
    }

    private fun message(text: String, status: String, id: String = turn, request: String = UUID.randomUUID().toString()) =
        JSONObject().put("id", id).put("question", text).put("status", status).put("seq", turns.size)
            .put("version", 1).put("clientRequestId", request).put("createdAt", "2026-11-20T08:00:00Z")

    private fun receipt(row: JSONObject): JSONObject = JSONObject(row.toString()).put("conversationId", conversation)
        .put("revision", row.getInt("version"))

    private fun answerTurn(): JSONObject = message(question, "completed").put("result", JSONObject().put("answer", answer)
        .put("citations", JSONArray().put(JSONObject().put("id", evidence).put("title", "Generated source")
            .put("capturedAt", "2026-11-20T08:00:00Z").put("excerpt", excerpt))))

    private fun openChat(): CentralActivity = Robolectric.buildActivity(CentralActivity::class.java)
        .also { openActivities += it }.setup().get()

    private fun await(description: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos()
        while (!condition() && System.nanoTime() < deadline) {
            fixtureFailure.get()?.let { throw AssertionError("Generated chat fixture failed", it) }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
            Thread.sleep(10)
        }
        assertTrue("$description. Requests: $requests", condition())
    }

    private fun <T : View> tagged(activity: Activity, tag: String): T? = activity.window.decorView.findViewWithTag(tag)

    private fun views(root: View): Sequence<View> = sequence {
        yield(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) yieldAll(views(root.getChildAt(index)))
    }

    private fun input(activity: CentralActivity): EditText = requireNotNull(tagged(activity, "ask-input"))
    private fun send(activity: CentralActivity, text: String) {
        input(activity).setText(text)
        val button = requireNotNull(tagged<View>(activity, "ask-send"))
        assertTrue(button.isEnabled && button.visibility == View.VISIBLE)
        assertTrue(button.performClick())
    }

    private fun entry(activity: CentralActivity, name: String): Intent {
        requireNotNull(tagged<View>(activity, "chat-add")).performClick()
        val sheet = requireNotNull(ShadowDialog.getLatestDialog())
        val options = requireNotNull(sheet.window?.decorView?.findViewWithTag<View>("chat-entries"))
        assertEquals(listOf("chat-entry:photo", "chat-entry:image", "chat-entry:file", "chat-entry:audio"),
            views(options).mapNotNull { it.tag?.toString() }.filter { it.startsWith("chat-entry:") }.toList())
        assertTrue(requireNotNull(options.findViewWithTag<View>("chat-entry:$name")).performClick())
        val launched = requireNotNull(shadowOf(activity).nextStartedActivityForResult)
        assertEquals(CapturePlugin.CHAT_CAPTURE_RESULT, launched.requestCode)
        return launched.intent
    }

    private fun deliverResult(activity: CentralActivity, request: Int, data: Intent) {
        ReflectionHelpers.callInstanceMethod<Unit>(activity, "onActivityResult",
            ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType!!, request),
            ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType!!, Activity.RESULT_OK),
            ReflectionHelpers.ClassParameter.from(Intent::class.java, data))
    }

    private fun saveGeneratedCapture(name: String, mime: String, bytes: ByteArray): String {
        startCaptureQueue()
        val notes = NotesPlugin.owner(app).view()
        return try {
            val media = notes.stage(bytes, name, mime)
            val id = notes.submit("", JSONArray().put(media), JSONObject().put("kind", "manual"), "", null, false)
            assertEquals("note", app.queue().capture(id)?.getString("source"))
            assertEquals(media.getString("id"), app.recordDraftStore().record(id)?.getJSONArray("attachments")?.getJSONObject(0)?.getString("id"))
            id
        } finally { notes.close() }
    }

    private fun startCaptureQueue() {
        // Initialize the pointer with JVM directory fsync. Robolectric cannot
        // open directory descriptors through Android's libcore shadow.
        QueueLocationStore(app.noBackupFilesDir, File(app.noBackupFilesDir, "queue"), app.localContentCipher()).current()
        DurableTransportPlugin.start(app, app.pluginHost)
    }

    @Test fun photoEntryReusesTheCaptureQueueAndShowsTheSavedThumbnail() {
        connect()
        val activity = openChat()
        await("Main chat is mounted") { tagged<View>(activity, "chat-add") != null && !activity.isWorking }
        val launch = entry(activity, "photo")
        assertEquals(RecordEditorActivity::class.java.name, launch.component?.className)
        assertEquals(TabFrame.startMedia(MoteQuickEntry.PHOTO), launch.getStringExtra("startMedia"))
        val png = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwqT+CFTEMLQkAfeRdwTkDJncAAAAASUVORK5CYII=")
        val id = saveGeneratedCapture("generated-photo.png", "image/png", png)
        deliverResult(activity, CapturePlugin.CHAT_CAPTURE_RESULT, Intent().putExtra("recordId", id))
        await("Saved photo thumbnail with its receipt") { tagged<ImageView>(activity, "chat-photo:$id")?.drawable != null }
        assertNotNull(tagged<View>(activity, "chat-capture:$id"))
        assertTrue(admissions.isEmpty())
    }

    @Test fun longRecordingUsesTheHomeAutostartModeAndSavesOneMaterialRow() {
        connect()
        val activity = openChat()
        await("Main chat is mounted") { tagged<View>(activity, "chat-add") != null && !activity.isWorking }
        val launch = entry(activity, "audio")
        assertEquals(MicrophoneRecordEditorActivity::class.java.name, launch.component?.className)
        assertEquals("audio", launch.getStringExtra("startMedia"))
        assertEquals(TabFrame.startMedia(MoteQuickEntry.AUDIO), launch.getStringExtra("startMedia"))
        val id = saveGeneratedCapture("generated-long.m4a", "audio/mp4", byteArrayOf(10, 20, 30))
        val result = Intent().putExtra("recordId", id)
        repeat(2) {
            deliverResult(activity, CapturePlugin.CHAT_CAPTURE_RESULT, result)
            await("Saved recording row") { tagged<View>(activity, "chat-capture:$id") != null && !activity.isWorking }
        }
        assertEquals(1, views(activity.window.decorView).count { it.tag == "chat-capture:$id" })
        assertNull(tagged<ImageView>(activity, "chat-photo:$id"))
        assertTrue(admissions.isEmpty())
    }

    @Test fun progressRowCancelsItsOwnTurnThroughTheExistingCommand() {
        connect()
        turns += message(question, "running")
        val activity = openChat()
        await("The progress row offers cancellation") { tagged<View>(activity, "chat-cancel:$turn") != null && !activity.isWorking }
        assertTrue(requireNotNull(tagged<View>(activity, "chat-cancel:$turn")).performClick())
        await("The cancelled turn has no cancel action") {
            tagged<View>(activity, "ask-turn-status:$turn") != null && tagged<View>(activity, "chat-cancel:$turn") == null
        }
        assertEquals(1, requests.count { it == ("POST" to "/api/conversations/$conversation/messages/$turn/cancel") })
        assertEquals("cancelled", turns.single().getString("status"))
    }

    @Test fun lostNetworkAdmissionPersistsAndRetriesTheIdenticalRequest() {
        connect()
        val activity = openChat()
        await("The authorized main composer is ready") { tagged<View>(activity, "ask-input") != null && !activity.isWorking }
        dropAdmissions = true
        send(activity, "Generated offline message")
        await("The failed transport leaves a queued chat message") { admissions.isNotEmpty() && tagged<View>(activity, "chat-pending") != null }
        val stored = NativeAskPlugin.owner(app).controller(File(app.noBackupFilesDir, "central-native/" + SourceRules.hash(origin)))
            .readDraft().getJSONObject("pending")
        assertEquals(admissions.first().toString(), stored.toString())
        dropAdmissions = false
        await("The same request lands in the main thread") {
            turns.size == 1 && tagged<View>(activity, "chat-pending") == null && !activity.isWorking
        }
        assertTrue(admissions.size >= 2)
        assertTrue(admissions.all { it.toString() == stored.toString() })
        assertEquals("Generated offline message", turns.single().getString("question"))
    }

    @Test fun numberedCitationOpensTheExactOriginalAndItsExcerpt() {
        connect()
        turns += answerTurn()
        val activity = openChat()
        await("The cited answer is rendered") { tagged<TextView>(activity, "ask-answer:$turn") != null && !activity.isWorking }
        val displayed = requireNotNull(tagged<TextView>(activity, "ask-answer:$turn")).text as Spanned
        assertEquals(1, displayed.getSpans(0, displayed.length, CitationChipSpan::class.java).size)
        val citation = views(activity.window.decorView).single { it.isClickable && it.contentDescription?.endsWith("Generated source") == true }
        assertTrue(citation.performClick())
        await("The authorized original is opened at its citation") { shadowOf(activity).peekNextStartedActivity() != null }
        val reader = shadowOf(activity).nextStartedActivity
        assertEquals(CaptureRecordsActivity::class.java.name, reader.component?.className)
        assertEquals(evidence, reader.getStringExtra("recordId"))
        assertEquals(conversation, reader.getStringExtra("conversationReference"))
        assertEquals(excerpt, reader.getStringExtra("citationExcerpt"))
        assertEquals(19 until 19 + excerpt.length, ConversationCitationPresentation.locate("Generated original\n$excerpt", excerpt))
    }

    @Test fun saveAsRecordOpensTheNamedPanelAndStoresQuoteSeparatelyFromSupplement() {
        connect()
        turns += answerTurn()
        startCaptureQueue()
        val activity = openChat()
        await("The cited answer is rendered") { tagged<View>(activity, "ask-answer:$turn") != null && !activity.isWorking }
        val save = views(activity.window.decorView).single { it.contentDescription == MoteI18n.text("保存为记录") }
        assertTrue(save.performClick())
        val launch = requireNotNull(shadowOf(activity).nextStartedActivity)
        assertEquals(AnswerRecordActivity::class.java.name, launch.component?.className)
        val editor = Robolectric.buildActivity(AnswerRecordActivity::class.java, launch).also { openActivities += it }.setup().get()
        assertEquals(save.contentDescription, tagged<TextView>(editor, "share-title")?.text)
        assertTrue(tagged<TextView>(editor, "record-origin-fulltext")?.text?.contains("[1]") == true)
        val supplement = requireNotNull(tagged<EditText>(editor, "share-note"))
        assertTrue(supplement.text.isEmpty())
        supplement.setText("Generated owner addition")
        val submit = requireNotNull(tagged<View>(editor, "share-save"))
        assertTrue(submit.isEnabled && submit.performClick())
        await("Editor saves the record") { shadowOf(editor).resultCode == Activity.RESULT_OK }
        val id = requireNotNull(shadowOf(editor).resultIntent.getStringExtra("recordId"))
        val saved = requireNotNull(app.queue().capture(id))
        val source = saved.getJSONObject("metadata").getJSONObject("noteOrigin")
        assertEquals("Generated owner addition", saved.getString("ocrText"))
        assertEquals(question + "\n\n" + answer, source.getString("text"))
        assertEquals(conversation, source.getString("conversationId"))
        assertEquals(turn, source.getJSONArray("messageIds").getString(0))
    }

    @Test fun disconnectedHostOffersOnlyConnectionAndDurablySendsLocalTextAfterAuthorization() {
        val first = openChat()
        await("Disconnected chat mounts the local input") { tagged<View>(first, "chat-connect") != null && !first.isWorking }
        val body = requireNotNull(tagged<LinearLayout>(first, "central-body"))
        assertEquals(listOf("chat-connect-title", "chat-connect"), (0 until body.childCount).map { body.getChildAt(it).tag })
        assertTrue(requireNotNull(tagged<View>(first, "chat-connect")).performClick())
        assertEquals("CONNECTION", shadowOf(first).nextStartedActivity.getStringExtra("page"))
        send(first, "Generated text kept on the phone")
        await("The local submit is durable before clearing the input") { input(first).text.isEmpty() && !first.isWorking }
        assertTrue(admissions.isEmpty())
        assertTrue(File(app.noBackupFilesDir, "central-native/local-chat/chat.enc").isFile)
        val closed = openActivities.removeAt(openActivities.lastIndex)
        closed.pause().stop().destroy()

        connect(authorized = false)
        val reopened = openChat()
        await("A configured address without owner access still mounts the local composer") {
            tagged<View>(reopened, "chat-connect") != null && tagged<View>(reopened, "ask-input") != null && !reopened.isWorking
        }
        send(reopened, "Generated text with an address")
        await("The second local send is saved") { input(reopened).text.isEmpty() && !reopened.isWorking }
        assertTrue(requests.isEmpty())

        connect()
        await("The same host switches to the authorized main thread and sends both messages") {
            admissions.size == 2 && turns.size == 2 && tagged<View>(reopened, "chat-connect") == null && !reopened.isWorking
        }
        assertEquals(listOf("Generated text kept on the phone", "Generated text with an address"), admissions.map { it.getString("question") })
        assertEquals(2, admissions.map { it.getString("clientRequestId") }.toSet().size)
        assertTrue(admissions.all { it.optString("conversationId") == conversation })
    }

    @Test fun voiceButtonReturnsEditableTextToTheDisconnectedComposer() {
        val activity = openChat()
        await("The local composer is ready") { tagged<View>(activity, "chat-voice") != null && !activity.isWorking }
        requireNotNull(tagged<View>(activity, "chat-voice")).performClick()
        val launched = requireNotNull(shadowOf(activity).nextStartedActivityForResult)
        assertEquals(RecognizerIntent.ACTION_RECOGNIZE_SPEECH, launched.intent.action)
        assertTrue(CentralContent.handlesActivityResult(launched.requestCode))
        deliverResult(activity, launched.requestCode,
            Intent().putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS, arrayListOf("Generated dictation")))
        assertEquals("Generated dictation", input(activity).text.toString())
        assertTrue(requests.isEmpty())
    }

    @Test fun calendarAndTaskCardsUseTheServerReceipts() {
        connect()
        val action = UUID.randomUUID().toString()
        val task = UUID.randomUUID().toString()
        val calendarTurn = UUID.randomUUID().toString()
        calendar = JSONObject().put("id", action).put("kind", "calendar.create").put("status", "succeeded")
            .put("event", JSONObject().put("title", "Generated event").put("start", "2026-11-20T09:00:00Z")
                .put("end", "2026-11-20T10:00:00Z").put("timeZone", "UTC"))
            .put("ownerInstruction", JSONObject().put("conversationId", conversation).put("messageId", calendarTurn))
        turns += message("Generated calendar request", "completed", calendarTurn).put("result", JSONObject()
            .put("answer", "Generated event reply").put("currentAction", JSONObject().put("id", action).put("kind", "calendar.create")))
        turns += message("Generated task request", "completed").put("result", JSONObject().put("answer", "Generated task reply")
            .put("draft", JSONObject().put("scope", JSONObject().put("kind", "all").put("timeZone", "UTC"))))
        tasks = JSONArray().put(JSONObject().put("task", JSONObject().put("id", task).put("goal", "Generated task").put("state", "completed"))
            .put("result", JSONObject().put("answer", "Generated task result")))
        val activity = openChat()
        await("Server calendar receipt and result card are rendered") {
            tagged<View>(activity, "chat-calendar:$action") != null && tagged<View>(activity, "chat-task:$task") != null && !activity.isWorking
        }
        assertTrue(requests.contains("GET" to "/api/actions/$action"))
        assertTrue(requests.contains("GET" to "/api/conversations/$conversation/messages/$turn/assistant-tasks"))
        assertTrue(admissions.isEmpty())
    }
}
