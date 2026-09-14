package dev.mote.collector

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import androidx.work.WorkInfo
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Generated bitmaps only. Never requests screen capture, personal files, or a vision model. */
@RunWith(AndroidJUnit4::class)
class CaptureRecordsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() }
    }
    private fun fixture(test: (Context, Settings, MutableList<String>) -> Unit) {
        val context = instrumentation.targetContext; val settings = Settings(context)
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!settings.enabled && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap(); val ids = mutableListOf<String>()
        fun cancel() { listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload", "mote-capture-ocr", "mote-capture-ocr-recovery").forEach {
            WorkManager.getInstance(context).cancelUniqueWork(it).result.get(5, TimeUnit.SECONDS)
        } }
        try {
            cancel(); settings.save(settings.read().copy(server = "", token = "", syncMode = "manual", excludedPackages = "", appCollectionRules = AppCollectionRules.DEFAULT))
            test(context, settings, ids)
        } finally {
            settings.enabled = false; cancel(); shell("dumpsys battery reset")
            ids.forEach { id ->
                context.queue().capture(id)?.let { record ->
                    context.queue().acknowledge(id)
                    if (record.optJSONObject("ocr")?.optString("status") == "pending" || context.queue().capture(id) != null) {
                        context.queue().completeOcr(id, "", "failed", 64 * 1024 * 1024)
                        context.queue().acknowledgeOcr(id)
                    }
                }
            }
            val edit = prefs.edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value); is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value) } }; edit.commit()
        }
    }
    private fun generated(): Bitmap = Bitmap.createBitmap(480, 240, Bitmap.Config.ARGB_8888).apply {
        Canvas(this).apply { drawColor(Color.WHITE); drawText("MOTE 2048", 120f, 130f, Paint().apply { color = Color.BLACK; textSize = 42f }) }
    }
    private fun jpeg() = generated().let { bitmap -> try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); it.toByteArray() } } finally { bitmap.recycle() } }
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) for (i in 0 until root.childCount) addAll(views(root.getChildAt(i))) }
    private fun waitUntil(condition: () -> Boolean) { val deadline = System.currentTimeMillis() + 45000; while (!condition()) { check(System.currentTimeMillis() < deadline) { "Generated capture fixture timeout" }; Thread.sleep(100) } }

    @Test fun batteryKeepsMaskedImagesAndChargingBackfillsAfterCaptureStopsWithoutChangingOriginalEvent() = fixture { context, settings, ids ->
        shell("dumpsys battery unplug"); shell("dumpsys battery set status 3")
        waitUntil { !Diagnostics.battery(context).second }
        val config = settings.read().copy(ocrChargingOnly = true, chargingOnly = false, metadataEnabled = false, masks = "0,0,0.2,1", nsfw = settings.read().nsfw.copy(enabled = false))
        settings.save(config); assertTrue(settings.read().ocrChargingOnly)
        val pipeline = CapturePipeline(context) { }
        try {
            settings.enabled = true
            val unknown = WindowSnapshot(emptySet(), null, false)
            assertTrue(pipeline.canCapture(config, unknown))
            pipeline.submit(generated(), unknown, config)
            waitUntil { context.queue().depth() == 1 && !pipeline.isBusy() }
            val event = context.queue().peek()!!; val id = event.getString("id"); ids += id
            assertEquals("pending", event.getJSONObject("ocr").getString("status")); assertEquals("", event.getString("ocrText")); assertFalse(event.has("metadata"))
            val bytes = context.queue().image(id)!!
            val image = CapturePreview.decode(bytes, 1000)!!
            try { assertTrue(Color.red(image.getPixel(10, 80)) < 10) } finally { image.recycle() }
            settings.enabled = false; pipeline.close()
            val original = context.queue().peek()!!.toString()
            assertFalse(String(File(context.noBackupFilesDir, "queue/$id.event").readBytes()).contains("charging"))
            shell("dumpsys battery set ac 1"); shell("dumpsys battery set status 2")
            waitUntil { Diagnostics.battery(context).second }
            CaptureOcrWorker.schedule(context, config, replace = true)
            waitUntil { context.queue().capture(id)?.optJSONObject("ocr")?.optString("status") == "completed" }
            assertFalse(settings.enabled); assertTrue(context.queue().capture(id)!!.getString("ocrText").contains("MOTE"))
            assertEquals(original, context.queue().peek()!!.toString())
            assertFalse(context.queue().peek()!!.keys().asSequence().any { it.startsWith("_") })
        } finally { settings.enabled = false; if (pipeline.isBusy()) waitUntil { !pipeline.isBusy() }; runCatching { pipeline.close() } }
    }

    @Test fun localBrowserDisplaysGeneratedThumbnailsPagesAndOcrDetail() = fixture { context, _, ids ->
        val start = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant()
        val bytes = jpeg()
        repeat(21) { i ->
            val id = UUID.randomUUID().toString(); ids += id
            context.queue().enqueue(JSONObject().put("id", id).put("source", "screen").put("capturedAt", start.plusSeconds(i + 1L).toString())
                .put("imageMime", "image/jpeg").put("ocrText", "Generated OCR $i").put("ocr", JSONObject().put("status", "completed"))
                .put("privacy", JSONObject().put("excluded", false)), bytes, 1000000)
        }
        ActivityScenario.launch(CaptureRecordsActivity::class.java).use { scenario ->
            fun shown(value: String): Boolean { var found = false; scenario.onActivity { found = views(it.window.decorView).filterIsInstance<TextView>().any { view -> view.isShown && view.text.toString().contains(value) } }; return found }
            waitUntil { shown("当天 21 条") }
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals(20, views(activity.window.decorView).count { it.tag?.toString()?.startsWith("capture:") == true })
                views(activity.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "下一页" }.performClick()
            }
            waitUntil { shown("第 2 页") }
            scenario.onActivity { activity ->
                val rows = views(activity.window.decorView).filter { it.tag?.toString()?.startsWith("capture:") == true }; assertEquals(1, rows.size)
                assertEquals("capture:${ids.first()}", rows.single().tag); rows.single().performClick()
            }
            waitUntil {
                var ready = false
                instrumentation.runOnMainSync { ready = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>().any { it.text.toString() == "Generated OCR 0" } }
                ready
            }
            instrumentation.runOnMainSync {
                val all = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views)
                assertTrue(all.filterIsInstance<ImageView>().any { it.contentDescription == "采集图片" && it.drawable != null })
                all.filterIsInstance<TextView>().first { it.isShown && it.text.toString() == "关闭" }.performClick()
            }
        }
    }

    @Test fun deferredOcrUploadsOriginalOnceAndKeepsResultUntilMatchingPatchAck() = fixture { context, settings, ids ->
        val bytes = jpeg()
        LoopbackArchive(bytes).use { archive ->
            val config = settings.read().copy(server = archive.url, token = "generated-capture-browser-token-1234567890", debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config)
            val id = UUID.randomUUID().toString(); ids += id
            context.queue().enqueue(JSONObject().put("id", id).put("source", "screen").put("deviceId", settings.deviceId).put("capturedAt", Instant.now().toString())
                .put("imageMime", "image/jpeg").put("ocrText", "").put("ocr", JSONObject().put("status", "pending").put("reason", "charging"))
                .put("privacy", JSONObject().put("excluded", false)), bytes, 1000000)
            val original = context.queue().peek()!!.toString()
            context.queue().completeOcr(id, "Generated PATCH OCR", "completed", 1000000)
            archive.wrongPatchAck = true
            UploadWorker.schedule(context, config, true)
            waitUntil { WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().any { it.state == WorkInfo.State.FAILED } }
            assertEquals(1, archive.captures.get()); assertEquals(1, archive.patches.get())
            assertEquals(original, archive.original!!.toString()); assertNotNull(context.queue().image(id)); assertNotNull(context.queue().nextOcrUpdate())
            assertNull(context.queue().peek()); assertEquals("error", settings.syncState())
            archive.wrongPatchAck = false
            UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 0 }
            assertEquals(1, archive.captures.get()); assertEquals(2, archive.patches.get())
            val client = CaptureRecordClient(config, settings.deviceId)
            val list = client.page(Instant.now().minusSeconds(86400).toString(), Instant.now().plusSeconds(1).toString(), null)
            assertEquals(1, list.getInt("totalCount")); assertEquals(id, list.getJSONArray("items").getJSONObject(0).getString("id"))
            assertEquals("Generated PATCH OCR", client.detail(id).getString("ocrText"))
            assertArrayEquals(bytes, client.image(id, true))
        }
    }

    private class LoopbackArchive(private val image: ByteArray) : AutoCloseable {
        private val socket = ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"))
        val url = "http://127.0.0.1:${socket.localPort}"
        val captures = AtomicInteger(); val patches = AtomicInteger()
        @Volatile var wrongPatchAck = false
        @Volatile var original: JSONObject? = null
        @Volatile private var result: JSONObject? = null
        @Volatile private var running = true
        private val thread = Thread {
            while (running) try { socket.accept().use { client ->
                client.soTimeout = 5000
                val input = client.getInputStream()
                fun line(): String { val value = StringBuilder(); while (true) { val next = input.read(); if (next < 0 || next == 10) break; if (next != 13) value.append(next.toChar()) }; return value.toString() }
                val first = line().split(' '); val method = first[0]; val route = first[1].substringBefore('?')
                var length = 0; var authorized = false
                while (true) { val header = line(); if (header.isBlank()) break; if (header.startsWith("Content-Length:", true)) length = header.substringAfter(':').trim().toInt(); if (header == "Authorization: Bearer generated-capture-browser-token-1234567890") authorized = true }
                check(authorized); require(length in 0..1_000_000)
                val body = ByteArray(length); var read = 0; while (read < length) { val count = input.read(body, read, length - read); check(count > 0); read += count }
                val json = if (length > 0) JSONObject(String(body, Charsets.UTF_8)) else JSONObject()
                val response: ByteArray
                var contentType = "application/json"
                if (route.endsWith("/image")) { response = image; contentType = "image/jpeg" }
                else {
                    val value = when {
                        route == "/api/devices/heartbeat" -> JSONObject().put("ok", true)
                        route == "/api/captures" -> { check(json.keys().asSequence().none { it.startsWith("_") }); captures.incrementAndGet(); original = json; JSONObject().put("id", json.getString("id")) }
                        method == "POST" && route.endsWith("/ocr") -> {
                            patches.incrementAndGet(); check(original != null); check(json.getString("ocrText") == "Generated PATCH OCR"); result = json
                            JSONObject().put("id", if (wrongPatchAck) "wrong-id" else original!!.getString("id"))
                        }
                        route == "/api/capture-browser" -> JSONObject().put("items", org.json.JSONArray().put(JSONObject().put("id", original!!.getString("id"))))
                            .put("totalCount", 1).put("nextCursor", JSONObject.NULL)
                        method == "GET" && route.startsWith("/api/capture-browser/") -> JSONObject(original!!.toString()).put("ocrText", result!!.getString("ocrText"))
                        else -> error("Unexpected generated fixture route")
                    }
                    response = value.toString().toByteArray()
                }
                client.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: $contentType\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(response); flush()
                }
            } } catch (error: Exception) { if (running) throw error }
        }.apply { isDaemon = true; start() }
        override fun close() { running = false; socket.close(); thread.join(2000) }
    }
}
