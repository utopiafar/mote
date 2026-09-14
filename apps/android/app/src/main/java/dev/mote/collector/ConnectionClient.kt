package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant

/** The one-use exchange is journalled encrypted before testing or applying its credential. */
class ConnectionClient(private val context: Context) {
    private val settings = Settings(context)
    private val pending = File(context.noBackupFilesDir, "connection-pending.enc")
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    fun connect(invitation: ConnectionInvitation, deviceName: String, debugHttp: Boolean, bindLocal: Boolean = false) = ConnectionGuard.change(context, invitation.serverUrl, bindLocal) {
        try {
            require(deviceName.isNotBlank() && deviceName.length <= 128)
            PrivacyRules.validateEndpoint(invitation.serverUrl, debugHttp, BuildConfig.DEBUG)
            val hash = SourceRules.hash(invitation.code)
            val cached = if (pending.exists()) readPending() else null
            val response = if (cached?.optString("invitationHash") == hash && cached.optString("deviceId") == settings.deviceId && cached.optString("serverUrl") == invitation.serverUrl) cached else {
                if (!invitation.expiresAt.isAfter(Instant.now())) throw ConnectionFailure("expired")
                val (status, body) = HttpJson.post("${invitation.serverUrl}/api/connections/redeem", JSONObject().put("code", invitation.code)
                    .put("deviceId", settings.deviceId).put("deviceName", deviceName).put("platform", "android"))
                if (status !in 200..299) throw ConnectionFailure(when (status) { 409 -> "device_conflict"; 410 -> "expired"; 401, 403 -> "invite_rejected"; 429 -> "rate_limit"; else -> "network" })
                validateResponse(body, invitation.serverUrl)
                body!!.put("invitationHash", hash).put("deviceId", settings.deviceId)
                val temp = File(pending.parentFile, "connection-pending.tmp")
                try { FileOutputStream(temp).use { it.write(SecretBox().seal(body.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }; check(temp.renameTo(pending)) }
                finally { temp.delete() }
                body
            }
            validateResponse(response, invitation.serverUrl)
            applyResponse(response, deviceName, debugHttp)
        } catch (e: Exception) {
            val category = (e as? ConnectionFailure)?.category ?: if (e is SettingsWriteFailure) "storage" else if (e is java.io.IOException) "network" else "response"
            prefs.edit().putString("status", category).putLong("at", System.currentTimeMillis()).commit()
            Operations.record(context, OperationKind.CONNECTION_FAILED, reason = failureReason(category))
            throw ConnectionFailure(category)
        }
    }
    fun pendingServer(): String? {
        if (!pending.exists()) return null
        val response = readPending(); return response.getString("serverUrl")
    }
    private fun readPending(): JSONObject {
        if (!pending.exists() || pending.length() > 16384) throw ConnectionFailure("no_pending")
        val response = JSONObject(String(SecretBox().open(pending.readBytes()), Charsets.UTF_8))
        if (response.optString("deviceId") != settings.deviceId) throw ConnectionFailure("identity")
        return response
    }
    fun resume(deviceName: String, debugHttp: Boolean, bindLocal: Boolean = false) {
        val response = readPending(); val server = response.getString("serverUrl")
        ConnectionGuard.change(context, server, bindLocal) {
            PrivacyRules.validateEndpoint(server, debugHttp, BuildConfig.DEBUG)
            validateResponse(response, server); applyResponse(response, deviceName, debugHttp)
        }
    }
    private fun applyResponse(response: JSONObject, deviceName: String, debugHttp: Boolean) {
        require(deviceName.isNotBlank() && deviceName.length <= 128)
        val server = response.getString("serverUrl")
        verifySelf(server, response.getString("token"), response.getString("credentialId"))
        settings.saveConnection(server, response.getString("token"), deviceName, debugHttp)
        check(settings.read().let { it.server == server && it.token == response.getString("token") })
        prefs.edit().putString("credentialId", response.getString("credentialId")).putString("scope", "collector").putString("targetHash", SourceRules.target(server, response.getString("token"))).putString("status", "connected").putLong("at", System.currentTimeMillis()).commit()
        pending.delete(); Operations.record(context, OperationKind.CONNECTION_OK)
        runCatching { UploadWorker.schedule(context, settings.read()); SourceWork.upload(context) }
    }
    private fun validateResponse(body: JSONObject?, server: String) {
        if (body == null || body.opt("scope") != "collector" || body.opt("serverUrl") != server ||
            !(body.opt("token") as? String ?: "").matches(Regex("[A-Za-z0-9._~-]{32,2048}")) ||
            !(body.opt("credentialId") as? String ?: "").matches(Regex("[A-Za-z0-9_.:-]{1,128}"))) throw ConnectionFailure("response")
    }
    private fun verifySelf(server: String, token: String, credentialId: String? = null): JSONObject {
        val (status, body) = HttpJson.get("$server/api/connections/self", token)
        if (status !in 200..299) throw ConnectionFailure(if (status in setOf(401, 403)) "authentication" else "network")
        val credential = body?.optJSONObject("credential") ?: throw ConnectionFailure("response")
        val scope = credential.opt("scope")
        if (scope !in setOf("owner", "collector") || (credentialId != null && (scope != "collector" || credential.opt("id") != credentialId)) ||
            (scope == "collector" && (credential.opt("deviceId") != settings.deviceId || credential.opt("platform") != "android" || credential.opt("serverUrl") != server)) ||
            body.optJSONObject("capabilities")?.opt("ingest") != true) throw ConnectionFailure("identity")
        return credential
    }
    fun test(): String = ConnectionGuard.sync {
        val config = settings.read(); PrivacyRules.validateEndpoint(config.server, config.debugHttp, BuildConfig.DEBUG)
        try {
            val credential = verifySelf(config.server, config.token)
            val scope = credential.getString("scope")
            prefs.edit().putString("status", "connected").putString("targetHash", SourceRules.target(config.server, config.token)).putString("scope", scope).putLong("at", System.currentTimeMillis()).commit()
            Operations.record(context, OperationKind.CONNECTION_OK); scope
        } catch (e: Exception) {
            val category = (e as? ConnectionFailure)?.category ?: "network"
            prefs.edit().putString("status", category).putLong("at", System.currentTimeMillis()).commit()
            Operations.record(context, OperationKind.CONNECTION_FAILED, reason = failureReason(category)); throw ConnectionFailure(category)
        }
    } ?: throw ConnectionFailure("busy")
    fun status(): String = if (prefs.getString("targetHash", "") != settings.read().let { SourceRules.target(it.server, it.token) }) "unchecked" else prefs.getString("status", "unchecked")!!
    fun statusAt(): Long = prefs.getLong("at", 0)
    fun scope(): String = prefs.getString("scope", "unknown")!!
    private fun failureReason(category: String) = when (category) {
        "authentication", "invite_rejected" -> OperationReason.AUTH
        "network" -> OperationReason.NETWORK
        "storage" -> OperationReason.STORAGE
        else -> OperationReason.RESPONSE
    }
}
