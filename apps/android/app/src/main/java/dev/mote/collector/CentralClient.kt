package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

internal class CentralFailure(val status: Int, val code: String = "", val detail: String = "") : IllegalStateException(when {
    status == 401 && code in setOf("", "unauthorized") -> MoteI18n.text("令牌无效或已失效，请检查后重新登录。")
    status == 403 && code in setOf("", "connection_scope_denied") -> MoteI18n.text("此令牌没有管理权限。请使用中央节点的管理令牌，设备配对凭据不能登录管理页面。")
    detail.isNotBlank() -> detail.take(2000)
    status in setOf(404, 410) -> MoteI18n.text("资料不存在或已删除。")
    else -> MoteI18n.text("中央请求失败（HTTP {0}），请稍后重试。", status)
})

/** Fixed-origin native transport. No collector credential, HTML, JS or redirects. */
internal class CentralClient(
    val server: String,
    private val token: String,
    private val transport: (String, String, ByteArray?, String, String) -> Pair<Int, JSONObject?> = { method, url, body, credential, mime ->
        HttpJson.requestBytes(method, url, body, credential, mime, 8 * 1024 * 1024)
    },
    private val active: () -> Boolean = { true },
    private val unauthorized: () -> Unit = {},
) {
    fun get(path: String) = request("GET", path)
    fun post(path: String, body: JSONObject = JSONObject()) = request("POST", path, body)
    fun put(path: String, body: JSONObject) = request("PUT", path, body)
    fun patch(path: String, body: JSONObject) = request("PATCH", path, body)
    fun delete(path: String, body: JSONObject? = null) = request("DELETE", path, body)
    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        bytes(method, path, body?.toString()?.toByteArray(Charsets.UTF_8), "application/json")
    fun bytes(method: String, path: String, body: ByteArray?, mime: String): JSONObject {
        checkActive()
        val (status, value) = transport(method, destination(path), body, token, mime)
        checkActive()
        if (status !in 200..299) fail(status, value)
        return value ?: if (status == 204) JSONObject() else throw IllegalStateException(MoteI18n.text("中央响应格式无效，请刷新后重试。"))
    }
    internal fun destination(path: String): String {
        val uri = URI(path)
        require(!uri.isAbsolute && uri.rawAuthority == null && uri.rawFragment == null && uri.rawPath.startsWith("/api/") &&
            uri.normalize().rawPath == uri.rawPath && !uri.path.contains('\\') && !uri.path.contains("/../") &&
            !uri.path.contains("/./") && path.none { it.code < 32 })
        return server.trimEnd('/') + path
    }
    fun download(path: String, output: java.io.OutputStream, maxBytes: Long = Long.MAX_VALUE) {
        checkActive()
        val connection = URL(destination(path)).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 120000
            connection.setRequestProperty("Authorization", "Bearer $token")
            val status = connection.responseCode
            if (status !in 200..299) fail(status)
            connection.inputStream.use { input ->
                val buffer = ByteArray(65536); var total = 0L
                while (true) {
                    checkActive(); val count = input.read(buffer); if (count < 0) break
                    total += count; require(total <= maxBytes) { MoteI18n.text("响应超过大小限制") }; output.write(buffer, 0, count)
                }
            }
            checkActive()
        } finally { connection.disconnect() }
    }
    fun image(path: String): ByteArray {
        checkActive()
        val connection = URL(destination(path)).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.setRequestProperty("Authorization", "Bearer $token")
            val status = connection.responseCode
            if (status !in 200..299) fail(status)
            require(connection.contentType?.startsWith("image/") == true)
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = input.read(buffer); if (count < 0) break
                    require(output.size() + count <= 12 * 1024 * 1024) { MoteI18n.text("响应超过大小限制") }; output.write(buffer, 0, count)
                }; output.toByteArray()
            }; checkActive(); return bytes
        } finally { connection.disconnect() }
    }
    private fun checkActive() { check(active()) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") } }
    private fun fail(status: Int, value: JSONObject? = null): Nothing {
        val code = value?.optString("error").orEmpty()
        if (status == 401 && code in setOf("", "unauthorized")) runCatching(unauthorized)
        throw CentralFailure(status, code, value?.optString("message").orEmpty())
    }
    override fun toString() = "CentralClient(credentials=redacted)"
}

/** One owner session shared by native central screens, isolated from Settings.token. */
internal class CentralSessionStore(private val file: File, private val cipher: ByteCipher, private val clock: () -> Long = System::currentTimeMillis,
    private val originActive: (String) -> Boolean = { true }) {
    private var origin = ""
    private var credential = ""
    private var expiresAt = 0L
    private var reuseBlocked = false
    private var triedCredential = ""
    @Volatile var generation = 0L; private set
    @Synchronized fun select(server: String) {
        val next = server.trim().trimEnd('/')
        if (origin == next) return
        origin = next; credential = ""; expiresAt = 0; reuseBlocked = false; triedCredential = ""; generation++
        if (file.exists()) {
            val value = runCatching { JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) }.getOrNull()
            if (value?.optString("server") == next) {
                reuseBlocked = true
                if (!value.optBoolean("signedOut") && value.optLong("expiresAt") > clock()) {
                    credential = value.getString("token"); expiresAt = value.getLong("expiresAt")
                }
            } else check(file.delete())
        }
    }
    @Synchronized fun signIn(server: String, token: String, durationMs: Long = 0, expectedGeneration: Long? = null) {
        check(expectedGeneration == null || expectedGeneration == generation) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
        check(originActive(server)) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
        require(token.length in 32..8192 && token.none { it == '\r' || it == '\n' })
        require(durationMs in setOf(0L, 86400000L, 7 * 86400000L, 30 * 86400000L))
        select(server)
        val deadline = if (durationMs == 0L) 0L else clock() + durationMs
        if (deadline == 0L) { if (file.exists()) check(file.delete()) }
        else {
            persist(JSONObject().put("server", origin).put("token", token).put("expiresAt", deadline))
        }
        credential = token; expiresAt = deadline; reuseBlocked = true; generation++
    }
    @Synchronized fun client(server: String): CentralClient? {
        if (server.trim().trimEnd('/') != origin) return null
        if (expiresAt != 0L && expiresAt <= clock()) signOut()
        val version = generation
        return credential.takeIf { it.isNotBlank() }?.let { CentralClient(origin, it, active = {
            synchronized(this) { generation == version && credential.isNotBlank() && (expiresAt == 0L || expiresAt > clock()) && originActive(origin) }
        }, unauthorized = { signOut(version) }) }
    }
    @Synchronized fun mayReuse(token: String): Boolean {
        if (reuseBlocked || token.length !in 32..8192 || triedCredential == SourceRules.hash(token)) return false
        triedCredential = SourceRules.hash(token); return true
    }
    @Synchronized fun retryReuse(token: String, expectedGeneration: Long) {
        if (expectedGeneration == generation && !reuseBlocked && triedCredential == SourceRules.hash(token)) triedCredential = ""
    }
    @Synchronized fun signOut(expectedGeneration: Long? = null) {
        if (expectedGeneration != null && expectedGeneration != generation) return
        credential = ""; expiresAt = 0; reuseBlocked = true; generation++
        try { persist(JSONObject().put("server", origin).put("signedOut", true)) }
        catch (error: Throwable) { file.delete(); throw error }
    }
    private fun persist(value: JSONObject) {
        file.parentFile!!.mkdirs(); val temp = File(file.parentFile, file.name + ".tmp")
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(value.toString().toByteArray())); it.fd.sync() }; check(temp.renameTo(file))
        } finally { temp.delete() }
    }
}

internal object CentralSession {
    private var store: CentralSessionStore? = null
    @Synchronized fun get(context: Context): CentralSessionStore = store ?: CentralSessionStore(
        File(context.applicationContext.noBackupFilesDir, "central-owner-session.enc"), SecretBox(), originActive = { origin ->
            val settings = Settings(context.applicationContext)
            settings.read().server.trim().trimEnd('/') == origin && settings.centralEndpoint().trim().trimEnd('/') == origin
        }
    ).also { store = it }
}

internal object CentralAccess {
    data class Selection(val server: String, val client: CentralClient?)
    /** Runs off the UI thread. Old configured owner tokens are verified before reuse. */
    fun resolve(context: Context): Selection {
        val settings = Settings(context); val config = settings.read()
        val endpoint = config.server.trim().trimEnd('/')
        val session = CentralSession.get(context)
        if (endpoint.isBlank() || settings.centralEndpoint().trim().trimEnd('/') != endpoint) {
            session.select(""); return Selection("", null)
        }
        PrivacyRules.validateEndpoint(endpoint, config.debugHttp, BuildConfig.DEBUG)
        session.select(endpoint)
        session.client(endpoint)?.let { return Selection(endpoint, it) }
        if (session.mayReuse(config.token)) {
            val generation = session.generation
            try {
                // This owner-only endpoint cannot promote a paired collector credential.
                CentralClient(endpoint, config.token).get("/api/configuration")
                session.signIn(endpoint, config.token, expectedGeneration = generation)
            } catch (failure: CentralFailure) {
                if (failure.status !in setOf(401, 403)) { session.retryReuse(config.token, generation); throw failure }
            } catch (failure: Throwable) {
                session.retryReuse(config.token, generation); throw failure
            }
        }
        return Selection(endpoint, session.client(endpoint))
    }
    fun requireClient(context: Context) = resolve(context).client ?: error(MoteI18n.text("请先登录中央节点，各页面会共用这次登录。"))
}
