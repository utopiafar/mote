package dev.mote.collector

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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** Real system image/document pickers. The external fixture driver selects the
 * host-seeded generated files; no intent interception or fabricated result. */
@RunWith(AndroidJUnit4::class)
class RecordPickerJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun until(description: String, timeout: Long = 20000, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(100) }
        fail(description)
    }
    private fun marker(value: String) {
        Log.i("MotePickerJourney", value)
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", value + "\n") })
        println(value)
    }
    private fun ids(files: JSONArray): Set<String> = (0 until files.length()).map { files.getJSONObject(it).getString("id") }.toSet()
    private fun click(scenario: ActivityScenario<RecordEditorActivity>, label: String) {
        until("Actual record editor must enable $label") {
            var ready = false
            scenario.onActivity { activity ->
                ready = views(activity.window.decorView).filterIsInstance<EditText>().singleOrNull { it.contentDescription == MoteI18n.text("正在想什么") }?.isEnabled == true &&
                    views(activity.window.decorView).any { ((it as? TextView)?.text.toString() == label || it.contentDescription?.toString() == label) && it.isClickable && it.isEnabled }
            }
            ready
        }
        scenario.onActivity { activity ->
            assertTrue("Secure window protection remains enabled", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            assertTrue(views(activity.window.decorView).single { ((it as? TextView)?.text.toString() == label || it.contentDescription?.toString() == label) && it.isClickable }.performClick())
        }
    }

    @Test fun realImageAndSafPickersRetainExactOriginalsInOneDraftWithoutImplicitSave() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("recordEditorFixture") == "true" && args.getString("pickerJourney") == "true")
        require(Build.FINGERPRINT.contains("emu64a") && context.packageName.endsWith(".dev")) { "Picker journey requires the isolated generated Dev emulator" }
        val settings=Settings(context); val previous=settings.read()
        require(!settings.enabled && !previous.hasSyncConnection()) { "Generated picker journey requires collection disabled and no connected node" }
        settings.save(previous.copy(syncMode="manual"),confirmCentralEndpoint=true)
        try {
        val expectedImageDigest = requireNotNull(args.getString("pickerImageSha256")) { "Pass SHA-256 of the actual host-seeded generated image" }
        require(expectedImageDigest.matches(Regex("[a-f0-9]{64}")))
        val imageName = args.getString("pickerImageName") ?: "mote-picker-generated.png"
        val textName = args.getString("pickerTextName") ?: "mote-picker-generated.txt"
        val expectedWidth = (args.getString("pickerImageWidth") ?: "1200").toInt()
        val expectedHeight = (args.getString("pickerImageHeight") ?: "900").toInt()
        require(expectedWidth >= 640 && expectedHeight >= 480)
        val expectedTextBytes = "Mote generated SAF file\nUTF-8 内容 fixture\n".toByteArray(Charsets.UTF_8)
        MoteI18n.select(context, "zh-CN")
        val store = context.recordDraftStore()
        require(store.pendingMedia().length() == 0) { "Resolve generated pending media before starting picker handoffs" }
        val before = store.draft()
        require(!before.has("prepared")) { "Do not modify an already prepared submission" }
        val beforeFiles = before.getJSONArray("attachments")
        val beforeIds = ids(beforeFiles)
        require(beforeIds.size <= 8) { "Preserve the current draft and leave capacity for two generated originals" }
        args.getString("pickerExpectedCommentSha256")?.let { require(it == digest(before.getString("text").toByteArray(Charsets.UTF_8))) { "Current comment does not match the expected fixture" } }
        args.getString("pickerExpectedOriginSha256")?.let { require(it == digest(before.getJSONObject("origin").optString("text").toByteArray(Charsets.UTF_8))) { "Current source original does not match the expected fixture" } }
        val existingOriginals = (0 until beforeFiles.length()).associate { beforeFiles.getJSONObject(it).getString("id").let { id -> id to digest(store.bytes(id)) } }
        val beforeRecords = context.queue().dedupeIds().toSet()
        ActivityScenario.launch(RecordEditorActivity::class.java).use { scenario ->
            click(scenario, "照片")
            marker("PICKER_IMAGE_READY_FOR_MANUAL_DRIVER")
            until("Select only $imageName in the real system image picker", 120000) { store.draft().getJSONArray("attachments").length() == beforeIds.size + 1 }
            val image = store.draft().getJSONArray("attachments").let { files -> (0 until files.length()).map { files.getJSONObject(it) }.single { it.getString("id") !in beforeIds } }
            assertEquals("The real picker selected the intended generated image", imageName, image.getString("name"))
            val imageId = image.getString("id")
            val imageBytes = store.bytes(imageId)
            assertEquals("Retained image bytes match the host original exactly", expectedImageDigest, digest(imageBytes))
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size, bounds)
            assertEquals("Original image width is preserved", expectedWidth, bounds.outWidth)
            assertEquals("Original image height is preserved", expectedHeight, bounds.outHeight)
            assertEquals("Image selection does not save a note", beforeRecords, context.queue().dedupeIds().toSet())

            click(scenario, "文件")
            marker("PICKER_FILE_READY_FOR_MANUAL_DRIVER")
            until("Select only $textName in the real system SAF picker", 120000) { store.draft().getJSONArray("attachments").length() == beforeIds.size + 2 }
            val after = store.draft()
            val afterFiles = after.getJSONArray("attachments")
            val added = (0 until afterFiles.length()).map { afterFiles.getJSONObject(it) }.filter { it.getString("id") !in beforeIds }
            val document = added.single { it.getString("id") != imageId }
            assertEquals("SAF selected the intended generated document", textName, document.getString("name"))
            val textId = document.getString("id")
            assertArrayEquals("SAF retains every original UTF-8 byte", expectedTextBytes, store.bytes(textId))
            assertEquals("Picker handoffs preserve the existing comment", before.getString("text"), after.getString("text"))
            assertEquals("Picker handoffs preserve existing share/conversation attribution", before.getJSONObject("origin").toString(), after.getJSONObject("origin").toString())
            assertTrue("Both originals belong to the same unsaved draft", ids(afterFiles).containsAll(beforeIds + setOf(imageId, textId)))
            existingOriginals.forEach { (id, hash) -> assertEquals("Earlier draft originals remain unchanged", hash, digest(store.bytes(id))) }
            assertEquals("Neither picker implicitly submits the draft", beforeRecords, context.queue().dedupeIds().toSet())
            assertFalse(store.hasPrepared())
            assertEquals(0, store.pendingMedia().length())

            scenario.recreate()
            until("Real editor recreation restores both picked originals") {
                var restored = false
                scenario.onActivity { activity ->
                    val children = views(activity.window.decorView)
                    restored = children.filterIsInstance<EditText>().singleOrNull { it.contentDescription == MoteI18n.text("正在想什么") }?.isEnabled == true &&
                        listOf(imageName, textName).all { name -> children.filterIsInstance<TextView>().any { it.text.toString() == name } }
                }
                restored
            }
            val restored = store.draft()
            assertEquals(after.toString(), restored.toString())
            assertArrayEquals("Image bytes survive recreation exactly", imageBytes, store.bytes(imageId))
            assertArrayEquals("Document bytes survive recreation exactly", expectedTextBytes, store.bytes(textId))
            assertEquals("Recreation never saves the draft implicitly", beforeRecords, context.queue().dedupeIds().toSet())
            val directory = File(context.filesDir, "ui-v1-evidence").apply { mkdirs() }
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val view = activity.window.decorView
                val screenshot = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                view.draw(Canvas(screenshot))
                directory.resolve("editor-system-pickers.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
                screenshot.recycle()
            }
            directory.resolve("editor-system-pickers.json").writeText(JSONObject().put("generatedOnly", true).put("actualSystemPickers", true)
                .put("imageName", imageName).put("imageSha256", digest(imageBytes)).put("width", bounds.outWidth).put("height", bounds.outHeight)
                .put("documentName", textName).put("documentSha256", digest(expectedTextBytes)).put("originalsInSameDraft", true)
                .put("existingDraftPreserved", true).put("recreationByteIdentical", true).put("implicitSave", false).toString(2))
        }
        } finally { settings.save(previous,confirmCentralEndpoint=true) }
    }
}
