package dev.mote.collector

import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real native editor and encrypted queue; generated fixtures only, no screen capture. */
@RunWith(AndroidJUnit4::class)
class RecordEditorInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun guard() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("recordEditorFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        require(!Settings(context).enabled && context.queue().depth() == 0)
        Settings(context).save(Settings(context).read().copy(server = "", token = "", syncMode = "manual"), confirmCentralEndpoint = true)
        MoteI18n.select(context, "zh-CN")
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun waitUntil(description: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(30) }; fail(description)
    }
    private fun screenshot(activity: android.app.Activity, name: String) {
        val view = activity.window.decorView; val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888); view.draw(android.graphics.Canvas(bitmap))
        val directory = File(context.filesDir, "ui-v1-evidence").apply { mkdirs() }; File(directory, name + ".png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    @Test fun sharedOriginalCommentAndFullImageSurviveRecreationThenExplicitSave() {
        guard()
        val dir = File(context.cacheDir, "record-camera").apply { mkdirs() }; val file = File(dir, "generated-full-original.jpg")
        val bitmap = Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888).apply { eraseColor(0xff6655aa.toInt()) }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }; bitmap.recycle()
        val originalBytes = file.readBytes()
        val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.record-files", file)
        context.recordDraftStore().edit("Generated retained manual draft", org.json.JSONArray(), org.json.JSONObject().put("kind", "manual"), "Generated retained manual description")
        val priorDraft = context.recordDraftStore().draft().toString()
        val intent = Intent(context, ShareRecordActivity::class.java).setAction(Intent.ACTION_SEND).setType("image/jpeg")
            .putExtra(Intent.EXTRA_TEXT, "Generated third-party original").putExtra(Intent.EXTRA_STREAM, uri)
        ActivityScenario.launch<ShareRecordActivity>(intent).use { scenario ->
            waitUntil("Shared image preview is staged") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).any { it.tag == "share-images-preview" } && views(activity.window.decorView).single { it.tag == "share-save" }.isEnabled }; ready }
            scenario.onActivity { activity ->
                views(activity.window.decorView).filterIsInstance<EditText>().single { it.tag == "share-note" }.setText("My separate generated comment")
                views(activity.window.decorView).single { it.tag == "share-description-toggle" }.performClick()
                views(activity.window.decorView).filterIsInstance<EditText>().single { it.tag == "record-description" }.setText("This is a saved third-party quotation, not my own experience")
                assertEquals(priorDraft, context.recordDraftStore().draft().toString())
                screenshot(activity, "share-image")
            }
            scenario.recreate()
            waitUntil("Restored panel keeps its own fields") { var ready = false; scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<EditText>().any { it.tag == "share-note" && it.text.toString() == "My separate generated comment" } && views(activity.window.decorView).filterIsInstance<EditText>().any { it.tag == "record-description" && it.isShown && it.text.toString() == "This is a saved third-party quotation, not my own experience" } }; ready }
            assertEquals(priorDraft, context.recordDraftStore().draft().toString())
            MoteAppearance.select(context, AppearancePreference.DARK); instrumentation.waitForIdleSync()
            scenario.onActivity { screenshot(it, "share-image-dark") }
            MoteAppearance.select(context, AppearancePreference.LIGHT); instrumentation.waitForIdleSync()
            assertEquals("Shared record is never saved on opening or recreation", 0, context.queue().depth())
            scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "share-save" }.performClick() }
            waitUntil("Explicit save must enter durable offline queue") { context.queue().depth() == 1 }
            assertEquals(priorDraft, context.recordDraftStore().draft().toString())
        }
        val event = context.queue().peek()!!
        assertEquals("My separate generated comment", event.getString("ocrText"))
        assertEquals("Generated third-party original", event.getJSONObject("metadata").getJSONObject("noteOrigin").getString("text"))
        assertEquals("This is a saved third-party quotation, not my own experience", event.getJSONObject("metadata").getString("ownerDescription"))
        val saved = context.recordDraftStore().record(event.getString("id"))!!.getJSONArray("attachments").getJSONObject(0)
        assertArrayEquals(originalBytes, context.recordDraftStore().bytes(saved.getString("id")))
        assertEquals("image/jpeg", saved.getString("mime"))
        assertEquals(priorDraft, context.recordDraftStore().draft().toString())
        context.recordDraftStore().edit("", org.json.JSONArray(), org.json.JSONObject().put("kind", "manual"))
        file.delete()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil("Home must be rendered") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).any { view -> view.tag == "home-record-action" } }; ready }
            scenario.onActivity { screenshot(it, "home"); it.openGeneratedMenu(); views(it.window.decorView).single { view -> view.tag == "menu:资料与记忆" }.performClick() }
            scenario.onActivity { screenshot(it, "library") }
        }
    }
    @Test fun recordStopPreviewKeepsActualEncodedAudioDraft() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("recordEditorFixture") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        MoteI18n.select(context,"zh-CN")
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.RECORD_AUDIO)
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            waitUntil("Editor loaded") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == "正在想什么" }?.isEnabled == true }; ready }
            scenario.onActivity { activity -> views(activity.window.decorView).single { it.contentDescription == "录音" }.performClick() }
            Thread.sleep(1300)
            scenario.onActivity { activity ->
                assertTrue(views(activity.window.decorView).single { it.tag == "record-leave-notice" }.isShown)
                screenshot(activity,"editor-recording")
            }
            scenario.onActivity { activity -> views(activity.window.decorView).single { it.contentDescription == "停止录音" }.performClick() }
            waitUntil("Stopped audio persisted") { context.recordDraftStore().draft().getJSONArray("attachments").let { it.length() > 0 && it.getJSONObject(it.length() - 1).getString("mime") == "audio/mp4" } }
            val files = context.recordDraftStore().draft().getJSONArray("attachments"); val audio = files.getJSONObject(files.length() - 1)
            val temp = File(context.cacheDir, "generated-audio-check.m4a"); temp.writeBytes(context.recordDraftStore().bytes(audio.getString("id")))
            val metadata = android.media.MediaMetadataRetriever(); metadata.setDataSource(temp.absolutePath)
            assertTrue(metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong() > 0); metadata.release(); temp.delete()
            waitUntil("Audio preview button ready") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).any { view -> view.contentDescription?.toString() == "播放" } }; ready }
            scenario.onActivity { activity -> assertFalse(views(activity.window.decorView).single { it.tag == "record-leave-notice" }.isShown) }
            scenario.onActivity { activity -> views(activity.window.decorView).first { it.contentDescription?.toString() == "播放" }.performClick(); screenshot(activity, "editor-audio-preview") }
            scenario.recreate()
            waitUntil("Audio retained after recreation") { context.recordDraftStore().draft().getJSONArray("attachments").toString().contains(audio.getString("id")) }
        }
    }
    @Test fun explicitClearOffersOneUndoThatRestoresBodyAttachmentsOriginAndDescription() {
        guard()
        val store = context.recordDraftStore()
        try {
            val image = store.stage(byteArrayOf(9, 9, 9), "generated-undo-photo.jpg", "image/jpeg")
            store.edit("Generated undo body", org.json.JSONArray().put(image), org.json.JSONObject().put("kind", "share").put("text", "Generated undo original"), "Generated undo description")
            ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
                waitUntil("Draft loads") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == "正在想什么" }?.isEnabled == true }; ready }
                waitUntil("Clear control appears only with content") { var shown = false; scenario.onActivity { shown = views(it.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == "清空" && it.isShown } }; shown }
                scenario.onActivity { screenshot(it, "editor-before-clear"); views(it.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "清空" }.performClick() }
                waitUntil("Clear empties the durable draft") { val draft = store.draft(); draft.getString("text") == "" && draft.getJSONArray("attachments").length() == 0 && draft.getString("description") == "" && draft.getJSONObject("origin").optString("text") == "" }
                waitUntil("Clear toast offers 已清空 and 撤销") { var shown = false; scenario.onActivity { a -> val texts = views(a.window.decorView).filterIsInstance<TextView>().map { it.text.toString() }; shown = "已清空" in texts && "撤销" in texts }; shown }
                scenario.onActivity { screenshot(it, "editor-cleared-undo") }
                scenario.onActivity { views(it.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "撤销" }.performClick() }
                waitUntil("Undo restores the whole durable draft") { val draft = store.draft(); draft.getString("text") == "Generated undo body" && draft.getString("description") == "Generated undo description" && draft.getJSONArray("attachments").length() == 1 && draft.getJSONArray("attachments").getJSONObject(0).getString("id") == image.getString("id") && draft.getJSONObject("origin").optString("text") == "Generated undo original" }
                waitUntil("Restored draft renders again") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).filterIsInstance<EditText>().any { it.contentDescription == "正在想什么" && it.text.toString() == "Generated undo body" } }; ready }
                scenario.onActivity { screenshot(it, "editor-undo-restored") }
                scenario.recreate()
                waitUntil("Undo survives recreation") { store.draft().getString("text") == "Generated undo body" && store.draft().getJSONArray("attachments").length() == 1 }
                assertArrayEquals(byteArrayOf(9, 9, 9), store.bytes(image.getString("id")))
            }
        } finally { store.clear() }
    }
    @Test fun leavingAnActualRecordingStopsItAndKeepsAnEncodedPrivateDraft() {
        guard();instrumentation.uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.RECORD_AUDIO)
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            waitUntil("Editor loaded") { var ready=false;scenario.onActivity { ready=views(it.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription=="正在想什么" }?.isEnabled==true };ready }
            scenario.onActivity { a ->
                views(a.window.decorView).filterIsInstance<EditText>().single { it.contentDescription=="正在想什么" }.setText("Generated draft before leaving recording")
                views(a.window.decorView).single { it.contentDescription=="录音" }.performClick()
            }
            Thread.sleep(1300)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            waitUntil("Leaving stores the stopped audio") { context.recordDraftStore().draft().getJSONArray("attachments").length()==1 }
            val draft=context.recordDraftStore().draft();assertEquals("Generated draft before leaving recording",draft.getString("text"))
            val audio=draft.getJSONArray("attachments").getJSONObject(0);val file=File(context.cacheDir,"generated-left-recording.m4a");file.writeBytes(context.recordDraftStore().bytes(audio.getString("id")))
            val metadata=android.media.MediaMetadataRetriever();try{metadata.setDataSource(file.absolutePath);assertTrue(metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()>0)}finally{metadata.release();file.delete()}
            assertEquals(0,context.queue().depth());scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            waitUntil("Stopped draft returns with playback") { var found=false;scenario.onActivity { a -> found=views(a.window.decorView).any { it.contentDescription?.toString()=="播放" && it.isShown } };found }
            scenario.onActivity { a -> assertFalse(views(a.window.decorView).any { it.contentDescription=="停止录音" });screenshot(a,"recording-left-and-returned") }
            scenario.recreate();waitUntil("Stopped original survives recreation") { context.recordDraftStore().draft().getJSONArray("attachments").optJSONObject(0)?.optString("id")==audio.getString("id") }
        }
    }
    @Test fun synchronizeOfflineRecordThroughRealWorkManagerAndVerifyOriginalBytes() {
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue(args.getString("recordEditorFixture") == "true" && args.containsKey("uiJourneyServer"))
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val settings = Settings(context); val server = args.getString("uiJourneyServer")!!; val token = args.getString("uiJourneyToken")!!
        val pending = context.queue().peek() ?: run {
            val rows = context.queue().capturePage("1970-01-01T00:00:00Z", java.time.Instant.now().plusSeconds(1).toString(), limit = 60, source = "note").getJSONArray("items")
            (0 until rows.length()).mapNotNull { context.queue().capture(rows.getJSONObject(it).getString("id")) }.singleOrNull {
                it.optString("ocrText") == "My separate generated comment" && it.optJSONObject("metadata")?.optJSONObject("noteOrigin")?.optString("text") == "Generated third-party original"
            } ?: error("Run the offline save journey first; exactly one retained generated note required")
        }
        ConnectionGuard.change(context, server, bindLocal = true) { settings.save(settings.read().copy(server = server, token = token, syncMode = "manual", uploadedRetentionDays = 7), confirmCentralEndpoint = true) }
        UploadWorker.schedule(context, settings.read(), true)
        val deadline = SystemClock.elapsedRealtime() + 120000
        while (context.queue().pendingSync().count > 0 && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100)
        assertEquals("Actual upload must ACK the multimodal record", 0, context.queue().pendingSync().count)
        val client = CentralClient(server, token)
        val remote = client.get("/api/captures/" + pending.getString("id"))
        assertEquals(pending.getString("ocrText"), remote.getString("ocrText"))
        val ids = remote.getJSONObject("metadata").getJSONArray("attachments"); assertEquals(1, ids.length())
        val local = context.recordDraftStore().record(pending.getString("id"))!!.getJSONArray("attachments").getJSONObject(0)
        assertEquals("image/jpeg", client.get("/api/files/" + ids.getString(0)).getJSONObject("item").getString("mimeType"))
        val connection = java.net.URL(server + "/api/files/" + ids.getString(0) + "/content").openConnection() as java.net.HttpURLConnection
        try { connection.setRequestProperty("Authorization", "Bearer $token"); assertEquals(200, connection.responseCode); assertEquals("application/octet-stream", connection.contentType.substringBefore(';')); assertArrayEquals(context.recordDraftStore().bytes(local.getString("id")), connection.inputStream.use { it.readBytes() }) } finally { connection.disconnect() }
        assertNotNull("Local retained original survives ACK", context.queue().capture(pending.getString("id")))
    }
    @Test fun saveCurrentMixedDraftAndSynchronizeAllOriginals() {
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue(args.getString("recordEditorFixture") == "true" && args.containsKey("uiJourneyServer"))
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev"))
        val server = args.getString("uiJourneyServer")!!; val token = args.getString("uiJourneyToken")!!
        require(java.net.URI(server).host in setOf("127.0.0.1", "localhost", "10.0.2.2") && java.net.URI(server).port == 47862)
        val config = Settings(context).read()
        require(!Settings(context).enabled && config.server.trimEnd('/') == server.trimEnd('/') && config.token == token && config.syncMode == "manual")
        val store = context.recordDraftStore(); val draft = store.draft(); val files = draft.getJSONArray("attachments")
        require(store.pendingMedia().length() == 0 && files.length() >= 2)
        val originals = (0 until files.length()).map { files.getJSONObject(it) }
        require(originals.any { it.getString("mime").startsWith("audio/") } && originals.any { it.getString("mime").startsWith("image/") })
        val originalBytes = originals.map { store.bytes(it.getString("id")) }
        val before = context.queue().dedupeIds().toSet()
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            waitUntil("Current mixed native draft must load") { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == "正在想什么" }?.isEnabled == true }; ready }
            assertEquals("Opening the mixed draft must never save it", before, context.queue().dedupeIds().toSet())
            scenario.onActivity { activity -> screenshot(activity, "editor-mixed-before-save"); views(activity.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "保存" }.performClick() }
            waitUntil("One explicit save creates exactly one mixed durable record") { (context.queue().dedupeIds().toSet() - before).size == 1 }
            assertEquals("The single durable draft keeps its originals after saving", originals.size, store.draft().getJSONArray("attachments").length())
        }
        val created = context.queue().dedupeIds().toSet() - before; assertEquals(1, created.size); val id = created.single()
        UploadWorker.schedule(context, Settings(context).read(), true)
        val deadline = SystemClock.elapsedRealtime() + 120000
        while (context.queue().pendingSync().count > 0 && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100)
        assertEquals("All originals and their one note must be acknowledged", 0, context.queue().pendingSync().count)
        val client = CentralClient(server, token)
        val remote = client.get("/api/captures/$id")
        assertEquals(draft.getString("text"), remote.getString("ocrText"))
        val refs = remote.getJSONObject("metadata").getJSONArray("attachments"); assertEquals(originals.size, refs.length())
        for (index in originals.indices) {
            val mime = originals[index].getString("mime")
            assertEquals(mime, client.get("/api/files/" + refs.getString(index)).getJSONObject("item").getString("mimeType"))
            val connection = java.net.URL(server + "/api/files/" + refs.getString(index) + "/content").openConnection() as java.net.HttpURLConnection
            try {
                connection.setRequestProperty("Authorization", "Bearer $token"); assertEquals(200, connection.responseCode)
                assertEquals(if (mime.startsWith("audio/")) mime else "application/octet-stream", connection.contentType.substringBefore(';'))
                assertArrayEquals(originalBytes[index], connection.inputStream.use { it.readBytes() })
                assertArrayEquals(originalBytes[index], store.bytes(originals[index].getString("id")))
            } finally { connection.disconnect() }
        }
        assertNotNull("Retention preserves the local mixed record after successful sync", context.queue().capture(id))
    }

}
