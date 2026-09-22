package dev.mote.collector

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ConnectionInstrumentedTest {
    @Test fun connectionPageRefreshesSavedNodeAndSecondScanReplacesFirstPreview() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("mote", 0); val original = preferences.all.toMap()
        require(!Settings(context).enabled)
        fun invitation(server: String) = JSONObject().put("format", "mote.connection").put("version", 1).put("serverUrl", server)
            .put("code", "A".repeat(43)).put("expiresAt", Instant.ofEpochMilli(System.currentTimeMillis() + 600_000).toString()).toString()
        try {
            ActivityScenario.launch(ConnectionActivity::class.java).awaitUiText("当前节点：").use { scenario ->
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                Settings(context).saveConnection("https://generated-new.invalid", "synthetic-collector-token-no-network-123456789", "合成设备", false)
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.awaitUiText("当前节点：https://generated-new.invalid")
                scenario.onActivity { activity ->
                    val receive = ConnectionActivity::class.java.getDeclaredMethod("onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java).apply { isAccessible = true }
                    fun scan(raw: String) { receive.invoke(activity, 1, android.app.Activity.RESULT_OK, Intent().putExtra("invitation", raw)) }
                    val texts = mutableListOf<android.widget.TextView>()
                    fun walk(v: android.view.View) { if (v is android.widget.TextView) texts += v; if (v is android.view.ViewGroup) repeat(v.childCount) { walk(v.getChildAt(it)) } }
                    walk(activity.window.decorView)
                    assertTrue(texts.single { it.text.startsWith("当前节点：") }.text.startsWith("当前节点：https://generated-new.invalid"))
                    for (server in listOf("https://first.generated.invalid", "https://second.generated.invalid")) {
                        scan(invitation(server))
                        assertTrue(texts.single { it.text.startsWith("将连接：") }.text.startsWith("将连接：$server"))
                        assertEquals("https://generated-new.invalid", Settings(context).read().server)
                    }
                    scan("invalid generated invitation")
                    assertFalse(texts.any { it.text.startsWith("将连接：") })
                }
            }
        } finally {
            val editor = preferences.edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> editor.putString(key, value); is Boolean -> editor.putBoolean(key, value); is Int -> editor.putInt(key, value); is Long -> editor.putLong(key, value); is Float -> editor.putFloat(key, value) } }; editor.commit()
        }
    }
    @Test fun pairingReturnThenManualServerEditClearsPreviousCredential() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("mote", 0); val original = preferences.all.toMap()
        require(!Settings(context).enabled)
        try {
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                Settings(context).saveConnection("https://generated-new.invalid", "synthetic-collector-token-no-network-123456789", "合成设备", false)
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.onActivity { activity ->
                    fun views(v: android.view.View): List<android.view.View> = listOf(v) + if (v is android.view.ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
                    views(activity.window.decorView).filterIsInstance<android.widget.TextView>().single { it.isShown && it.isClickable && it.text.toString() == "本机" }.performClick()
                    views(activity.window.decorView).single { it.isShown && it.tag == "menu:连接与同步" }.performClick()
                }
                scenario.awaitUiText("synthetic-collector-token-no-network-123456789")
                scenario.onActivity { activity ->
                    val fields = mutableListOf<android.widget.EditText>()
                    fun walk(v: android.view.View) { if (v is android.widget.EditText) fields += v; if (v is android.view.ViewGroup) repeat(v.childCount) { walk(v.getChildAt(it)) } }
                    walk(activity.window.decorView)
                    val server = fields.single { it.hint?.toString() == "https://mote.example.com" }
                    val token = fields.single { it.hint?.toString() == "建议通过邀请获取本设备凭据" }
                    assertTrue(token.text.isNotEmpty()); server.setText("https://another-generated.invalid"); assertTrue(token.text.isEmpty())
                }
            }
        } finally {
            val editor = preferences.edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> editor.putString(key, value); is Boolean -> editor.putBoolean(key, value); is Int -> editor.putInt(key, value); is Long -> editor.putLong(key, value); is Float -> editor.putFloat(key, value) } }; editor.commit()
        }
    }
    @Test fun externalInvitationOpensReviewOnlyAndDoesNotRequestCamera() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val before = Settings(context).read(); val camera = context.checkSelfPermission(Manifest.permission.CAMERA)
        val raw = JSONObject().put("format", "mote.connection").put("version", 1).put("serverUrl", "https://generated.invalid")
            .put("code", "A".repeat(43)).put("expiresAt", Instant.now().plusSeconds(600).toString())
        val uri = "mote://connect?data=" + Base64.getUrlEncoder().withoutPadding().encodeToString(raw.toString().toByteArray())
        ActivityScenario.launch<ConnectionActivity>(Intent(context, ConnectionActivity::class.java).setData(Uri.parse(uri))).awaitUiText("确认连接此节点").use { scenario ->
            scenario.onActivity { activity ->
                val labels = mutableListOf<String>()
                fun walk(v: android.view.View) { if (v is android.widget.TextView) labels += v.text.toString(); if (v is android.view.ViewGroup) repeat(v.childCount) { walk(v.getChildAt(it)) } }
                walk(activity.window.decorView); assertTrue(labels.contains("确认连接此节点")); assertTrue(labels.contains("扫描连接二维码"))
                assertTrue(activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
            }
        }
        assertEquals(before, Settings(context).read()); assertEquals(camera, context.checkSelfPermission(Manifest.permission.CAMERA))
    }
    @Test fun activeSyncBlocksConnectionMutationWithoutWaitingForNetwork() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val held = CountDownLatch(1); val release = CountDownLatch(1); val done = CountDownLatch(1)
        Thread { try { ConnectionGuard.sync { held.countDown(); release.await(10, TimeUnit.SECONDS) } } finally { done.countDown() } }.start()
        try { assertTrue(held.await(5, TimeUnit.SECONDS)); assertEquals("busy", assertThrows(ConnectionFailure::class.java) { ConnectionGuard.change(context, Settings(context).read().server) { error("Must not run") } }.category) }
        finally { release.countDown(); assertTrue(done.await(5, TimeUnit.SECONDS)) }
    }
    @Test fun pendingCaptureConsentCannotStartDuringConnectionChangeOrAfterConfigChange() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = Settings(context); require(!settings.enabled)
        val stamp = ConnectionGuard.configurationStamp(context)
        val held = CountDownLatch(1); val release = CountDownLatch(1); val done = CountDownLatch(1)
        Thread { try { ConnectionGuard.change(context, settings.read().server) { held.countDown(); release.await(10, TimeUnit.SECONDS) } } finally { done.countDown() } }.start()
        try {
            assertTrue(held.await(5, TimeUnit.SECONDS))
            assertFalse(ConnectionGuard.startCapture(context, stamp) { error("No capture may start") }); assertFalse(settings.enabled)
        } finally { release.countDown(); assertTrue(done.await(5, TimeUnit.SECONDS)) }
        assertFalse(ConnectionGuard.startCapture(context, "stale-config") { error("No stale consent may start") })
        assertFalse(settings.enabled)
    }
    @Test fun optionalGeneratedCentralRePairPreservesOfflineQueueAndPreparedNote() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val input = File(context.filesDir, "connection-live-fixture.json")
        assumeTrue("Needs explicit generated-only central fixture", input.exists())
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val fixture = JSONObject(input.readText()); require(fixture.getBoolean("generatedOnly"))
        val server = fixture.getString("serverUrl"); require(server.startsWith("http://127.0.0.1:"))
        val owner = fixture.getString("token"); val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty())
        val original = context.getSharedPreferences("mote", 0).all.toMap(); val deviceId = settings.deviceId
        val manager = WorkManager.getInstance(context)
        fun stopUploads() { manager.cancelUniqueWork("mote-upload").result.get(5, TimeUnit.SECONDS); manager.cancelUniqueWork("mote-upload-recovery").result.get(5, TimeUnit.SECONDS) }
        fun waitUntil(test: () -> Boolean) { val deadline = android.os.SystemClock.elapsedRealtime() + 45000; while (!test()) { check(android.os.SystemClock.elapsedRealtime() < deadline) { "Generated fixture deadline" }; Thread.sleep(100) } }
        fun mint(): ConnectionInvitation {
            val (code, body) = HttpJson.post("$server/api/connections/invitations", JSONObject().put("serverUrl", server).put("label", "合成 Android 连接验证").put("deviceId", deviceId), owner)
            check(code in 200..299); return ConnectionInvitation.parse(body!!.getJSONObject("invitation").toString(), true, true)
        }
        fun connectThroughRuntime(client: ConnectionClient, invitation: ConnectionInvitation) {
            val done = CountDownLatch(1); var result: Result<RuntimeSettings.Applied>? = null
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                RuntimeSettings.apply(context, settings.read(), bindLocal = true, nextServer = invitation.serverUrl, change = {
                    client.connect(invitation, "合成连接设备", true, bindLocal = true)
                    // New workers must not start behind the reconfiguration gate and enter backoff.
                    for (name in listOf("mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload")) {
                        assertTrue("No upload enqueued before reconfiguration resumes: $name", manager.getWorkInfosForUniqueWork(name).get(5, TimeUnit.SECONDS).all { it.state.isFinished })
                    }
                }) { result = it; done.countDown() }
            }
            assertTrue("Runtime connection callback", done.await(45, TimeUnit.SECONDS))
            assertFalse(result!!.getOrThrow().projectionConsentRequired)
            assertFalse(ConnectionGuard.changing())
        }
        fun event(source: String, text: String) = JSONObject().put("id", UUID.randomUUID().toString()).put("source", source).put("deviceId", deviceId).put("deviceName", "合成连接设备")
            .put("platform", "android").put("capturedAt", Instant.now().toString()).put("durationMs", 0).put("appId", "dev.mote.generated").put("appName", "合成测试")
            .put("ocrText", text).put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
        try {
            stopUploads()
            val baseline = Operations.ledger(context).read().getJSONObject("counts")
            val first = mint(); val client = ConnectionClient(context)
            connectThroughRuntime(client, first)
            waitUntil { ConnectionGuard.sync { true } == true }; stopUploads()
            assertEquals("collector", client.test()); assertEquals(deviceId, settings.deviceId)
            val config = settings.read().copy(wifiOnly = false, diagnosticsEnabled = false, syncMode = "manual", uploadedRetentionDays = 0); settings.save(config)
            val credential = context.getSharedPreferences("connection", 0).getString("credentialId", "")!!
            assertEquals(410, HttpJson.post("$server/api/connections/redeem", JSONObject().put("code", first.code).put("deviceId", deviceId).put("deviceName", "合成").put("platform", "android")).first)
            assertEquals(403, HttpJson.get("$server/api/configuration", config.token).first)
            assertTrue(HttpJson.request("DELETE", "$server/api/connections/$credential", JSONObject(), owner).first in 200..299)
            val queued = event("note", "仅合成离线笔记 👩🏽‍💻\n等待重新配对")
            context.queue().enqueue(queued, null, 1024 * 1024); context.queue().enqueue(queued, null, 1024 * 1024)
            QuickNotes.draft(context).update("合成已准备提交草稿 e\u0301", "")
            val prepared = QuickNotes.draft(context).prepare(server) { event("note", it.text) }.prepared!!
            val queueBefore = context.queue().peek()!!.toString(); val preparedBefore = prepared.toString()
            // A read-lock probe can succeed while another reader still prevents a connection change.
            // Wait on the guarded operation itself, retaining the required pending-data rejection.
            var wrongOriginFailure: ConnectionFailure? = null
            waitUntil {
                wrongOriginFailure = assertThrows(ConnectionFailure::class.java) { ConnectionGuard.change(context, "https://another.generated.invalid") { error("Must not run") } }
                wrongOriginFailure!!.category != "busy"
            }
            assertEquals("pending", wrongOriginFailure!!.category)
            context.getSharedPreferences("sync-heartbeat", 0).edit().clear().commit()
            assertThrows(IllegalStateException::class.java) { SyncHeartbeat.send(context, settings, settings.read(), context.queue()) }
            stopUploads(); assertEquals(queueBefore, context.queue().peek()!!.toString())
            val revokedEvents = Operations.ledger(context).read().getJSONArray("events")
            assertTrue((0 until revokedEvents.length()).any { revokedEvents.getJSONObject(it).let { e -> e.optString("reason") == "AUTH" && e.optInt("httpStatus") == 401 } })
            // Match-origin, owner-bound invitation refreshes credentials without rotating identity or deleting pending data.
            val second = mint()
            waitUntil { runCatching { ConnectionGuard.change(context, server) { true } }.getOrDefault(false) }
            connectThroughRuntime(client, second)
            assertEquals(deviceId, settings.deviceId); assertNotEquals(config.token, settings.read().token)
            assertEquals(preparedBefore, QuickNotes.draft(context).read().prepared!!.toString())
            val noteId = QuickNotes.save(context, QuickNotes.draft(context).read().text, "") { }
            assertEquals(prepared.getString("id"), noteId)
            val imageEvent = event("screen", "纯生成图片 fixture").put("imageMime", "image/png")
            val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
            val bytes = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }; bitmap.recycle()
            context.queue().enqueue(imageEvent, bytes, 1024 * 1024)
            UploadWorker.schedule(context, settings.read(), true); waitUntil { context.queue().depth() == 0 }
            val after = Operations.ledger(context).read(); val counts = after.getJSONObject("counts")
            assertEquals(2, counts.getLong("NOTE_QUEUED") - baseline.getLong("NOTE_QUEUED")); assertEquals(2, counts.getLong("NOTE_ACK") - baseline.getLong("NOTE_ACK"))
            assertEquals(1, counts.getLong("SCREEN_QUEUED") - baseline.getLong("SCREEN_QUEUED")); assertEquals(1, counts.getLong("SCREEN_ACK") - baseline.getLong("SCREEN_ACK"))
            val events = after.getJSONArray("events")
            assertTrue((0 until events.length()).any { events.getJSONObject(it).let { e -> e.optString("kind") == "NOTE_ACK" && e.optString("recordId") == queued.getString("id") } })
            assertFalse(after.toString().contains("仅合成离线笔记")); assertFalse(after.toString().contains(config.token)); assertFalse(after.toString().contains(owner))
            ActivityScenario.launch(ActivityStatsActivity::class.java).use { scenario ->
                Thread.sleep(2500)
                scenario.onActivity { activity ->
                    val view = activity.window.decorView
                    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                    view.draw(android.graphics.Canvas(bitmap))
                    File(context.filesDir, "connection-stats-ui.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
                }
            }
            File(context.filesDir, "connection-live-result.json").writeText(JSONObject().put("deviceIdentityPreserved", true).put("redeemReplayRejected", true).put("collectorAdminDenied", true)
                .put("otherOriginPendingBlocked", true).put("revokedHeartbeat401Visible", true).put("sameOriginRePairPreservedPreparedNote", true)
                .put("screenAcknowledged", 1).put("notesAcknowledged", 2).put("duplicateQueueNotCounted", true).put("diagnosticsDisabled", true).put("contentFreeStats", true).toString())
        } finally {
            stopUploads(); QuickNotes.draft(context).clear(); input.delete()
            val editor = context.getSharedPreferences("mote", 0).edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> editor.putString(key, value); is Boolean -> editor.putBoolean(key, value); is Int -> editor.putInt(key, value); is Long -> editor.putLong(key, value); is Float -> editor.putFloat(key, value) } }; editor.commit()
        }
    }
}
