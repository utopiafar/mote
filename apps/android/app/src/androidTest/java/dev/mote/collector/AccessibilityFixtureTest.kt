package dev.mote.collector

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Opt-in fixture AVD only. Never enables capture on physical or user-existing devices. */
@RunWith(AndroidJUnit4::class)
class AccessibilityFixtureTest {
    @Test fun generatedScreenReachesHttpAcknowledgement() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String): String = automation.executeShellCommand(command).use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText().trim() }
        }
        assumeTrue("Only run on the dedicated fresh fixture AVD", shell("getprop ro.boot.qemu.avd_name") == "mote_fixture_api35")
        assumeTrue(Build.VERSION.SDK_INT >= 30)
        val context = instrumentation.targetContext
        val settings = Settings(context)
        assumeTrue("Never replace existing user configuration", settings.read().server.isBlank() && context.queue().depth() == 0)
        val previousServices = shell("settings get secure enabled_accessibility_services")
        val captured = AtomicReference<JSONObject>()
        val acknowledged = CountDownLatch(1)
        val centralUrl = InstrumentationRegistry.getArguments().getString("fixtureCentralUrl")
        val centralToken = InstrumentationRegistry.getArguments().getString("fixtureCentralToken")
        val server = ServerSocket(0)
        val listener = Thread {
            try {
                while (!server.isClosed) server.accept().use { socket ->
                    socket.soTimeout = 15000
                    val input = socket.getInputStream()
                    val header = StringBuilder()
                    while (!header.endsWith("\r\n\r\n")) {
                        val byte = input.read(); if (byte < 0) return@use
                        header.append(byte.toChar()); require(header.length < 65536)
                    }
                    val length = header.lines().first { it.startsWith("Content-Length:", true) }.substringAfter(':').trim().toInt()
                    val bodyBytes = ByteArray(length)
                    var offset = 0
                    while (offset < length) { val count = input.read(bodyBytes, offset, length - offset); require(count > 0); offset += count }
                    val body = JSONObject(String(bodyBytes))
                    val isCapture = header.startsWith("POST /api/captures ")
                    val reply = if (isCapture) {
                        captured.set(body)
                        JSONObject().put("id", body.getString("id")).put("duplicate", false).toString()
                    } else "{\"ok\":true}"
                    val bytes = reply.toByteArray()
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes); flush()
                    }
                    if (isCapture) acknowledged.countDown()
                }
            } catch (_: Exception) { /* Socket closes during finally. */ }
        }.apply { isDaemon = true; start() }
        try {
            shell("pm grant dev.mote.collector android.permission.POST_NOTIFICATIONS")
            shell("settings put secure enabled_accessibility_services dev.mote.collector/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1")
            val deadline = System.currentTimeMillis() + 15000
            while (!CaptureAccessibilityService.connected && System.currentTimeMillis() < deadline) Thread.sleep(100)
            assertTrue("Accessibility service connected", CaptureAccessibilityService.connected)
            instrumentation.startActivitySync(Intent(context, FixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val config = CollectorConfig(server = centralUrl ?: "http://127.0.0.1:${server.localPort}", token = centralToken ?: "generated-fixture-token-0123456789abcdef",
                deviceName = "Generated Android fixture", intervalSeconds = 5, wifiOnly = false, debugHttp = true, masks = "0,0,1,0.12", nsfw = settings.read().nsfw.copy(timeoutMs = 180000))
            settings.save(config.copy(excludedPackages = "dev.mote.collector"))
            settings.enabled = true
            Thread.sleep(2500)
            assertEquals("Explicitly excluded fixture never enters queue", 0, context.queue().depth())
            assertEquals("paused", settings.state())
            assertNull(captured.get())
            settings.enabled = false
            settings.save(config)
            settings.enabled = true
            if (centralUrl == null) {
                assertTrue("Generated screenshot uploaded; ${settings.message()} / ${settings.uploadStatus()}", acknowledged.await(180, TimeUnit.SECONDS))
            } else {
                val uploadDeadline = System.currentTimeMillis() + 180000
                while (captured.get() == null && System.currentTimeMillis() < uploadDeadline) {
                    val connection = java.net.URL("$centralUrl/api/captures?deviceId=${settings.deviceId}&limit=1").openConnection() as java.net.HttpURLConnection
                    try {
                        connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.instanceFollowRedirects = false
                        connection.setRequestProperty("Authorization", "Bearer $centralToken")
                        val result = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                        val items = result.getJSONArray("items")
                        if (items.length() > 0) captured.set(items.getJSONObject(0))
                    } finally { connection.disconnect() }
                    if (captured.get() == null) Thread.sleep(500)
                }
                assertNotNull("Real central node received generated capture; ${settings.message()} / ${settings.uploadStatus()}", captured.get())
            }
            settings.enabled = false
            val event = captured.get()
            assertEquals("android", event.getString("platform"))
            assertTrue(event.getString("ocrText").contains("MOTE"))
            if (centralUrl == null) assertTrue(event.getString("imageBase64").length > 100)
            else assertTrue(event.getString("blobHash").isNotBlank())
            assertFalse(event.getJSONObject("privacy").getBoolean("excluded"))
            assertTrue(event.getJSONObject("privacy").getBoolean("redacted"))
            val deleteDeadline = System.currentTimeMillis() + 3000
            while (context.queue().depth() != 0 && System.currentTimeMillis() < deleteDeadline) Thread.sleep(100)
            assertEquals("Acknowledged capture deleted", 0, context.queue().depth())
        } finally {
            settings.enabled = false
            CaptureAccessibilityService.instance?.stopCapture()
            shell("settings put secure enabled_accessibility_services ${if (previousServices == "null") "''" else previousServices}")
            context.getSharedPreferences("mote", 0).edit().clear().commit()
            androidx.work.WorkManager.getInstance(context).cancelUniqueWork("mote-upload")
            androidx.work.WorkManager.getInstance(context).cancelUniqueWork("mote-upload-recovery")
            server.close(); listener.join(1000)
        }
    }
}
