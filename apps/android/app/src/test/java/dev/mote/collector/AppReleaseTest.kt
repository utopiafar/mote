package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64

class AppReleaseTest {
    private fun manifest() = JSONObject().put("schemaVersion", 1).put("version", "0.5.0").put("channel", "stable").put("repository", "utopiafar/mote").put("tag", "v0.5.0")
        .put("publishedAt", "2026-09-13T00:00:00Z").put("notesUrl", "https://github.com/utopiafar/mote/releases/tag/v0.5.0")
        .put("assets", JSONArray().put(JSONObject().put("component", "android").put("platform", "android").put("arch", "arm64").put("format", "apk")
            .put("name", "mote.apk").put("url", "https://github.com/utopiafar/mote/releases/download/v0.5.0/mote.apk").put("size", 100)
            .put("sha256", "a".repeat(64)).put("packageName", "dev.mote.collector").put("versionCode", 6).put("certificateSha256", "b".repeat(64))))
        .put("images", JSONArray())
    private fun envelope(payload: JSONObject): ByteArray {
        val bytes = payload.toString().toByteArray(); val signer = Signature.getInstance("SHA256withRSA"); signer.initSign(keys.private); signer.update(bytes)
        return JSONObject().put("schemaVersion", 1).put("keyId", AppReleaseVerifier.KEY_ID).put("payload", Base64.getEncoder().encodeToString(bytes)).put("signature", Base64.getEncoder().encodeToString(signer.sign())).toString().toByteArray()
    }
    @Test fun signedRawPayloadIsAuthenticatedBeforeTrustingAssets() {
        val bytes = envelope(manifest()); val verified = AppReleaseVerifier.verify(bytes, pem, UpdateConfig())
        assertEquals(6L, verified.asset("dev.mote.collector")!!.versionCode); assertNull(verified.asset("dev.mote.collector.dev"))
        val forged = JSONObject(String(bytes)).put("payload", Base64.getEncoder().encodeToString(manifest().put("version", "9.0.0").toString().toByteArray()))
        assertEquals("manifest_signature", assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(forged.toString().toByteArray(), pem, UpdateConfig()) }.code)
        assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(JSONObject(String(bytes)).put("keyId", "remote-supplied-key").toString().toByteArray(), pem, UpdateConfig()) }
        assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(bytes, pem, UpdateConfig("untrusted/mirror")) }
        assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(bytes, pem, UpdateConfig(channel = "preview")) }
        assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(bytes, pem, UpdateConfig(), "0.6.0") }
    }
    @Test fun schemaRejectsDuplicateIdentityWrongHostsAndNonIntegerVersion() {
        val wrongHost = manifest().apply { getJSONArray("assets").getJSONObject(0).put("url", "https://example.com/mote.apk") }
        val duplicate = manifest().apply { getJSONArray("assets").put(JSONObject(getJSONArray("assets").getJSONObject(0).toString()).put("name", "other.apk").put("url", "https://github.com/utopiafar/mote/releases/download/v0.5.0/other.apk")) }
        val fraction = manifest().apply { getJSONArray("assets").getJSONObject(0).put("versionCode", 6.5) }
        for (value in listOf(wrongHost, duplicate, fraction, manifest().put("publicKey", pem), manifest().put("tag", "v0.6.0")))
            assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(envelope(value), pem, UpdateConfig()) }
        assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(ByteArray(AppReleaseVerifier.MAX_MANIFEST + 1), pem, UpdateConfig()) }
    }
    @Test fun semverPrereleaseOrderingAndStrictRepository() {
        assertTrue(AppReleaseVerifier.compareVersions("0.5.0", "0.5.0-rc.10") > 0)
        assertTrue(AppReleaseVerifier.compareVersions("0.5.0-rc.10", "0.5.0-rc.2") > 0)
        assertTrue(AppReleaseVerifier.compareVersions("0.5.0-alpha-beta.2", "0.5.0-alpha-beta.1") > 0)
        assertFalse(AppReleaseVerifier.validVersion("0.5.0-01")); assertFalse(AppReleaseVerifier.validVersion("01.5.0"))
        assertThrows(UpdateFailure::class.java) { UpdateConfig("owner/repo/../../other").validate() }
    }
    @Test fun truncatedDownloadResumesExactlyAndRejectsChecksumOrUnsafeRedirect() {
        val directory = Files.createTempDirectory("update-fixture").toFile(); val part = java.io.File(directory, "fixture.part")
        val body = "合成应用下载字节，不是APK".repeat(100).toByteArray(); val hash = SourceRules.hash(String(body)); val asset = AppReleaseAsset("mote.apk", "https://github.com/utopiafar/mote/releases/download/v0.5.0/mote.apk", body.size.toLong(), hash, "dev.mote.collector", 6, "b".repeat(64))
        val first = body.copyOfRange(0, 50)
        try {
            assertThrows(IOException::class.java) { UpdateNetwork(open = { Fake(it, first, 200, mapOf("Content-Length" to body.size.toString())) }).download(asset, part) {} }
            assertEquals(50L, part.length())
            var resumed: Fake? = null
            UpdateNetwork(open = { Fake(it, body.copyOfRange(50, body.size), 206, mapOf("Content-Range" to "bytes 50-${body.size - 1}/${body.size}", "Content-Length" to (body.size - 50).toString())).also { value -> resumed = value } }).download(asset, part) {}
            assertEquals("bytes=50-", resumed!!.getRequestProperty("Range")); assertArrayEquals(body, part.readBytes())
            part.delete()
            assertThrows(UpdateFailure::class.java) { UpdateNetwork(open = { Fake(it, body, 200) }).download(asset.copy(sha256 = "0".repeat(64)), part) {} }; assertFalse(part.exists())
            assertThrows(UpdateFailure::class.java) { UpdateNetwork(open = { Fake(it, byteArrayOf(), 302, mapOf("Location" to "https://example.com/private")) }).bytes(asset.url, 100) }
            for (url in listOf("http://github.com/path", "https://github.com:8443/path", "https://secret@github.com/path", "https://api.github.com.evil.test/path")) assertThrows(UpdateFailure::class.java) { UpdateNetwork.validateUrl(URL(url)) }
        } finally { directory.deleteRecursively() }
    }
    @Test fun deeplyNestedUnsignedReleaseMetadataStopsBeforeFetchingTheManifest() {
        val nested = "[".repeat(64) + "0" + "]".repeat(64)
        val metadata = """{"draft":false,"prerelease":false,"tag_name":"v0.5.0","untrusted":$nested}""".toByteArray()
        val requested = mutableListOf<String>()
        val network = UpdateNetwork(open = { url -> requested.add(url.toString()); Fake(url, metadata, 200) })
        assertEquals("response", assertThrows(UpdateFailure::class.java) { network.check(UpdateConfig()) }.code)
        assertEquals(listOf("https://api.github.com/repos/utopiafar/mote/releases/latest"), requested)
    }
    @Test fun oversizedNestingInUnsignedManifestIsRejectedAsAnOrdinaryUpdateFailure() {
        val nested = "[".repeat(20000) + "0" + "]".repeat(20000)
        val raw = """{"schemaVersion":$nested,"keyId":"${AppReleaseVerifier.KEY_ID}","payload":"","signature":""}""".toByteArray()
        assertEquals("manifest", assertThrows(UpdateFailure::class.java) { AppReleaseVerifier.verify(raw, pem, UpdateConfig()) }.code)
    }
    private class Fake(url: URL, val bytes: ByteArray, val status: Int, val headers: Map<String, String> = emptyMap()) : HttpURLConnection(url) {
        override fun connect() = Unit; override fun disconnect() = Unit; override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getHeaderField(name: String) = headers[name]
        override fun getContentLengthLong() = headers["Content-Length"]?.toLong() ?: -1
    }
    companion object {
        private val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(3072) }.generateKeyPair()
        private val pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getEncoder().encodeToString(keys.public.encoded) + "\n-----END PUBLIC KEY-----"
    }
}
