package dev.mote.collector

import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.util.Base64

class ConnectionFailure(val category: String) : Exception(category)
data class ConnectionInvitation(val serverUrl: String, val code: String, val expiresAt: Instant) {
    override fun toString() = "ConnectionInvitation(redacted)"
    companion object {
        const val MAX_BYTES = 8192
        fun parse(input: String, debugHttp: Boolean, isDebug: Boolean, now: Instant = Instant.now()): ConnectionInvitation {
            try {
                require(input.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
                val text = input.trim().let { value ->
                    if (!value.startsWith("mote:")) value else {
                        val uri = URI(value)
                        require(uri.scheme == "mote" && uri.host == "connect" && uri.port == -1 && uri.rawUserInfo == null && uri.rawFragment == null && uri.rawPath.isNullOrEmpty())
                        val encoded = uri.rawQuery?.removePrefix("data=") ?: error("missing")
                        require(uri.rawQuery == "data=$encoded" && encoded.matches(Regex("[A-Za-z0-9_-]+")))
                        val bytes = Base64.getUrlDecoder().decode(encoded)
                        require(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == encoded)
                        AppReleaseVerifier.utf8(bytes)
                    }
                }
                require(text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES); StrictJson.validate(text)
                val json = JSONObject(text)
                require(json.keys().asSequence().toSet() == setOf("format", "version", "serverUrl", "code", "expiresAt"))
                require(json.get("format") == "mote.connection" && json.get("version") is Number && (json.get("version") as Number).toDouble() == 1.0)
                val server = json.get("serverUrl") as? String ?: error("server")
                require(server.length <= 2048 && server == server.trim() && server.none { it.isWhitespace() || it.code < 32 || it.code == 127 })
                val normalized = PrivacyRules.validateEndpoint(server, debugHttp, isDebug)
                val endpoint = URI(normalized)
                require(endpoint.scheme == "https" || endpoint.host in setOf("localhost", "127.0.0.1", "::1", "[::1]"))
                val code = json.get("code") as? String ?: error("code")
                require(code.matches(Regex("[A-Za-z0-9_-]{43}")))
                val expiry = json.get("expiresAt") as? String ?: error("expiry")
                require(expiry.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z")))
                val expires = Instant.parse(expiry)
                if (!expires.isAfter(now)) throw ConnectionFailure("expired")
                require(!expires.isAfter(now.plusSeconds(24 * 3600)))
                return ConnectionInvitation(normalized, code, expires)
            } catch (e: ConnectionFailure) { throw e } catch (_: Exception) { throw ConnectionFailure("invitation") }
        }
    }
}
