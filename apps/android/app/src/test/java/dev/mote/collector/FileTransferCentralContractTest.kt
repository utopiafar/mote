package dev.mote.collector

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileTransferCentralContractTest {
    @get:Rule val folder = TemporaryFolder()
    @Test fun realCentralPartReceiptsResumeTheProductionNativeUploaderWithoutResendingAcknowledgedBytes() {
        val origin = System.getenv("MOTE_FILE_TRANSFER_ORIGIN").orEmpty(); assumeTrue("Use file-transfer.ts", origin.isNotBlank())
        assertEquals("127.0.0.1", URL(origin).host)
        val token = requireNotNull(System.getenv("MOTE_FILE_TRANSFER_TOKEN")); val output = File(requireNotNull(System.getenv("MOTE_FILE_TRANSFER_OUTPUT")))
        val api = CentralClient(origin, token, { method, url, body, auth, mime ->
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false; connection.requestMethod = method; connection.connectTimeout = 5000; connection.readTimeout = 15000
                connection.setRequestProperty("Authorization", "Bearer $auth"); connection.setRequestProperty("Content-Type", mime); connection.setRequestProperty("X-Mote-Ingress-Version", "2")
                if (body != null) { connection.doOutput = true; connection.outputStream.use { it.write(body) } }
                val status = connection.responseCode; val text = (if (status < 400) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }
                status to text?.takeIf { it.isNotBlank() }?.let(::JSONObject)
            } finally { connection.disconnect() }
        })
        var lost = false
        val client = object : CentralUploadClient {
            override fun post(path: String, body: JSONObject) = api.post(path, body)
            override fun bytes(method: String, path: String, body: ByteArray?, mime: String): JSONObject {
                val result = api.bytes(method, path, body, mime)
                if (!lost && method == "PUT" && path.endsWith("/parts/0")) { lost = true; throw IllegalStateException("Generated lost part ACK") }
                return result
            }
        }
        val file = folder.newFile("generated-native.bin"); file.outputStream().use { it.write(ByteArray(FileTransfer.PART_BYTES) { 37 }); it.write(ByteArray(17) { 91 }) }
        assertThrows(IllegalStateException::class.java) { CentralAttachments.upload(client, file, file.name, "application/octet-stream", "generated-large-device", { 1000 }) }
        val id = CentralAttachments.upload(client, file, file.name, "application/octet-stream", "generated-large-device", { 1000 })
        val digest = java.security.MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
        output.writeText(JSONObject().put("id", id).put("size", file.length()).put("sha256", digest.digest().joinToString("") { "%02x".format(it) }).toString())
    }
}
