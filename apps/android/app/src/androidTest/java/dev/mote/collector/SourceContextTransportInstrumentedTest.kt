package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Production WorkManager ordering against a generated HTTP fixture; no model or personal capture. */
@RunWith(AndroidJUnit4::class)
class SourceContextTransportInstrumentedTest {
    private data class Request(val method: String, val path: String, val body: JSONObject?)
    private fun request(socket: java.net.Socket): Request {
        val input = socket.getInputStream(); val header = java.io.ByteArrayOutputStream()
        while (!header.toString("UTF-8").endsWith("\r\n\r\n")) { val byte = input.read(); check(byte >= 0); header.write(byte); check(header.size() < 65536) }
        val text = header.toString("UTF-8"); val line = text.lineSequence().first().split(' ')
        val length = Regex("(?im)^Content-Length: ([0-9]+)").find(text)?.groupValues?.get(1)?.toInt() ?: 0
        val bytes = ByteArray(length); var offset = 0
        while (offset < bytes.size) { val count = input.read(bytes, offset, bytes.size - offset); check(count > 0); offset += count }
        return Request(line[0], line[1], if (bytes.isEmpty()) null else JSONObject(String(bytes, Charsets.UTF_8)))
    }
    private fun respond(socket: java.net.Socket, code: Int, value: JSONObject) {
        val bytes = value.toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().write("HTTP/1.1 $code Fixture\r\nContent-Length: ${bytes.size}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".toByteArray())
        socket.getOutputStream().write(bytes)
    }
    private fun waitFor(label: String, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (!predicate()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(30) }
    }
    @Test fun metadataMustBeAcknowledgedBeforeFileAndLaterDescriptionEditsDoNotReplayCompletedImport() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val old = settings.read()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected && context.localSources().sources().isEmpty())
        val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1")); val service = Executors.newSingleThreadExecutor()
        val requests = CopyOnWriteArrayList<Request>(); val deny = AtomicBoolean(true); val pauseAfterGet = AtomicBoolean(true); val version = AtomicInteger(0)
        val source = LocalSource(name = "Generated metadata ordering", kind = "local-files", uri = "content://generated/context-order.txt", extensions = "txt",
            syncContinuously = false, centralProcessingConsent = true, description = "Generated call recording background", contextDirty = true)
        val store = context.localSources(); val queue = context.fileArchives(); val bytes = "Generated immutable file body".toByteArray()
        val item = JSONObject().put("externalId", source.uri).put("uri", source.uri).put("title", "context-order.txt").put("kind", "file").put("layer", "snapshot").put("text", "")
            .put("mimeType", "text/plain").put("observedAt", "2026-10-12T00:00:00Z").put("metadata", JSONObject().put("version", 1).put("file", JSONObject().put("sizeBytes", bytes.size)))
        var remoteDescription = ""
        var fixtureError: Throwable? = null
        val config = old.copy(server = "http://127.0.0.1:${server.localPort}", token = "generated-source-context-owner-token-1234567890", debugHttp = true,
            syncMode = "manual", syncPaused = false, wifiOnly = false, syncChargingOnly = false, syncBatteryNotLow = false, metadataEnabled = false)
        fun snapshot() = JSONObject().put("sourceId", source.id).put("version", version.get()).put("description", remoteDescription)
            .apply { if (version.get() > 0) put("fingerprint", "a".repeat(64)) }
        val manager = WorkManager.getInstance(context)
        try {
            settings.save(config, confirmCentralEndpoint = true)
            store.save(source); queue.observe(source, item, queue.configure(source).getString("generation"), 0)
            val pending = queue.prepare(source, { java.io.ByteArrayInputStream(bytes) }, { true }, captureImmediately = true)!!
            val manifest = pending.getJSONObject("pending").getJSONObject("manifest"); val fileItem = manifest.getJSONObject("item"); val id = java.util.UUID.randomUUID().toString()
            val ack = JSONObject().put("id", id).put("sourceId", source.id).put("externalId", fileItem.getString("externalId")).put("revision", fileItem.getString("revision"))
                .put("duplicate", false).put("sha256", manifest.getString("sha256")).put("sizeBytes", manifest.getLong("sizeBytes"))
                .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received").put("duplicate", false)
                    .put("sourceId", source.id).put("externalId", fileItem.getString("externalId")).put("revision", fileItem.getString("revision")))
            service.submit {
                try {
                    while (!server.isClosed) server.accept().use { socket ->
                        socket.soTimeout = 5000; val request = request(socket); requests += request
                        when {
                            request.path == "/api/sources" -> respond(socket, 200, JSONObject().put("id", source.id).put("enabled", true))
                            request.path == "/api/sources/${source.id}" -> respond(socket, 200, JSONObject().put("id", source.id).put("enabled", true))
                            request.path == "/api/sources/${source.id}/context" && request.method == "GET" -> {
                                // Change the actual send setting after the first metadata attempt has started.
                                if (pauseAfterGet.getAndSet(false)) settings.save(config.copy(syncPaused = true), confirmCentralEndpoint = true)
                                respond(socket, 200, snapshot())
                            }
                            request.path == "/api/sources/${source.id}/context" -> {
                                if (deny.get()) respond(socket, 503, JSONObject().put("error", "generated_unavailable"))
                                else {
                                    assertEquals(version.get(), request.body!!.getInt("expectedVersion")); remoteDescription = request.body.getString("description"); version.incrementAndGet(); respond(socket, 200, snapshot())
                                }
                            }
                            request.path == "/api/file-sync/v1/uploads" -> {
                                assertTrue("File cannot travel before its description is accepted", version.get() > 0)
                                respond(socket, 200, JSONObject().put("uploadId", java.util.UUID.randomUUID().toString()).put("partBytes", FileArchiveQueue.PART_BYTES).put("parts", JSONArray()).put("ack", ack))
                            }
                            request.path == "/api/devices/heartbeat" -> respond(socket, 200, JSONObject().put("ok", true))
                            request.path.startsWith("/api/capture-browser/updates") -> respond(socket, 200, JSONObject().put("items", JSONArray()).put("cursor", 0))
                            else -> respond(socket, 404, JSONObject().put("error", "generated_unexpected_path"))
                        }
                    }
                } catch (e: Throwable) { if (!server.isClosed) fixtureError = e }
            }
            SourceWork.schedule(context, manual = true, syncExplicit = true)
            waitFor("Pausing between metadata GET and PATCH must defer sending", { settings.syncState() == "waiting" && settings.read().syncPaused })
            assertTrue(store.sources().single().contextDirty); assertEquals(pending.toString(), queue.next(source.id).toString()); assertArrayEquals(bytes, queue.part(source.id, 0))
            assertFalse(requests.any { it.method == "PATCH" && it.path.endsWith("/context") }); assertFalse(requests.any { it.path.startsWith("/api/file-sync") })
            manager.cancelUniqueWork("mote-source-upload").result.get()
            settings.save(config, confirmCentralEndpoint = true)
            SourceWork.schedule(context, manual = true, syncExplicit = true)
            waitFor("The context outage must be reported", { store.state(source.id).optString("status") == "context-http" })
            assertTrue(store.sources().single().contextDirty); assertEquals(pending.toString(), queue.next(source.id).toString()); assertArrayEquals(bytes, queue.part(source.id, 0))
            assertFalse(requests.any { it.path.startsWith("/api/file-sync") })
            waitFor("Manual failed upload must finish", { manager.getWorkInfosForUniqueWork("mote-source-upload").get().all { it.state.isFinished } })
            deny.set(false); SourceWork.schedule(context, manual = true, syncExplicit = true)
            waitFor("Restored context and file must both be confirmed", { !store.sources().single().contextDirty && queue.pendingCount(source.id) == 0 })
            waitFor("Manual accepted upload must finish", { manager.getWorkInfosForUniqueWork("mote-source-upload").get().all { it.state.isFinished } })
            assertEquals(1, store.sources().single().contextVersion); assertTrue(queue.state(source.id).getBoolean("importCaptured"))
            val fileRequests = requests.count { it.path.startsWith("/api/file-sync") }; assertEquals(1, fileRequests)
            val updated = store.sources().single().copy(description = "Corrected generated context", contextDirty = true)
            store.save(updated); SourceWork.schedule(context, manual = true, syncExplicit = true)
            waitFor("Description-only edit must receive its own version", { store.sources().single().contextVersion == 2 && !store.sources().single().contextDirty })
            waitFor("Description-only manual upload must finish", { manager.getWorkInfosForUniqueWork("mote-source-upload").get().all { it.state.isFinished } })
            assertEquals(fileRequests, requests.count { it.path.startsWith("/api/file-sync") }); assertTrue(queue.state(source.id).getBoolean("importCaptured")); assertNull(queue.next(source.id))
            assertNull(fixtureError)
        } finally {
            listOf("mote-source-scan", "mote-source-periodic", "mote-source-upload", "mote-upload", "mote-heartbeat").forEach { manager.cancelUniqueWork(it).result.get() }
            server.close(); service.shutdownNow(); store.remove(source.id); queue.remove(source.id); settings.save(old, confirmCentralEndpoint = true)
        }
    }
}
