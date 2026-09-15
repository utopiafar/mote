package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Generated invitation and loopback responses only; no camera, screenshot or model is used. */
@RunWith(AndroidJUnit4::class)
class PairingNavigationInstrumentedTest {
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun editor(activity: Activity, hint: String) = views(activity.window.decorView).filterIsInstance<EditText>().single { it.hint?.toString() == hint }
    private fun click(activity: Activity, text: String) = views(activity.window.decorView).filterIsInstance<TextView>()
        .single { it.isShown && it.isClickable && it.text.toString() == text }.performClick()
    private fun menu(activity: Activity, label: String) = views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }.performClick()
    private fun saveVisible(activity: Activity) = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == "保存设置" }

    @Test fun confirmedScannedInvitationSurvivesReturnReentryAndAnotherSettingsSave() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val settings = Settings(context)
        require(!settings.enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        require(context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty())
        val preferences = listOf("mote", "connection").associateWith { context.getSharedPreferences(it, 0).all.toMap() }
        val manager = WorkManager.getInstance(context)
        manager.cancelAllWork().result.get(20, TimeUnit.SECONDS)
        val requests = CopyOnWriteArrayList<String>()
        val verifying = CountDownLatch(1); val continueVerification = CountDownLatch(1)
        val listener = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        val node = "http://127.0.0.1:${listener.localPort}"; val deviceId = settings.deviceId
        val credential = "generated-paired-credential"; val newToken = "generated-paired-token-12345678901234567890"
        val server = Thread {
            while (!listener.isClosed) {
                val socket = try { listener.accept() } catch (_: java.io.IOException) { break }
                socket.use {
                    it.soTimeout = 10_000
                    val reader = it.getInputStream().bufferedReader()
                    val request = reader.readLine() ?: return@use
                    val path = request.split(' ')[1]; var length = 0
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) length = line.substringAfter(':').trim().toInt()
                    }
                    // This fixture uses ASCII names, so request characters and UTF-8 bytes have equal lengths.
                    repeat(length) { reader.read() }
                    requests += path
                    if (path == "/api/connections/self") { verifying.countDown(); check(continueVerification.await(20, TimeUnit.SECONDS)) }
                    val body = when (path) {
                        "/api/connections/redeem" -> JSONObject().put("serverUrl", node).put("scope", "collector").put("token", newToken).put("credentialId", credential)
                        "/api/connections/self" -> JSONObject().put("credential", JSONObject().put("id", credential).put("scope", "collector")
                            .put("deviceId", deviceId).put("platform", "android").put("serverUrl", node)).put("capabilities", JSONObject().put("ingest", true))
                        else -> JSONObject()
                    }.toString().toByteArray()
                    it.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(body); flush()
                    }
                }
            }
        }.apply { isDaemon = true; start() }
        fun waitUntil(check: () -> Boolean) {
            val until = SystemClock.elapsedRealtime() + 30_000
            while (!check()) { assertTrue("Generated pairing must finish", SystemClock.elapsedRealtime() < until); Thread.sleep(50) }
            instrumentation.waitForIdleSync()
        }
        try {
            settings.save(settings.read().copy(server = "https://old.generated.invalid", token = "generated-old-token-1234567890123456", deviceName = "Generated device", debugHttp = true, syncMode = "manual", intervalSeconds = 30))
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                val monitor = instrumentation.addMonitor(ConnectionActivity::class.java.name, null, false)
                scenario.onActivity { activity ->
                    click(activity, "设置"); menu(activity, "连接与同步")
                    editor(activity, "https://mote.example.com").setText("https://discard.generated.invalid")
                    assertTrue(saveVisible(activity)); menu(activity, "扫码或导入邀请")
                }
                val connection = instrumentation.waitForMonitorWithTimeout(monitor, 10_000) as? ConnectionActivity ?: error("Invitation page did not open")
                instrumentation.removeMonitor(monitor)
                waitUntil {
                    var ready = false
                    instrumentation.runOnMainSync { ready = views(connection.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == "确认连接此节点" } }
                    ready
                }
                val invitation = JSONObject().put("format", "mote.connection").put("version", 1).put("serverUrl", node)
                    .put("code", "A".repeat(43)).put("expiresAt", Instant.ofEpochMilli(System.currentTimeMillis() + 600_000).toString()).toString()
                instrumentation.runOnMainSync {
                    val scanResult = ConnectionActivity::class.java.getDeclaredMethod("onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java).apply { isAccessible = true }
                    scanResult.invoke(connection, 1, Activity.RESULT_OK, Intent().putExtra("invitation", invitation))
                    assertTrue(views(connection.window.decorView).filterIsInstance<TextView>().any { it.text.startsWith("将连接：$node") })
                    assertEquals("https://old.generated.invalid", settings.read().server)
                    click(connection, "确认连接此节点")
                }
                waitUntil {
                    var confirmed = false
                    instrumentation.runOnMainSync {
                        val confirm = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<TextView>()
                            .singleOrNull { it.isShown && it.isClickable && it.text.toString() == "连接" }
                        if (confirm != null) { confirm.performClick(); confirmed = true }
                    }
                    confirmed
                }
                assertTrue(verifying.await(20, TimeUnit.SECONDS))
                instrumentation.runOnMainSync { connection.finish() }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> assertEquals("https://old.generated.invalid", editor(activity, "https://mote.example.com").text.toString()) }
                continueVerification.countDown()
                waitUntil { settings.read().server == node && !ConnectionGuard.changing() }
                assertEquals(newToken, settings.read().token); assertEquals(deviceId, settings.deviceId)
                assertEquals(listOf("/api/connections/redeem", "/api/connections/self"), requests.toList())
                scenario.awaitUiText(node)
                scenario.onActivity { activity ->
                    assertEquals(node, editor(activity, "https://mote.example.com").text.toString())
                    assertEquals(newToken, editor(activity, "建议通过邀请获取本设备凭据").text.toString())
                    assertFalse(saveVisible(activity))
                    activity.onBackPressed(); assertFalse(saveVisible(activity))
                    menu(activity, "连接与同步")
                    assertEquals(node, editor(activity, "https://mote.example.com").text.toString())
                    click(activity, "设置"); menu(activity, "采集与存储")
                    editor(activity, "30").setText("47"); click(activity, "保存设置")
                    // Leaving while the save is pending must not resurrect its old draft on completion.
                    click(activity, "设置"); assertFalse(saveVisible(activity))
                }
                waitUntil { settings.read().intervalSeconds == 47 && !ConnectionGuard.changing() }
                assertEquals(node, settings.read().server); assertEquals(newToken, settings.read().token)
                scenario.recreate(); scenario.awaitMainUi()
                scenario.onActivity { activity ->
                    assertFalse(saveVisible(activity)); menu(activity, "连接与同步")
                    assertEquals(node, editor(activity, "https://mote.example.com").text.toString())
                    activity.onBackPressed(); menu(activity, "采集与存储")
                    assertEquals("47", editor(activity, "30").text.toString()); assertFalse(saveVisible(activity))
                }
                ConnectionGuard.processing.incrementAndGet()
                try {
                    scenario.onActivity { activity -> editor(activity, "30").setText("60"); click(activity, "保存设置") }
                    scenario.recreate(); scenario.awaitMainUi()
                } finally { ConnectionGuard.processing.decrementAndGet() }
                waitUntil { settings.read().intervalSeconds == 60 && !ConnectionGuard.changing() }
                waitUntil {
                    var delivered = false
                    scenario.onActivity { delivered = editor(it, "30").text.toString() == "60" && !saveVisible(it) }
                    delivered
                }
                scenario.onActivity { activity ->
                    assertEquals("60", editor(activity, "30").text.toString()); assertFalse(saveVisible(activity))
                    assertEquals(node, editor(activity, "https://mote.example.com").text.toString())
                }
            }
        } finally {
            continueVerification.countDown()
            listener.close(); server.join(5000)
            manager.cancelAllWork().result.get(20, TimeUnit.SECONDS)
            preferences.forEach { (name, original) ->
                val edit = context.getSharedPreferences(name, 0).edit().clear()
                original.forEach { (key, value) -> when (value) {
                    is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value); is Int -> edit.putInt(key, value)
                    is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value)
                } }; edit.commit()
            }
        }
    }
}
