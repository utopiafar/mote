package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.Base64

internal fun connectionFailureCategory(status: Int, body: JSONObject?): String = when (centralResponseFailureCode(body)) {
    "device_already_registered" -> "device_conflict"
    "incompatible_protocol" -> "protocol_incompatible"
    "origin_denied" -> "origin_denied"
    "invitation_invalid_or_expired", "login_expired" -> "expired"
    "invitation_claim_changed", "invitation_subject_mismatch", "invitation_device_mismatch", "login_owner_changed" -> "invite_rejected"
    else -> when (status) {
        400, 409, 415, 422 -> "response"
        410 -> "expired"
        401, 403 -> "invite_rejected"
        404 -> "not_found"
        426 -> "protocol_incompatible"
        429 -> "rate_limit"
        else -> "network"
    }
}

/** One encrypted recovery intent, persisted before claiming the fixed M01 subject. */
class ConnectionClient(private val context: Context) {
    private val settings = Settings(context)
    private val pending = File(context.noBackupFilesDir, "connection-pending.enc")
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    fun connect(invitation: ConnectionInvitation, deviceName: String, debugHttp: Boolean, bindLocal: Boolean = false) = ConnectionGuard.change(context, invitation.serverUrl, bindLocal) {
        recoverable {
            require(deviceName.isNotBlank() && deviceName.length <= 128)
            PrivacyRules.validateEndpoint(invitation.serverUrl, debugHttp, BuildConfig.DEBUG)
            if (invitation.deviceId != null && invitation.deviceId != settings.deviceId) throw ConnectionFailure("identity")
            val cached = if (pending.exists()) runCatching { readPending(debugHttp) }.getOrNull() else null
            val intent = if (cached?.getJSONObject("invitation")?.toString() == invitation.json().toString()) cached else {
                if (!invitation.expiresAt.isAfter(Instant.now())) throw ConnectionFailure("expired")
                val verifier = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })
                JSONObject().put("version", 2).put("invitation", invitation.json()).put("deviceId", settings.deviceId)
                    .put("deviceName", deviceName).put("verifier", verifier).also(::writePending)
            }
            complete(intent, debugHttp)
        }
    }.also { scheduleUploads() }
    fun pendingInvitation(debugHttp: Boolean): ConnectionInvitation? = if (!pending.exists()) null else readPending(debugHttp).getJSONObject("invitation").let { ConnectionInvitation.restore(it.toString(), debugHttp, BuildConfig.DEBUG) }
    fun pendingServer(): String? = pendingInvitation(settings.read().debugHttp)?.serverUrl
    private fun readPending(debugHttp: Boolean): JSONObject {
        if (!pending.exists() || pending.length() > 32768) throw ConnectionFailure("no_pending")
        val intent = JSONObject(AppReleaseVerifier.utf8(SecretBox().open(pending.readBytes())))
        require(intent.opt("version") == 2 && intent.getString("deviceId") == settings.deviceId)
        val invitation = ConnectionInvitation.restore(intent.getJSONObject("invitation").toString(), debugHttp, BuildConfig.DEBUG)
        require(invitation.deviceId == null || invitation.deviceId == settings.deviceId)
        require(intent.getString("verifier").matches(Regex("[A-Za-z0-9_-]{43}")))
        require(intent.getString("deviceName").let { it.isNotBlank() && it.length <= 128 })
        return intent
    }
    private fun writePending(intent: JSONObject) {
        val temp = File(pending.parentFile, "connection-pending.tmp")
        try {
            FileOutputStream(temp).use { it.write(SecretBox().seal(intent.toString().toByteArray(Charsets.UTF_8))); it.fd.sync() }
            if (!temp.renameTo(pending)) throw SettingsWriteFailure()
        } finally { temp.delete() }
    }
    fun resume(deviceName: String, debugHttp: Boolean, bindLocal: Boolean = false) {
        // The claimed name is immutable. The existing Save device name control can change it later.
        val intent = readPending(debugHttp); val invitation = ConnectionInvitation.restore(intent.getJSONObject("invitation").toString(), debugHttp, BuildConfig.DEBUG)
        ConnectionGuard.change(context, invitation.serverUrl, bindLocal) { recoverable { complete(intent, debugHttp) } }
        scheduleUploads()
    }
    private fun complete(intent: JSONObject, debugHttp: Boolean) {
        val invitation = ConnectionInvitation.restore(intent.getJSONObject("invitation").toString(), debugHttp, BuildConfig.DEBUG)
        val server = invitation.serverUrl; val verifier = intent.getString("verifier")
        if (!intent.has("requestId")) {
            if (!invitation.expiresAt.isAfter(Instant.now())) throw ConnectionFailure("expired")
            val claim = post(server, "/api/connections/redeem", JSONObject().put("code", invitation.code)
                .put("expected", invitation.subject()).put("deviceId", settings.deviceId).put("deviceName", intent.getString("deviceName"))
                .put("platform", "android").put("challenge", SourceRules.hash(verifier)))
            require(claim.getString("id").matches(Regex("[A-Za-z0-9_.:-]{1,128}")))
            deadline(claim.get("expiresAt"))
            intent.put("requestId", claim.getString("id")); writePending(intent)
        }
        val command = JSONObject().put("id", intent.getString("requestId")).put("verifier", verifier)
        val grant = intent.optJSONObject("grant") ?: post(server, "/api/login/poll", command).also {
            validateGrant(it, invitation); intent.put("grant", it); writePending(intent)
        }
        validateGrant(grant, invitation)
        val self = verifySelf(server, grant.getString("token"), grant.getString("credentialId"), invitation)
        val binding = AccountBinding.self(server, self)
        settings.saveConnection(server, grant.getString("token"), intent.getString("deviceName"), debugHttp, binding, grant.getLong("expiresAt"))
        require(settings.read().let { it.account() == binding && it.token == grant.getString("token") })
        // The credential is independent of the transient handoff. After restart/expiry,
        // ACK can be gone while this exact device credential is still live. Never
        // call that an ACK: reverify its current authority before retiring recovery.
        val (ackStatus, acknowledgement) = HttpJson.post(server + "/api/login/ack", command)
        val acknowledged = ackStatus == 200 && acknowledgement?.opt("acknowledged") == true
        if (!acknowledged) {
            if (ackStatus != 410 || acknowledgement?.opt("error") != "login_expired") {
                if (ackStatus in setOf(401, 403)) throw ConnectionFailure("authentication")
                throw ConnectionFailure(if (ackStatus == 200) "response" else "network")
            }
            verifySelf(server, grant.getString("token"), grant.getString("credentialId"), invitation)
        }
        if (!pending.delete()) throw SettingsWriteFailure()
        prefs.edit().putString("credentialId", grant.getString("credentialId")).putString("scope", "client").putBoolean("pairingAcknowledged", acknowledged)
            .putString("targetHash", SourceRules.target(server, grant.getString("token"))).putString("status", "connected").putLong("at", System.currentTimeMillis()).commit()
        Operations.record(context, OperationKind.CONNECTION_OK)
    }
    private fun deadline(value: Any): Long {
        require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble() && value.toLong() in 1..9007199254740991L)
        if (value.toLong() <= System.currentTimeMillis()) throw ConnectionFailure("expired")
        return value.toLong()
    }
    private fun validateGrant(body: JSONObject, invitation: ConnectionInvitation) {
        require(body.opt("ready") == true && body.opt("scope") == "client" && body.opt("purpose") == "device")
        require(body.opt("serverUrl") == invitation.serverUrl && body.opt("userId") == invitation.userId && body.opt("deploymentId") == invitation.deploymentId && body.opt("deviceId") == settings.deviceId)
        require((body.opt("token") as? String ?: "").matches(Regex("[A-Za-z0-9._~-]{32,2048}")))
        require((body.opt("credentialId") as? String ?: "").matches(Regex("[A-Za-z0-9_.:-]{1,128}")))
        deadline(body.get("expiresAt"))
    }
    private fun post(server: String, path: String, body: JSONObject): JSONObject {
        val (status, response) = HttpJson.post(server + path, body)
        if (status != 200) throw ConnectionFailure(connectionFailureCategory(status, response))
        return response ?: throw ConnectionFailure("response")
    }
    private fun <T> recoverable(work: () -> T): T = try { work() } catch (e: Exception) {
        val category = (e as? ConnectionFailure)?.category ?: if (e is SettingsWriteFailure) "storage" else if (e is java.io.IOException) "network" else "response"
        prefs.edit().putString("status", category).putLong("at", System.currentTimeMillis()).commit()
        Operations.record(context, OperationKind.CONNECTION_FAILED, reason = failureReason(category)); throw ConnectionFailure(category)
    }
    private fun scheduleUploads() {
        if (!ConnectionGuard.reconfiguring()) runCatching { UploadWorker.schedule(context, settings.read()) }
    }
    private fun verifySelf(server: String, token: String, credentialId: String? = null, invitation: ConnectionInvitation? = null): JSONObject {
        val (status, body) = HttpJson.get("$server/api/connections/self", token, ProtocolCompatibility.headers)
        if (status != 200) throw ConnectionFailure(if (status in setOf(401, 403)) "authentication" else connectionFailureCategory(status, body))
        if (body == null) throw ConnectionFailure("response")
        val binding = AccountBinding.self(server, body); val credential = body.getJSONObject("credential")
        if (credential.has("deviceId") && credential.optString("deviceId") != settings.deviceId) throw ConnectionFailure("identity")
        if (credentialId != null && body.getJSONObject("account").optString("credentialId") != credentialId) throw ConnectionFailure("identity")
        if (invitation != null && (binding != AccountBinding(invitation.serverUrl, invitation.deploymentId, invitation.userId) || credential.optString("kind") != "client" || credential.optString("deviceId") != settings.deviceId)) throw ConnectionFailure("identity")
        return body.put("scope", "client").put("binding", binding.json())
    }
    fun test(): String = ConnectionGuard.sync {
        val config = settings.read(); PrivacyRules.validateEndpoint(config.server, config.debugHttp, BuildConfig.DEBUG)
        recoverable {
            val credential = verifySelf(config.server, config.connectionToken()); val scope = credential.getString("scope")
            check(AccountBinding.self(config.server, credential) == config.account())
            prefs.edit().putString("status", "connected").putString("targetHash", SourceRules.target(config.server, config.token)).putString("scope", scope).putLong("at", System.currentTimeMillis()).commit()
            Operations.record(context, OperationKind.CONNECTION_OK); scope
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
