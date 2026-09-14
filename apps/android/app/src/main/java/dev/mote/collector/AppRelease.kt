package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64

class UpdateFailure(val code: String) : Exception(code)
data class UpdateConfig(val repository: String = "utopiafar/mote", val channel: String = "stable", val wifiOnly: Boolean = true) {
    fun validate() { if (!repository.matches(Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")) || channel !in setOf("stable", "preview")) throw UpdateFailure("configuration") }
}
data class AppReleaseAsset(val name: String, val url: String, val size: Long, val sha256: String, val packageName: String, val versionCode: Long, val certificateSha256: String)
data class AppRelease(val version: String, val channel: String, val repository: String, val tag: String, val notesUrl: String, val assets: List<AppReleaseAsset>) {
    fun asset(packageName: String) = assets.singleOrNull { it.packageName == packageName }
}

/** Authenticates the exact raw payload bytes before interpreting any install metadata. */
object AppReleaseVerifier {
    const val KEY_ID = "mote-release-2026"
    const val MAX_MANIFEST = 262144
    private val sha = Regex("[a-f0-9]{64}")
    private val versionPattern = Regex("(0|[1-9]\\d{0,7})\\.(0|[1-9]\\d{0,7})\\.(0|[1-9]\\d{0,7})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?")
    fun validVersion(value: String): Boolean {
        if (value.length > 80 || !versionPattern.matches(value)) return false
        return value.substringAfter('-', "").split('.').all { !it.all(Char::isDigit) || it.length <= 1 || !it.startsWith('0') }
    }
    fun compareVersions(a: String, b: String): Int {
        if (!validVersion(a) || !validVersion(b)) throw UpdateFailure("manifest")
        val ac = a.substringBefore('-').split('.').map(String::toInt); val bc = b.substringBefore('-').split('.').map(String::toInt)
        for (i in 0..2) if (ac[i] != bc[i]) return ac[i].compareTo(bc[i])
        if (!a.contains('-') || !b.contains('-')) return if (a.contains('-') == b.contains('-')) 0 else if (a.contains('-')) -1 else 1
        val ap = a.substringAfter('-').split('.'); val bp = b.substringAfter('-').split('.')
        for (i in 0 until maxOf(ap.size, bp.size)) {
            if (i >= ap.size || i >= bp.size) return ap.size.compareTo(bp.size)
            if (ap[i] == bp[i]) continue
            val an = ap[i].all(Char::isDigit); val bn = bp[i].all(Char::isDigit)
            return if (an && bn) BigInteger(ap[i]).compareTo(BigInteger(bp[i])) else if (an != bn) { if (an) -1 else 1 } else ap[i].compareTo(bp[i])
        }
        return 0
    }
    fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    fun verify(raw: ByteArray, publicKeyPem: String, expected: UpdateConfig, expectedVersion: String? = null): AppRelease {
        expected.validate()
        try {
            check(raw.size <= MAX_MANIFEST)
            val envelope = JSONObject(utf8(raw)); exactKeys(envelope, setOf("schemaVersion", "keyId", "payload", "signature"))
            check(integer(envelope, "schemaVersion", 1, 1) == 1L && envelope.getString("keyId") == KEY_ID)
            val payload = decode(envelope.getString("payload"), 180000); val signature = decode(envelope.getString("signature"), 2000)
            val publicBytes = Base64.getDecoder().decode(publicKeyPem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").filterNot(Char::isWhitespace))
            val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(publicBytes))
            val verifier = Signature.getInstance("SHA256withRSA"); verifier.initVerify(key); verifier.update(payload)
            if (!verifier.verify(signature)) throw UpdateFailure("manifest_signature")
            val json = JSONObject(utf8(payload))
            exactKeys(json, setOf("schemaVersion", "version", "channel", "repository", "tag", "publishedAt", "notesUrl", "assets", "images"))
            val version = json.getString("version"); val tag = json.getString("tag"); val channel = json.getString("channel")
            check(integer(json, "schemaVersion", 1, 1) == 1L && validVersion(version) && tag == "v$version" && (expectedVersion == null || expectedVersion == version))
            check(json.getString("repository") == expected.repository && channel == expected.channel && (channel == "preview") == version.contains('-'))
            val notes = "https://github.com/${expected.repository}/releases/tag/$tag"; check(json.getString("notesUrl") == notes)
            check(!Instant.parse(json.getString("publishedAt")).isAfter(Instant.now().plusSeconds(86400)))
            val array = json.getJSONArray("assets"); check(array.length() in 1..20)
            val names = mutableSetOf<String>(); val identities = mutableSetOf<String>(); val android = mutableListOf<AppReleaseAsset>()
            for (i in 0 until array.length()) {
                val a = array.getJSONObject(i)
                exactKeys(a, setOf("component", "platform", "arch", "format", "name", "url", "size", "sha256", "versionCode", "packageName", "certificateSha256", "bundleId", "signing", "teamId"))
                val component = a.getString("component"); val platform = a.getString("platform"); val arch = a.getString("arch"); val format = a.getString("format")
                check(component in setOf("android", "desktop", "server") && platform in setOf("android", "darwin", "source") && arch in setOf("arm64", "x64", "all") && format in setOf("apk", "zip", "tar.gz"))
                val name = a.getString("name"); val url = a.getString("url"); val size = integer(a, "size", 1, 2_000_000_000)
                check(name.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,159}")) && names.add(name) && sha.matches(a.getString("sha256")))
                check(url == "https://github.com/${expected.repository}/releases/download/$tag/$name")
                check(identities.add(JSONArray(listOf(component, platform, arch, a.optString("packageName"), format)).toString()))
                if (component == "android") {
                    check(platform == "android" && format == "apk")
                    val packageName = a.getString("packageName"); val certificate = a.getString("certificateSha256")
                    check(packageName.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) && packageName.length <= 200 && sha.matches(certificate))
                    val asset = AppReleaseAsset(name, url, size, a.getString("sha256"), packageName, integer(a, "versionCode", 1, 2_100_000_000), certificate)
                    if (arch == "arm64") android.add(asset)
                }
                if (component == "desktop") check(platform == "darwin" && format == "zip" && a.getString("bundleId").isNotBlank() && a.getString("signing") in setOf("adhoc", "developer-id") && (a.getString("signing") != "developer-id" || a.getString("teamId").matches(Regex("[A-Z0-9]{10}"))))
                if (component == "server") check(platform == "source" && arch == "all" && format == "tar.gz")
            }
            val images = json.optJSONArray("images") ?: JSONArray(); check(images.length() <= 2)
            for (i in 0 until images.length()) { val image = images.getJSONObject(i); exactKeys(image, setOf("component", "image")); check(image.getString("component") == "server" && image.getString("image").matches(Regex(Regex.escape("ghcr.io/${expected.repository.lowercase()}@sha256:") + "[a-f0-9]{64}"))) }
            return AppRelease(version, channel, expected.repository, tag, notes, android)
        } catch (e: UpdateFailure) { throw e } catch (_: Exception) { throw UpdateFailure("manifest") }
    }
    private fun integer(json: JSONObject, field: String, min: Long, max: Long): Long {
        val number = json.get(field) as? Number ?: throw UpdateFailure("manifest")
        val value = number.toLong(); check(number.toDouble().isFinite() && number.toDouble() == value.toDouble() && value in min..max); return value
    }
    private fun decode(value: String, max: Int): ByteArray {
        check(value.length <= max); val bytes = Base64.getDecoder().decode(value); check(Base64.getEncoder().encodeToString(bytes) == value); return bytes
    }
    private fun exactKeys(json: JSONObject, allowed: Set<String>) { check(json.keys().asSequence().all { it in allowed }) }
}
