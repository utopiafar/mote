package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.DocumentsContract
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Dedicated generated data only. No personal capture, platform screen read or live model calls. */
@RunWith(AndroidJUnit4::class)
class ActionFirstJourneysInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    private fun waitFor(test: () -> Boolean) { val deadline = SystemClock.elapsedRealtime() + 10000; while (!test()) { check(SystemClock.elapsedRealtime() < deadline); Thread.sleep(30) } }
    private fun fixture(action: (Settings) -> Unit) {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val old = settings.read(); val language = MoteI18n.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        try { MoteI18n.select(context, "zh-CN"); settings.save(old.copy(server = "", token = "", syncPaused = false), confirmCentralEndpoint = true); action(settings) }
        finally { settings.enabled = false; settings.save(old, confirmCentralEndpoint = true); MoteI18n.select(context, language) }
    }
    private fun ack(row: JSONObject): JSONObject {
        val manifest = row.getJSONObject("pending").getJSONObject("manifest"); val item = manifest.getJSONObject("item"); val id = java.util.UUID.randomUUID().toString()
        return JSONObject().put("id", id).put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision"))
            .put("duplicate", false).put("sha256", manifest.optString("sha256")).put("sizeBytes", manifest.getLong("sizeBytes"))
            .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received").put("duplicate", false)
                .put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision")))
    }
    private fun readRequest(socket: java.net.Socket): String {
        val input = socket.getInputStream(); val header = java.io.ByteArrayOutputStream()
        while (!header.toString("UTF-8").endsWith("\r\n\r\n")) { val byte = input.read(); check(byte >= 0); header.write(byte); check(header.size() < 65536) }
        val headers = header.toString("UTF-8"); val length = Regex("(?im)^Content-Length: ([0-9]+)").find(headers)?.groupValues?.get(1)?.toInt() ?: 0
        val buffer = ByteArray(8192); var left = length
        while (left > 0) { val count = input.read(buffer, 0, minOf(left, buffer.size)); check(count > 0); left -= count }
        return headers.lineSequence().first()
    }
    private fun respond(socket: java.net.Socket, status: Int, body: JSONObject) {
        val bytes = body.toString().toByteArray(); socket.getOutputStream().write("HTTP/1.1 $status Fixture\r\nContent-Length: ${bytes.size}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".toByteArray()); socket.getOutputStream().write(bytes)
    }
    @Test fun firstRunShowsFourEqualActionsAndThreeTabsAndOfflineNotesRemainReachable() = fixture { settings ->
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            scenario.onActivity { activity ->
                val rows = views(activity.window.decorView)
                assertEquals(MoteAddAction.entries.map { "add:${it.name}" }, rows.filter { it.tag?.toString()?.startsWith("add:") == true }.map { it.tag })
                assertEquals(listOf("首页", "内容", "问一问"), rows.filterIsInstance<TextView>().filter { it.tag?.toString()?.startsWith("primary:") == true }.map { it.text.toString() })
                activity.openGeneratedAdd(MoteAddAction.SCREEN)
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text == "保存范围并开始记录" })
                assertFalse(settings.enabled)
                activity.openGeneratedAdd(MoteAddAction.NOTE)
            }
            waitFor { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<android.widget.EditText>().any { field -> field.isShown && field.isEnabled && field.hint == "记下此刻的想法…" } }; ready }
            scenario.onActivity { activity ->
                views(activity.window.decorView).single { it.tag == "primary:ASK" }.performClick()
            }
            waitFor { var ready = false; scenario.onActivity { ready = views(it.window.decorView).filterIsInstance<TextView>().any { row -> row.isShown && row.text.contains("中央问答暂不可用") } }; ready }
            assertFalse(settings.enabled)
        }
    }
    @Test fun oneShotGeneratedFileFreezesBeforeUploadAndOfflineDetailReadsThatSavedVersion() = fixture {
        val run = "action-once-${System.nanoTime()}"; val root = File(context.filesDir, "generated-file-sync/$run").apply { mkdirs() }
        val file = File(root, "note.txt").apply { writeText("Generated original 中文.\n".repeat(500)) }
        val uri = DocumentsContract.buildDocumentUri(context.packageName + ".file-fixtures", "$run/note.txt")
        val source = LocalSource(name = "Generated once", kind = "local-files", uri = uri.toString(), syncContinuously = false, centralProcessingConsent = true, extensions = "txt")
        try {
            context.localSources().save(source)
            val scanner = FileSources(context); assertTrue(scanner.scan(source)); val saved = scanner.prepare(source)!!
            val revision = saved.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision")
            val original = context.fileArchives().part(source.id, 0)
            context.fileArchives().saveState(source.id, context.fileArchives().state(source.id).apply { remove("importCaptured") })
            file.writeText("Generated replacement that must not be observed after one-time capture.")
            assertTrue(FileSources(context).scan(source)); assertArrayEquals(original, context.fileArchives().part(source.id, 0))
            assertEquals(revision, context.fileArchives().next(source.id)!!.getJSONObject("pending").getJSONObject("manifest").getJSONObject("item").getString("revision"))
            file.delete()
            assertTrue("Frozen import requires no subsequent provider access", FileSources(context).scan(source))
            ActivityScenario.launch<FileContentActivity>(Intent(context, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", uri.toString())).use { scenario ->
                waitFor { var shown = false; scenario.onActivity { shown = views(it.window.decorView).filterIsInstance<TextView>().any { row -> row.text.contains("Generated original 中文") } }; shown }
                scenario.onActivity { activity ->
                    val labels = views(activity.window.decorView).filterIsInstance<TextView>().map { it.text.toString() }
                    assertFalse(labels.any { it.contains("Generated replacement") }); assertTrue(labels.contains("继续展开")); assertTrue(labels.contains("导出本机保存的完整原件"))
                }
                scenario.recreate()
                waitFor { var shown = false; scenario.onActivity { shown = views(it.window.decorView).filterIsInstance<TextView>().any { row -> row.text.contains("Generated original 中文") } }; shown }
            }
        } finally { context.localSources().remove(source.id); context.fileArchives().remove(source.id); root.deleteRecursively() }
    }
    @Test fun oneShotWithNoSelectedBytesAndContinuousToOnceUnchangedReceiptFreezePermanently() = fixture {
        val run = "action-filter-${System.nanoTime()}"; val root = File(context.filesDir, "generated-file-sync/$run").apply { mkdirs() }; val file = File(root, "note.txt").apply { writeText("Generated stable content") }
        val uri = DocumentsContract.buildDocumentUri(context.packageName + ".file-fixtures", "$run/note.txt")
        val excluded = LocalSource(name = "Generated excluded once", kind = "local-files", uri = uri.toString(), syncContinuously = false, extensions = "pdf", centralProcessingConsent = true)
        val continuous = excluded.copy(id = java.util.UUID.randomUUID().toString(), name = "Generated continuous to once", extensions = "txt", syncContinuously = true, retention = "reference")
        try {
            context.localSources().save(excluded); assertTrue(FileSources(context).scan(excluded)); assertTrue(context.fileArchives().state(excluded.id).getBoolean("importCaptured")); assertEquals(0, context.fileArchives().pendingCount(excluded.id))
            context.localSources().save(continuous); assertTrue(FileSources(context).scan(continuous)); val queue = context.fileArchives(); val saved = FileSources(context).prepare(continuous)!!; queue.acknowledge(continuous.id, saved, ack(saved))
            val once = continuous.copy(syncContinuously = false); context.localSources().save(once); assertTrue(FileSources(context).scan(once)); assertTrue(queue.state(once.id).getBoolean("importCaptured")); assertEquals(0, queue.pendingCount(once.id))
            file.writeText("Later generated edit must not become a new import")
            assertTrue(FileSources(context).scan(once)); assertEquals(0, queue.pendingCount(once.id)); assertTrue(FileSources(context).scan(excluded)); assertTrue(queue.rows(excluded.id).isEmpty())
        } finally { listOf(excluded, continuous).forEach { context.localSources().remove(it.id); context.fileArchives().remove(it.id) }; root.deleteRecursively() }
    }
    @Test fun projectionHeartbeatUsesCurrentSendingPolicyAfterPauseStartAndResume() = fixture { settings ->
        val running = settings.read().copy(server = "http://127.0.0.1:47842", token = "generated-stale-heartbeat-token-123456", debugHttp = true, wifiOnly = false, syncMode = "batch", syncChargingOnly = true)
        settings.save(running, confirmCentralEndpoint = true); val manager = WorkManager.getInstance(context)
        SendPauseControl.set(context, true); val startedPaused = settings.read()
        assertEquals(running.captureStamp(), startedPaused.captureStamp())
        UploadWorker.heartbeat(context, running)
        waitFor { manager.getWorkInfosForUniqueWork("mote-heartbeat").get().none { !it.state.isFinished } }
        SendPauseControl.set(context, false); UploadWorker.heartbeat(context, startedPaused)
        waitFor { manager.getWorkInfosForUniqueWork("mote-heartbeat").get().any { !it.state.isFinished } }
        assertTrue(startedPaused.sameCaptureConfiguration(settings.read()))
        SendPauseControl.set(context, true)
    }
    @Test fun pauseCancelsAStalledFilePartAndPreservesImmutableRetryBytes() = fixture { settings ->
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")); val blocked = CountDownLatch(1); val release = CountDownLatch(1); val service = Executors.newSingleThreadExecutor(); val client = Executors.newSingleThreadExecutor()
        val source = LocalSource(name = "Generated stalled part", kind = "local-files", uri = "content://generated/note.txt", syncContinuously = false, extensions = "txt", centralProcessingConsent = true)
        val queue = context.fileArchives(); val bytes = "Generated immutable file bytes\n".repeat(2000).toByteArray(); val uploadId = java.util.UUID.randomUUID().toString()
        val response = service.submit { repeat(2) { index -> server.accept().use { socket ->
            val request = readRequest(socket)
            if (index == 0) { assertTrue(request.startsWith("POST /api/file-sync/v1/uploads ")); respond(socket, 200, JSONObject().put("uploadId", uploadId).put("partBytes", FileArchiveQueue.PART_BYTES).put("parts", org.json.JSONArray())) }
            else { assertTrue(request.contains("/parts/0 ")); blocked.countDown(); release.await(10, TimeUnit.SECONDS) }
        } } }
        try {
            context.localSources().save(source)
            val item = JSONObject().put("externalId", source.uri).put("uri", source.uri).put("title", "note.txt").put("kind", "file").put("layer", "snapshot").put("text", "").put("mimeType", "text/plain").put("observedAt", java.time.Instant.now().toString())
            queue.observe(source, item, queue.configure(source).getString("generation")); val saved = queue.prepare(source, { java.io.ByteArrayInputStream(bytes) }, { true }, captureImmediately = true)!!
            val connected = settings.read().copy(server = "http://127.0.0.1:${server.localPort}", token = "generated-file-cancellation-token-123456", debugHttp = true, wifiOnly = false, syncMode = "manual"); settings.save(connected, confirmCentralEndpoint = true)
            val sending = client.submit<Boolean> { runCatching { FileUpload.sync(context, source, connected) { true } }.isFailure }
            assertTrue(blocked.await(5, TimeUnit.SECONDS)); SendPauseControl.set(context, true)
            assertTrue("Stalled file write is cancelled promptly", sending.get(5, TimeUnit.SECONDS)); assertEquals(saved.toString(), queue.next(source.id).toString()); assertArrayEquals(bytes, queue.part(source.id, 0))
            release.countDown(); response.get(5, TimeUnit.SECONDS)
        } finally { release.countDown(); server.close(); service.shutdownNow(); client.shutdownNow(); context.localSources().remove(source.id); queue.remove(source.id) }
    }
    @Test fun revokedMaterialReadClearsAlreadyLoadedPrivateCaptureAndProcessingFacts() = fixture { settings ->
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")); val service = Executors.newSingleThreadExecutor()
        val source = LocalSource(name = "Generated revoked detail", kind = "local-files", uri = "content://generated/revoked.txt", retention = "reference", extensions = "txt", syncContinuously = false)
        val queue = context.fileArchives()
        try {
            context.localSources().save(source)
            val item = JSONObject().put("externalId", source.uri).put("uri", source.uri).put("title", "revoked.txt").put("kind", "file").put("layer", "reference").put("text", "").put("observedAt", java.time.Instant.now().toString())
            queue.observe(source, item, queue.configure(source).getString("generation")); val saved = queue.prepare(source, { error("Reference does not read bytes") }, { true }, captureImmediately = true)!!; val receipt = ack(saved); queue.acknowledge(source.id, saved, receipt)
            val connected = settings.read().copy(server = "http://127.0.0.1:${server.localPort}", token = "generated-revoked-central-owner-token-123456", debugHttp = true, wifiOnly = false, syncMode = "manual"); settings.save(connected, confirmCentralEndpoint = true)
            val capture = JSONObject().put("id", receipt.getString("id")).put("deviceId", settings.deviceId).put("ocrText", "Generated private central original must disappear").put("memoryMaterialRef", "material:mat_${"a".repeat(64)}@${"b".repeat(64)}")
                .put("provenance", JSONObject().put("sourceId", source.id).put("externalId", source.uri).put("revision", receipt.getString("revision")))
            val responses = service.submit { repeat(3) { index -> server.accept().use { socket -> readRequest(socket); when (index) {
                0 -> respond(socket, 200, capture)
                1 -> respond(socket, 200, JSONObject().put("captureId", receipt.getString("id")).put("job", JSONObject().put("state", "running")))
                else -> respond(socket, 403, JSONObject().put("error", "connection_scope_denied"))
            } } } }
            ActivityScenario.launch<FileContentActivity>(Intent(context, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", source.uri)).use { scenario ->
                waitFor { var shown = false; scenario.onActivity { shown = views(it.window.decorView).filterIsInstance<TextView>().any { row -> row.text.contains("中央暂不可用") } }; shown }
                scenario.onActivity { activity -> val labels = views(activity.window.decorView).filterIsInstance<TextView>().map { it.text.toString() }; assertFalse(labels.any { it.contains("Generated private central original") }); assertFalse(labels.contains("中央已收到 · 正在整理")) }
            }
            responses.get(5, TimeUnit.SECONDS)
        } finally { server.close(); service.shutdownNow(); context.localSources().remove(source.id); queue.remove(source.id) }
    }
    @Test fun pauseKeepsLocalIntentAndBlocksDispatchAfterTheNetworkRegistrationRace() = fixture { settings ->
        val connected = settings.read().copy(server = "http://127.0.0.1:47842", token = "generated-send-pause-token-0123456789", debugHttp = true, wifiOnly = false, syncMode = "manual")
        settings.save(connected, confirmCentralEndpoint = true)
        val executor = Executors.newSingleThreadExecutor(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val oldRequest = HttpJson.onRequest
        try {
            HttpJson.onRequest = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
            val sending = executor.submit<Boolean> { runCatching { CollectorHttp(context).post("${connected.server}/api/devices/heartbeat", org.json.JSONObject(), connected.token) }.isFailure }
            assertTrue(entered.await(5, TimeUnit.SECONDS)); val captureStamp = connected.captureStamp()
            SendPauseControl.set(context, true); assertEquals(captureStamp, Settings(context).read().captureStamp()); assertEquals("manual", Settings(context).read().syncMode)
            release.countDown(); assertTrue(sending.get(10, TimeUnit.SECONDS))
            assertEquals(MoteI18n.text("已暂停全部发送 · 本机继续保存"), SyncSchedule.waitingReason(context, connected))
            SendPauseControl.set(context, false); assertFalse(Settings(context).read().syncPaused)
        } finally { HttpJson.onRequest = oldRequest; release.countDown(); executor.shutdownNow() }
    }
    @Test fun pausingSendingDoesNotCancelCentralReadConnections() = fixture { settings ->
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")); val accepted = CountDownLatch(1); val finish = CountDownLatch(1)
        val service = Executors.newSingleThreadExecutor(); val client = Executors.newSingleThreadExecutor()
        val response = service.submit { server.accept().use { socket ->
            val input = socket.getInputStream().bufferedReader(); while (input.readLine()?.isNotEmpty() == true) {}
            accepted.countDown(); check(finish.await(10, TimeUnit.SECONDS))
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".toByteArray())
        } }
        try {
            val reading = client.submit<Pair<Int, org.json.JSONObject?>> { HttpJson.get("http://127.0.0.1:${server.localPort}/api/materials") }
            assertTrue(accepted.await(5, TimeUnit.SECONDS)); SendPauseControl.set(context, true); finish.countDown()
            assertEquals(200, reading.get(10, TimeUnit.SECONDS).first); response.get(10, TimeUnit.SECONDS)
        } finally { finish.countDown(); server.close(); service.shutdownNow(); client.shutdownNow() }
    }
}
