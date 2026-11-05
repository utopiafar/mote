package dev.mote.collector

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** Real system camera handoff. The external emulator driver presses shutter/accept;
 * this test never intercepts the camera intent or supplies a fabricated result. */
@RunWith(AndroidJUnit4::class)
class RecordCameraJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(100) }
        fail(description)
    }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test fun realCameraReturnsFullOriginalToPrivateDraftWithoutImplicitSave() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("recordEditorFixture") == "true" && args.getString("cameraJourney") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev")) { "Real camera fixture requires the isolated generated Dev emulator" }
        require(!Settings(context).enabled) { "Generated camera journey runs with collection disabled" }
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.CAMERA)
        MoteI18n.select(context, "zh-CN")
        val store = context.recordDraftStore()
        require(store.pendingMedia().length() == 0) { "Resolve existing generated pending media before starting a new camera handoff" }
        val beforeDraft = store.draft()
        val beforeAttachments = beforeDraft.getJSONArray("attachments")
        val beforeIds = (0 until beforeAttachments.length()).map { beforeAttachments.getJSONObject(it).getString("id") }.toSet()
        require(beforeIds.size < 10) { "The generated draft must have capacity for a camera original" }
        val beforeRecords = context.queue().dedupeIds().toSet()
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            until("Actual record editor must enable its camera action") {
                var ready = false
                scenario.onActivity { activity -> ready = views(activity.window.decorView).any { it.contentDescription?.toString() == "拍照" && it.isEnabled && it.isClickable } }
                ready
            }
            scenario.onActivity { activity ->
                assertTrue("Secure window protection must remain enabled", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertTrue(views(activity.window.decorView).single { it.contentDescription?.toString() == "拍照" && it.isClickable }.performClick())
            }
            until("Camera output destination must be journaled before the real camera result") { store.pendingMedia().length() == 1 }
            val marker = "CAMERA_READY_FOR_MANUAL_DRIVER"
            Log.i("MoteCameraJourney", marker)
            instrumentation.sendStatus(0, Bundle().apply { putString("stream", marker + "\n") })
            println(marker)
            until("Real system camera must return and durably stage one full original; external driver must press shutter and accept", 120000) {
                val draft = store.draft()
                draft.getJSONArray("attachments").length() == beforeIds.size + 1 && store.pendingMedia().length() == 0
            }
            val after = store.draft()
            val attachments = after.getJSONArray("attachments")
            val added = (0 until attachments.length()).map { attachments.getJSONObject(it) }.filter { it.getString("id") !in beforeIds }.single()
            assertEquals("image/jpeg", added.getString("mime"))
            val attachmentId = added.getString("id")
            val originalBytes = store.bytes(attachmentId)
            val decoded = BitmapFactory.decodeByteArray(originalBytes, 0, originalBytes.size)
            assertNotNull("Encrypted staged camera original must actually decode", decoded)
            val width = decoded!!.width
            val height = decoded.height
            decoded.recycle()
            assertTrue("Camera result must be a full original rather than a thumbnail: ${width}x$height", minOf(width, height) >= 480 && maxOf(width, height) >= 640)
            assertEquals("Camera appends to the existing authored comment", beforeDraft.getString("text"), after.getString("text"))
            assertEquals("Camera preserves existing share/conversation attribution", beforeDraft.getJSONObject("origin").toString(), after.getJSONObject("origin").toString())
            assertEquals("Camera must not implicitly save a note", beforeRecords, context.queue().dedupeIds().toSet())
            assertEquals(0, store.pendingMedia().length())
            scenario.recreate()
            until("Camera original and journal cleanup must survive actual editor recreation") {
                val restored = store.draft()
                val files = restored.getJSONArray("attachments")
                files.length() == beforeIds.size + 1 && (0 until files.length()).count { files.getJSONObject(it).getString("id") == attachmentId } == 1 && store.pendingMedia().length() == 0
            }
            until("Recreated editor must display the staged camera attachment") {
                var ready = false
                scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == MoteI18n.text("正在想什么") }?.isEnabled == true && views(activity.window.decorView).any { it.contentDescription?.toString() == MoteI18n.text("照片") } }
                ready
            }
            assertArrayEquals("Full decrypted original remains byte-identical after recreation", originalBytes, store.bytes(attachmentId))
            assertEquals("Recreation must not implicitly save a note", beforeRecords, context.queue().dedupeIds().toSet())
            val directory = File(context.filesDir, "ui-v1-evidence").apply { mkdirs() }
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val root = activity.window.decorView
                val screenshot = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(screenshot))
                directory.resolve("editor-camera-original.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
                screenshot.recycle()
            }
            directory.resolve("editor-camera-original.json").writeText(JSONObject().put("generatedOnly", true).put("actualSystemCamera", true).put("width", width).put("height", height).put("bytes", originalBytes.size).put("sha256", digest(originalBytes)).put("pendingMediaEmpty", true).put("recreationByteIdentical", true).put("implicitSave", false).toString(2))
        }
    }
}
