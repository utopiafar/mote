package dev.mote.collector.plugins

import dev.mote.collector.ByteCipher
import dev.mote.collector.FileArchiveQueue
import dev.mote.collector.LocalSource
import dev.mote.collector.LocalSourceStore
import dev.mote.collector.SourceContextSync
import dev.mote.collector.SourceRules
import dev.mote.collector.SourceScan
import dev.mote.collector.UploadSlice
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.Socket
import java.net.URI
import java.net.URL
import java.time.Instant
import java.util.UUID

/** Run by test-fixtures/source-sync-native.ts against a real private Central
 * node. Generated local store, file metadata and HTTP only; no device grant,
 * personal file or model call. */
class SourceSyncContractTest {
    @get:Rule val folder = TemporaryFolder()
    private val origin = System.getenv("MOTE_SOURCE_SYNC_ORIGIN").orEmpty()
    private val ownerToken = System.getenv("MOTE_SOURCE_SYNC_TOKEN").orEmpty()
    private val resultPath = System.getenv("MOTE_SOURCE_SYNC_RESULT").orEmpty()
    private val device = "generated-source-sync-device"
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 59).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private class Scheduler : SourceScheduler {
        var schedules = 0
        override fun schedule(manual: Boolean, syncExplicit: Boolean) { schedules++ }
        override fun upload(explicit: Boolean) = Unit
        override fun cancel(sourceId: String) = Unit
        override fun cancelAll() = Unit
    }

    @Before fun requireRealCentral() {
        assumeTrue("Use the source sync native runner", origin.isNotEmpty())
        assertEquals("127.0.0.1", URL(origin).host)
        assertTrue(ownerToken.isNotEmpty() && resultPath.isNotEmpty())
    }

    /** A minimal generated HTTP/1.1 client: Android's test classpath has no
     * java.net.http and HttpURLConnection rejects the production PATCH route. */
    private fun http(method: String, path: String, body: String? = null): Pair<Int, JSONObject?> {
        val endpoint = URI.create(origin)
        Socket(endpoint.host, if (endpoint.port > 0) endpoint.port else 80).use { socket ->
            socket.soTimeout = 15000
            val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
            val head = buildString {
                append("$method $path HTTP/1.1\r\n")
                append("Host: ${endpoint.host}:${if (endpoint.port > 0) endpoint.port else 80}\r\n")
                append("Authorization: Bearer $ownerToken\r\n")
                append("Accept-Language: zh-CN\r\n")
                append("X-Mote-Ingress-Version: 2\r\n")
                if (body != null) append("Content-Type: application/json\r\n")
                append("Content-Length: ${bytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }.toByteArray(Charsets.UTF_8)
            val output = socket.getOutputStream()
            output.write(head); output.write(bytes); output.flush()
            val response = socket.getInputStream().use { it.readBytes() }
            val split = response.indexOf("\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            check(split > 0) { "Malformed generated HTTP response" }
            val headerText = String(response.copyOfRange(0, split), Charsets.ISO_8859_1)
            val payload = response.copyOfRange(split + 4, response.size)
            val headers = headerText.lines().drop(1).mapNotNull { line ->
                val index = line.indexOf(':'); if (index <= 0) null else line.substring(0, index).trim().lowercase() to line.substring(index + 1).trim()
            }.toMap()
            val decoded = if (headers["transfer-encoding"]?.contains("chunked") == true) decodeChunks(payload) else payload
            val status = headerText.lineSequence().first().split(' ')[1].toInt()
            val text = String(decoded, Charsets.UTF_8).takeIf(String::isNotBlank)
            return status to text?.let(::JSONObject)
        }
    }

    private fun decodeChunks(input: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        var offset = 0
        while (offset < input.size) {
            val lineEnd = input.indexOf("\r\n".toByteArray(Charsets.ISO_8859_1), offset)
            if (lineEnd < 0) break
            val size = String(input.copyOfRange(offset, lineEnd), Charsets.ISO_8859_1).substringBefore(';').trim().toInt(16)
            offset = lineEnd + 2
            if (size == 0) break
            output.write(input, offset, size)
            offset += size + 2
        }
        return output.toByteArray()
    }

    private fun ByteArray.indexOf(needle: ByteArray, from: Int = 0): Int {
        if (needle.isEmpty()) return from
        for (index in from..this.size - needle.size) {
            if (needle.indices.all { this[index + it] == needle[it] }) return index
        }
        return -1
    }

    @Test fun realCentralAcceptsACompleteSourceSyncAndPreservesTheAcknowledgedRevision() {
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val queue = FileArchiveQueue(folder.newFolder(), cipher, store)
        val host = NativePluginHost(NativePluginRegistry().apply { SourceProviderPlugin.register(this, "generated-build") })
        val identity = PluginInstanceIdentity(SourceProviderPlugin.INSTANCE_ID, "generated-installation", SourceProviderPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf("sources"))) as PluginResult.Ok).value
        val scheduler = Scheduler()
        val owner = (host.startPlugin(scope) {
            SourceProviderPlugin.open(host, scope, store, queue, scheduler, cipher = cipher)
        } as PluginResult.Ok).value
        val id = "generated-source-" + UUID.randomUUID().toString().replace("-", "").take(16)
        val source = LocalSource(
            id = id, name = "Generated source sync", kind = "local-files", retention = "snapshot",
            uri = "content://generated/tree/root", tree = true, extensions = "txt",
            centralProcessingConsent = true, syncContinuously = true,
        )
        owner.save(source)
        assertEquals(1, scheduler.schedules)

        val (registeredCode, registered) = http("POST", "/api/sources", source.registration(device).toString())
        assertTrue("Central registers the generated source: $registeredCode $registered", registeredCode in 200..299)
        assertEquals(id, registered!!.getString("id"))

        val described = source.copy(description = "Generated source background", contextDirty = true)
        owner.save(described)
        val target = SourceRules.target(origin, ownerToken)
        val confirmed = SourceContextSync.sync(store, described, origin, target, UploadSlice(), { true }) { method, url, body ->
            http(method, url.removePrefix(origin), body?.toString())
        }
        assertNotNull("Central accepted the exact source context", confirmed)
        assertEquals(1, confirmed!!.contextVersion)
        assertFalse(confirmed.contextDirty)

        val current = store.sources().single()
        store.selectTarget(id, target)
        val observedAt = Instant.now().toString()
        val item = JSONObject().put("externalId", "content://generated/tree/root/one.txt")
            .put("uri", "content://generated/tree/root/one.txt").put("title", "one.txt")
            .put("text", "Generated source sync body").put("kind", "file").put("layer", "snapshot")
            .put("mimeType", "text/plain").put("observedAt", observedAt)
        store.scan(current, SourceScan(listOf(item), true, observedAt))
        val pending = store.next(id, target)!!
        val (code, ack) = http("PUT", "/api/sources/$id/items", pending.toString())
        assertTrue("Central acknowledges the source item: $code $ack", code in 200..299)
        assertTrue(SourceRules.validAck(id, pending, ack))
        val duplicate = http("PUT", "/api/sources/$id/items", pending.toString())
        assertTrue(duplicate.first in 200..299)
        assertTrue(SourceRules.validAck(id, pending, duplicate.second))
        assertEquals(ack!!.getString("id"), duplicate.second!!.getString("id"))

        store.acknowledge(id, target, pending.getString("externalId"), pending.getString("revision"))
        assertNull(store.next(id, target))
        assertEquals(0, owner.snapshots(id, 0, 20).single().pending)
        val result = JSONObject().put("sourceId", id).put("externalId", pending.getString("externalId"))
            .put("revision", pending.getString("revision")).put("ack", ack.getString("id"))
            .put("contextVersion", confirmed.contextVersion).put("duplicate", duplicate.second!!.getBoolean("duplicate"))
        File(resultPath).writeText(result.toString(), Charsets.UTF_8)
    }
}
