package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** Server/provider detail is untrusted. Only protocol codes select recovery advice. */
internal class CentralFailure(val status: Int, val code: String = "", val detail: String = "") : IllegalStateException(centralFailureMessage(status, code))

internal fun centralFailureMessage(status: Int, code: String): String {
    when (code) {
        "provider_quota" -> return MoteI18n.text("模型服务额度不足，请补充额度后继续。")
        "provider_authentication" -> return MoteI18n.text("模型服务认证失败，请检查凭据。")
        "provider_endpoint" -> return MoteI18n.text("模型服务地址不正确，请检查配置。")
        "provider_unavailable" -> return MoteI18n.text("模型服务暂时不可用，请检查服务配置。")
        "rate_limited" -> return MoteI18n.text("模型服务暂时限流，请等待任务更新。")
        "provider_timeout" -> return MoteI18n.text("请求等待超时，请查看任务状态。")
        "provider_network" -> return MoteI18n.text("连接暂时中断，请检查网络。")
        "origin_denied" -> return MoteI18n.text("当前网页地址未获中央允许。公开地址或反向代理配置不匹配。")
        "unauthorized", "connection_revoked" -> return MoteI18n.text("访问凭据已失效，请重新连接。")
        "forbidden", "connection_scope_denied" -> return MoteI18n.text("当前连接没有执行此操作的权限，请检查连接权限。")
        "login_expired" -> return MoteI18n.text("登录请求已失效或过期，请重新发起登录。")
        "invitation_invalid_or_expired" -> return MoteI18n.text("邀请无效、已使用或已过期，请在中央重新生成")
        "invitation_device_mismatch" -> return MoteI18n.text("邀请已失效、已使用或不匹配，请重新生成。")
        "login_pending" -> return MoteI18n.text("登录请求尚未获确认，请先在浏览器中完成授权。")
        "google_not_connected" -> return MoteI18n.text("尚未连接 Google 账号，请在对应来源设置中完成授权。")
        "incompatible_protocol" -> return MoteI18n.text("网页或客户端与中央的协议版本不匹配。")
        "invalid_request", "json_required" -> return MoteI18n.text("输入格式无效，请检查必填项和取值范围。")
        "invalid_data" -> if (status != 413) return MoteI18n.text("请求内容无效，请检查输入和当前操作状态。")
        "config_invalid" -> return MoteI18n.text("配置内容无效，请检查必填项和取值范围。")
        "config_conflict", "model_settings_conflict" -> return MoteI18n.text("配置或相关操作状态已变化，请重新读取后再确认。")
        "invalid_cursor" -> return MoteI18n.text("分页内容已变化或游标无效，请返回第一页重新读取。")
        "not_found", "connection_not_found", "task_not_found", "connector_not_found" -> return MoteI18n.text("请求的资源不存在或已删除。")
        "config_unavailable", "authentication_closed", "processing_closed", "actions_settings_unavailable" -> return MoteI18n.text("所需服务暂不可用。")
        "scope_unavailable" -> if (status != 403) return MoteI18n.text("所需服务暂不可用。")
    }
    // Invalid or absent codes use HTTP evidence; valid unknown codes remain diagnostic.
    if (code.matches(Regex("[a-z][a-z0-9_.-]{0,99}")) && code !in setOf("invalid_data", "scope_unavailable"))
        return MoteI18n.text("请求未完成（{0}）。错误码：{1}", status, code)
    return when (status) {
        401 -> MoteI18n.text("中央未接受当前登录身份（401）。登录信息可能已失效。")
        403 -> MoteI18n.text("请求被拒绝（403），请检查连接权限和入口访问配置。")
        404 -> MoteI18n.text("请求的接口或资源不存在，请检查节点地址和当前操作。")
        408, 504 -> MoteI18n.text("请求等待超时（{0}），请检查节点和网络状态后重试。", status)
        409 -> MoteI18n.text("操作状态已变化，请重新读取后再确认。")
        410 -> MoteI18n.text("请求的操作或资源已失效，请重新读取后再确认。")
        413 -> MoteI18n.text("请求内容超过中央或公网入口的大小限制（413）。")
        426 -> MoteI18n.text("网页或客户端与中央的协议版本不匹配。")
        429 -> MoteI18n.text("请求过于频繁，请稍后再试。")
        502 -> MoteI18n.text("入口暂时无法连接中央服务（502），请检查节点运行状态和入口转发配置。")
        503 -> MoteI18n.text("中央服务暂不可用（503），请检查节点状态后重试。")
        524 -> MoteI18n.text("入口等待服务响应超时（524）。请检查节点运行诊断；较慢的模型请求可能超过代理等待上限。")
        else -> MoteI18n.text("请求未完成（{0}）", status)
    }
}

internal fun centralResponseFailureCode(value: JSONObject?): String = listOf(value?.opt("reason"), value?.opt("code"), value?.optJSONObject("error")?.opt("code") ?: value?.opt("error"))
    .filterIsInstance<String>().firstOrNull { it.matches(Regex("[a-z][a-z0-9_.-]{0,99}")) }.orEmpty()

/** Fixed-origin native transport shared by every central feature. No HTML, JS or redirects. */
internal class CentralClient(
    val server: String,
    private val token: String,
    private val transport: (String, String, ByteArray?, String, String) -> Pair<Int, JSONObject?> = { method, url, body, credential, mime ->
        HttpJson.requestBytes(method, url, body, credential, mime, 8 * 1024 * 1024)
    },
    private val active: () -> Boolean = { true },
    private val unauthorized: () -> Unit = {},
) : CentralUploadClient {
    fun get(path: String) = request("GET", path)
    override fun post(path: String, body: JSONObject) = request("POST", path, body)
    fun put(path: String, body: JSONObject) = request("PUT", path, body)
    fun patch(path: String, body: JSONObject) = request("PATCH", path, body)
    fun delete(path: String, body: JSONObject? = null) = request("DELETE", path, body ?: JSONObject())
    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        bytes(method, path, body?.toString()?.toByteArray(Charsets.UTF_8), "application/json")
    override fun bytes(method: String, path: String, body: ByteArray?, mime: String): JSONObject {
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
        val code = centralResponseFailureCode(value)
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
    data class Selection(val server: String, val client: CentralClient?, val generation: Long)
    fun resolve(context: Context): Selection {
        val session = CentralSession.get(context)
        return synchronized(session) {
            val settings = Settings(context); val config = settings.read(); val endpoint = config.server.trim().trimEnd('/')
            if (endpoint.isBlank() || settings.centralEndpoint().trim().trimEnd('/') != endpoint) {
                session.select(""); return@synchronized Selection("", null, session.generation)
            }
            PrivacyRules.validateEndpoint(endpoint, config.debugHttp, BuildConfig.DEBUG)
            session.select(endpoint)
            Selection(endpoint, session.client(endpoint), session.generation)
        }
    }
    fun requireClient(context: Context) = resolve(context).client ?: error(MoteI18n.text("先登录中央，各页面会共用这次登录"))
}
