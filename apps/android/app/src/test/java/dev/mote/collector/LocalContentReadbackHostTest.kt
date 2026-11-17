package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import dev.mote.collector.meeting.*
import dev.mote.collector.plugins.DurableTransportPlugin
import dev.mote.collector.plugins.NativeLibraryPlugin
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
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
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** Replaces only Android startup/key protection and the owner-selected SAF destination.
 * Activities, plugin Host, encrypted stores, HTTP, JSON/body readers and WAV transfer are real. */
@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, shadows = [AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class], sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class LocalContentReadbackHostTest {
    private val origin = System.getenv("MOTE_READBACK_ORIGIN").orEmpty()
    private val token = System.getenv("MOTE_READBACK_TOKEN").orEmpty()
    private lateinit var app: MoteApplication
    private lateinit var settings: Settings
    private lateinit var transport: DurableTransportPlugin
    private val activities = mutableListOf<ActivityController<out Activity>>()
    private fun client() = CentralAccess.requireClient(app)
    private fun control(body: JSONObject = JSONObject()): JSONObject = CentralClient(origin, token).post("/api/generated-readback/control", body)
    @Before fun setup() {
        assumeTrue("Use storage-readback-contract.ts", origin.isNotBlank())
        app = RuntimeEnvironment.getApplication() as MoteApplication; settings = Settings(app)
        val credential = CredentialValue(RuntimeProfile.current, app.secretBox()).encode(token)
        check(app.getSharedPreferences("mote", 0).edit().putString("server", origin).putString("centralEndpoint", origin).putString("dataOrigin", origin)
            .putString("token", credential).putString("deviceName", "Generated readback phone").putBoolean("debugHttp", true).putString("syncMode", "manual").putBoolean("wifiOnly", false).commit())
        QueueLocationStore(app.noBackupFilesDir, File(app.noBackupFilesDir, "queue"), app.localContentCipher()).current()
        transport = DurableTransportPlugin.start(app, app.pluginHost)
        control(JSONObject().put("reset", true))
    }
    @After fun cleanup() {
        if (!::app.isInitialized) return
        control(JSONObject().put("release", true))
        activities.asReversed().forEach { it.pause().stop().destroy() }
        if (::transport.isInitialized) transport.close()
        assertTrue(app.pluginHost.quit().isEmpty())
        HttpJson.onRequest = null
        GeneratedOriginalDestination.target?.delete(); GeneratedOriginalDestination.target = null
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun text(activity: Activity) = views(activity.window.decorView).filterIsInstance<TextView>().joinToString("\n") { it.text.toString() }
    private fun await(reason: String, predicate: () -> Boolean) {
        val deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos()
        while (!predicate() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100)); Thread.sleep(10) }
        assertTrue(reason, predicate())
    }
    private fun capture(source: String = "note"): JSONObject {
        val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId).put("deviceName", "Generated readback phone").put("platform", "android")
            .put("capturedAt", "2026-11-17T01:00:00Z").put("durationMs", 0).put("source", source).put("appId", "generated.readback").put("appName", "Generated readback")
            .put("ocrText", "GENERATED_EXACT_OWNER_BODY").put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "local"))
        val image = if (source == "screen") File(requireNotNull(System.getenv("MOTE_READBACK_IMAGE"))).readBytes().also { event.put("imageMime", "image/jpeg") } else null
        val queue = app.queue(); queue.enqueue(event, image)
        val sent = queue.peekBatch().single { it.getString("id") == event.getString("id") }
        val ack = client().post("/api/captures", sent); assertTrue(IngressV2Protocol.validCapture(event.getString("id"), ack))
        val receipt = CaptureUploadReceipt.create(origin, settings.deviceId, queue.archiveRecord(event.getString("id"))!!.first, sent, UUID.randomUUID().toString(), System.currentTimeMillis(), 0, settings.connectionGeneration())
        CaptureReceiptFinalizer(DurableTransportPlugin.get(app).captureHistory()).received(queue, receipt)
        assertTrue(queue.capture(event.getString("id"))!!.getBoolean("uploaded")); return event
    }
    private fun openCapture(event: JSONObject): CaptureRecordsActivity = Robolectric.buildActivity(CaptureRecordsActivity::class.java,
        Intent(app, CaptureRecordsActivity::class.java).putExtra("recordId", event.getString("id")).putExtra("recordSource", event.getString("source")).putExtra("directReader", true)).also { activities += it }.setup().get()
    private fun release(event: JSONObject) {
        NativeLibraryPlugin.owner(app).releaseCapture(event.getString("id"), app.queue().archiveRecord(event.getString("id"))!!.first.getJSONObject("_archiveAcknowledgment").getString("version")) {}
    }
    private fun paths() = control().getJSONArray("paths").let { array -> (0 until array.length()).map { array.getString(it) } }

    @Test fun realOwnerClickClearsNoteAndJpegThenRestartReadsTheirExactBodiesThroughTheLibraryOwner() {
        for (source in listOf("note", "screen")) {
            val event = capture(source); val id = event.getString("id"); val activity = openCapture(event)
            await("Actual reader displays the original") { text(activity).contains("GENERATED_EXACT_OWNER_BODY") }
            activity.window.decorView.findViewWithTag<Button>("capture-release-local").performClick()
            ShadowAlertDialog.getLatestAlertDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
            await("Owner click commits a complete release") { app.queue().capture(id)?.optJSONObject("localContentRelease")?.optBoolean("pending", true) == false }
            await("Actual reader consumes the real Central body") { text(activity).contains("GENERATED_EXACT_OWNER_BODY") && text(activity).contains("本机副本已清理") }
            val reopened = app.queue(); val stored = reopened.archiveRecord(id)!!.first
            assertFalse(stored.has("ocrText")); assertFalse(stored.has("_blob")); assertNull(reopened.image(id)); assertTrue(reopened.peekBatch().isEmpty()); reopened.verifyIntegrity()
            val read = NativeLibraryPlugin.owner(app).localCapture(id, null) {}
            assertEquals("GENERATED_EXACT_OWNER_BODY", read.first.getString("ocrText"))
            if (source == "screen") assertArrayEquals(File(requireNotNull(System.getenv("MOTE_READBACK_IMAGE"))).readBytes(), read.second)
        }
        println("REAL_READBACK_OWNER_CLICK note+JPEG: cleared/reopened/HTTP exact bodies, pending=0")
    }

    @Test fun withdrawnRealHostScopeStopsALateBodyAndAnySecondaryImageRequest() {
        val event = capture("screen"); release(event); val id = event.getString("id")
        control(JSONObject().put("reset", true).put("hold", "/api/capture-browser/$id")); val activity = openCapture(event)
        await("Central is holding the real response") { control().getBoolean("started") }
        app.pluginHost.stopScope(NativeLibraryPlugin.INSTANCE_ID); control(JSONObject().put("release", true))
        await("The withdrawn reader rejects the late response") { text(activity).contains("登录会话已变更") }
        assertFalse(text(activity).contains("GENERATED_EXACT_OWNER_BODY")); assertFalse(paths().any { it.contains("/$id/image") })
        println("REAL_READBACK_SCOPE: late body rejected, secondary image requests=0")
    }

    @Test fun unobservedConnectionAbaCannotReviveThePendingRead() {
        val event = capture("screen"); release(event); val id = event.getString("id")
        control(JSONObject().put("reset", true).put("hold", "/api/capture-browser/$id")); val activity = openCapture(event)
        await("Central is holding the response before ABA") { control().getBoolean("started") }
        val before = settings.connectionGeneration(); settings.saveConnection("http://127.0.0.1:1", token, "Generated readback phone", true); settings.saveConnection(origin, token, "Generated readback phone", true)
        assertNotEquals(before, settings.connectionGeneration()); control(JSONObject().put("release", true))
        await("ABA produces an unreadable result") { text(activity).contains("登录会话已变更") }
        assertFalse(text(activity).contains("GENERATED_EXACT_OWNER_BODY")); assertFalse(paths().any { it.contains("/$id/image") })
    }

    @Test fun actualMeetingButtonsReleaseAnExactWavAndSafSaveRejectsSameLengthCorruptionBeforeOpeningTheDestination() {
        val root = File(app.filesDir, "meeting-recordings"); val store = app.meetingRecordings(); val at = Instant.parse("2026-11-17T01:00:00Z"); val id = UUID.randomUUID().toString()
        val notice = store.acknowledgeNotice(at); store.begin(id, at, notice, origin)
        val wav = File(root, "meeting-$id.wav"); MeetingWaveWriter(wav, 8000, 1).apply { write(ShortArray(160), 160); finish() }; val bytes = wav.readBytes()
        store.complete(id, at.plusSeconds(1), 1000, true, false, wav.name, emptyList())
        assertTrue(MeetingArchiveTransfer(store, root, settings.deviceId, origin, client(), {}, { it() }).flush())
        val captureId = store.sessions().single().captureId!!
        val controller = Robolectric.buildActivity(MeetingRecordingActivity::class.java).also { activities += it }.setup(); val activity = controller.get()
        await("The actual meeting list contains this recording") { activity.window.decorView.findViewWithTag<Button>("meeting-original-$id") != null }
        activity.window.decorView.findViewWithTag<Button>("meeting-original-$id").performClick()
        ShadowAlertDialog.getLatestAlertDialog().findViewById<View>(android.R.id.content).findViewWithTag<Button>("meeting-release-local").performClick()
        ShadowAlertDialog.getLatestAlertDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        await("Actual meeting owner action releases the WAV") { app.meetingRecordings().sessions().single().localContentRelease?.pending == false }
        assertFalse(wav.exists()); assertTrue(app.meetingRecordings().recovery().isEmpty())
        val destination = File(app.cacheDir, "generated-owner-target.wav"); val prior = "GENERATED_EXISTING_OWNER_FILE".toByteArray(); destination.writeBytes(prior)
        GeneratedOriginalDestination.target = destination; GeneratedOriginalDestination.opens = 0
        ShadowContentResolver.registerProviderInternal("generated.readback", GeneratedOriginalDestination().apply {
            attachInfo(app, android.content.pm.ProviderInfo().apply { authority = "generated.readback" })
        })
        val contentRequests = paths().count { it == "GET /api/files/$captureId/content" }
        control(JSONObject().put("wrongRevision", "/api/files/$captureId"))
        assertThrows(IllegalStateException::class.java) { NativeLibraryPlugin.owner(app).saveMeeting(id, { destination.outputStream() }) {} }
        assertEquals(contentRequests, paths().count { it == "GET /api/files/$captureId/content" }); assertArrayEquals(prior, destination.readBytes())
        control(JSONObject().put("wrongRevision", ""))
        fun saveThroughPicker() {
            activity.window.decorView.findViewWithTag<Button>("meeting-original-$id").performClick()
            ShadowAlertDialog.getLatestAlertDialog().findViewById<View>(android.R.id.content).findViewWithTag<Button>("meeting-save-original").performClick()
            val intent = shadowOf(activity).nextStartedActivityForResult.intent; assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
            shadowOf(activity).receiveResult(intent, Activity.RESULT_OK, Intent().setData(Uri.parse("content://generated.readback/original.wav")))
        }
        control(JSONObject().put("corrupt", "/api/files/$captureId/content")); saveThroughPicker()
        await("The same-length wrong WAV is rejected") { ShadowAlertDialog.getLatestAlertDialog()?.let { views(it.window!!.decorView).filterIsInstance<TextView>().any { view -> view.text.toString().contains("中央原件校验确认不匹配") } } == true }
        assertArrayEquals(prior, destination.readBytes()); assertEquals(0, GeneratedOriginalDestination.opens)
        control(JSONObject().put("corrupt", "")); saveThroughPicker()
        try { await("Verified real archived bytes reach the actual SAF output") { destination.readBytes().contentEquals(bytes) && ShadowAlertDialog.getLatestAlertDialog()?.let { views(it.window!!.decorView).filterIsInstance<TextView>().any { view -> view.text.toString() == "已保存" } } == true } }
        catch (error: AssertionError) { println("SAF_DIAGNOSTIC opens=${GeneratedOriginalDestination.opens} destinationBytes=${destination.length()} dialog=" + ShadowAlertDialog.getLatestAlertDialog()?.let { views(it.window!!.decorView).filterIsInstance<TextView>().joinToString { view -> view.text.toString() } }); throw error }
        assertEquals(1, GeneratedOriginalDestination.opens); assertTrue(app.cacheDir.listFiles()!!.none { it.name.startsWith("meeting-original-") })
        println("REAL_READBACK_WAV: exact bytes=${bytes.size}; same-length corruption preserved existing SAF target; models=0")
    }

    @Test fun originalOriginMismatchAndDeletedCentralOriginalKeepOnlyMetadataAndNeverRequeue() {
        val event = capture(); release(event); val id = event.getString("id")
        settings.saveConnection("http://127.0.0.1:1", token, "Generated readback phone", true)
        control(JSONObject().put("reset", true)); val activity = openCapture(event)
        await("Foreign Central leaves a lightweight record") { text(activity).contains("原中央与当前连接不一致") }
        assertFalse(paths().any { it.contains("/capture-browser/$id") }); assertFalse(text(activity).contains("GENERATED_EXACT_OWNER_BODY"))
        settings.saveConnection(origin, token, "Generated readback phone", true); client().delete("/api/captures/$id")
        val deleted = openCapture(event); await("Deleted remote body remains unavailable") { text(deleted).contains("本机副本已清理") && text(deleted).contains("本机原件不在此设备") }
        val unavailable = runCatching { NativeLibraryPlugin.owner(app).localCapture(id, null) {} }.exceptionOrNull()
        assertTrue("The exact original is unavailable, never a replacement body", unavailable is CentralFailure && unavailable.status in setOf(404, 410) || unavailable?.message == MoteI18n.text("此版本已变化，请返回资料列表重新选择。"))
        assertFalse(text(deleted).contains("GENERATED_EXACT_OWNER_BODY")); assertTrue(app.queue().peekBatch().isEmpty())
    }

    @Test fun offlineAndSignedOutReadsRetainMetadataWithoutReturningCachedBodyOrSendingWithOldPermission() {
        val event = capture(); release(event); val id = event.getString("id")
        control(JSONObject().put("offline", "/api/capture-browser/$id")); val offline = openCapture(event)
        await("Disconnected HTTP retains the lightweight record") { text(offline).contains("本机原件不在此设备") && text(offline).contains("中央记录暂不可读取") }
        assertFalse(text(offline).contains("GENERATED_EXACT_OWNER_BODY")); assertTrue(app.queue().peekBatch().isEmpty())
        control(JSONObject().put("reset", true)); settings.signOut(); val signedOut = openCapture(event)
        await("Current permission is required to consume a released original") { text(signedOut).contains("本机原件不在此设备") && text(signedOut).contains("先登录中央") }
        assertFalse(paths().any { it.contains("/capture-browser/$id") }); assertFalse(text(signedOut).contains("GENERATED_EXACT_OWNER_BODY"))
    }

    @Test fun existingNoteDraftAttachmentAndQuoteOwnersKeepTheirInputAndTheCaptureBody() {
        for (kind in listOf("prepared", "attachment", "quote")) {
            val event = capture(); val id = event.getString("id"); val drafts = app.recordDraftStore()
            when (kind) {
                "prepared" -> { drafts.edit("Generated retained draft", org.json.JSONArray(), JSONObject().put("kind", "manual")); drafts.prepare(origin) { event } }
                "attachment" -> { val attachment = drafts.stage("Generated attachment input".toByteArray(), "generated.txt", "text/plain"); drafts.prepareSubmission(origin, event, org.json.JSONArray().put(attachment)) }
                else -> drafts.prepareSubmission(origin, event, org.json.JSONArray(), JSONObject().put("excerpt", "Generated retained quote"))
            }
            assertThrows(IllegalStateException::class.java) { release(event) }
            assertEquals("GENERATED_EXACT_OWNER_BODY", app.queue().capture(id)!!.getString("ocrText")); assertFalse(app.queue().capture(id)!!.has("localContentRelease"))
            assertNotNull(drafts.record(id))
            if (kind == "prepared") { assertEquals(id, drafts.draft().getJSONObject("prepared").getString("id")); drafts.clear() }
        }
    }

    @Test fun permissionWithdrawalAfterHttpCompletionButBeforeUiPublicationCannotRenderTheBody() {
        val event = capture(); release(event); val id = event.getString("id")
        control(JSONObject().put("hold", "/api/capture-browser/$id"))
        val delivered = java.util.concurrent.CountDownLatch(1)
        val activity = openCapture(event)
        assertFalse(text(activity).contains("GENERATED_EXACT_OWNER_BODY"))
        HttpJson.onComplete = { delivered.countDown() }
        // Release the fixture through JDK HTTP so only the production reader's
        // HttpJson completion releases this latch; the paused UI stays queued.
        val connection = java.net.URL(origin + "/api/generated-readback/control").openConnection() as java.net.HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.doOutput = true; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $token"); connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write("{\"release\":true}".toByteArray()) }; assertEquals(200, connection.responseCode); connection.inputStream.close()
        } finally { connection.disconnect() }
        assertTrue("The actual HTTP body has completed", delivered.await(15, java.util.concurrent.TimeUnit.SECONDS))
        // The paused main looper holds the posted render; only the reader's
        // background continuation runs before the owner withdraws permission.
        Thread.sleep(100)
        assertFalse("The paused main looper has not published the body", text(activity).contains("GENERATED_EXACT_OWNER_BODY"))
        settings.signOut(); HttpJson.onComplete = null
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse("No body may be published after permission withdrawal", text(activity).contains("GENERATED_EXACT_OWNER_BODY"))
    }

    @Test fun alreadyRenderedReadbackIsWithdrawnOnTheNextUiTurnAfterSignOutOrHostStop() {
        val event = capture(); release(event); val activity = openCapture(event)
        await("Readback has actually rendered") { text(activity).contains("GENERATED_EXACT_OWNER_BODY") }
        settings.signOut(); shadowOf(Looper.getMainLooper()).idle()
        assertFalse(text(activity).contains("GENERATED_EXACT_OWNER_BODY"))
        settings.signIn(origin, token, 2592000000L)
        val reopened = openCapture(event); await("A new explicit read renders under the new permission") { text(reopened).contains("GENERATED_EXACT_OWNER_BODY") }
        app.pluginHost.stopScope(NativeLibraryPlugin.INSTANCE_ID); shadowOf(Looper.getMainLooper()).idle()
        assertFalse(text(reopened).contains("GENERATED_EXACT_OWNER_BODY"))
    }
}

class GeneratedOriginalDestination : ContentProvider() {
    companion object { var target: File? = null; var opens = 0 }
    override fun onCreate() = true
    override fun getType(uri: Uri) = "audio/wav"
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor { opens++; return ParcelFileDescriptor.open(requireNotNull(target), ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_TRUNCATE) }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
