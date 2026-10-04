package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

internal class CentralFailure(val status: Int, val code: String = "", val detail: String = "") : IllegalStateException(when {
    status == 401 && code in setOf("", "unauthorized") -> MoteI18n.text("令牌无效或已失效，请检查后重新登录。")
    status == 403 && code in setOf("", "connection_scope_denied") -> MoteI18n.text("此凭据不具备客户端权限，请升级中央节点或重新登录。")
    detail.isNotBlank() -> detail.take(2000)
    status in setOf(404, 410) -> MoteI18n.text("资料不存在或已删除。")
    else -> MoteI18n.text("中央请求失败（HTTP {0}），请稍后重试。", status)
})

/** Fixed-origin native transport shared by every central feature. No HTML, JS or redirects. */
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

/** Canonical Settings login supplies both collection transport and every central page. */
internal class UnifiedCentralSession(private val context: Context) {
    private var stamp = ""
    private var version = 0L
    private var selected = ""
    private val settings get() = Settings(context.applicationContext)
    @Synchronized private fun refresh(): CollectorConfig {
        val config = settings.read()
        val next = SourceRules.hash(listOf(config.server, config.token, config.authSignedOut.toString(), config.authExpiresAt.toString(), config.authProcess).joinToString("\u0000"))
        if (next != stamp) { stamp = next; version++ }
        return config
    }
    val generation: Long @Synchronized get() { refresh(); return version }
    @Synchronized fun select(server: String) { if (selected != server) { selected = server; version++ }; refresh() }
    @Synchronized fun client(server: String): CentralClient? {
        val config = refresh(); val token = config.connectionToken()
        if (server != config.server.trim().trimEnd('/') || server != settings.centralEndpoint().trim().trimEnd('/') || token.isBlank()) return null
        val expected = generation
        return CentralClient(server, token, active = { generation == expected && settings.read().connectionToken() == token }, unauthorized = { signOut(expected) })
    }
    @Synchronized fun signIn(server: String, token: String, durationMs: Long = 2592000000L, expectedGeneration: Long? = null) {
        check(expectedGeneration == null || generation == expectedGeneration) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
        val config = refresh()
        check(server == config.server.trim().trimEnd('/'))
        settings.signIn(server, token, durationMs); refresh()
    }
    @Synchronized fun signOut(expectedGeneration: Long? = null) {
        if (expectedGeneration != null && generation != expectedGeneration) return
        val config = refresh(); val token = config.connectionToken()
        settings.signOut(); refresh()
        if (token.isNotBlank()) runCatching { HttpJson.post(config.server + "/api/login/logout", JSONObject(), token) }
    }
}
internal object CentralSession {
    private var store: UnifiedCentralSession? = null
    @Synchronized fun get(context: Context): UnifiedCentralSession = store ?: UnifiedCentralSession(context.applicationContext).also { store = it }
}
internal object CentralAccess {
    data class Selection(val server: String, val client: CentralClient?)
    fun resolve(context: Context): Selection {
        val settings = Settings(context); val config = settings.read(); val endpoint = config.server.trim().trimEnd('/')
        val session = CentralSession.get(context)
        if (endpoint.isBlank() || settings.centralEndpoint().trim().trimEnd('/') != endpoint) { session.select(""); return Selection("", null) }
        PrivacyRules.validateEndpoint(endpoint, config.debugHttp, BuildConfig.DEBUG)
        session.select(endpoint)
        return Selection(endpoint, session.client(endpoint))
    }
    fun requireClient(context: Context) = resolve(context).client ?: error(MoteI18n.text("请先登录中央节点，各页面会共用这次登录。"))
}
