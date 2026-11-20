package dev.mote.collector

import java.net.URLEncoder
import java.net.URI
import org.json.JSONObject

/** Public destinations only. A caller cannot supply a host, arbitrary route,
 * script, credential, or another object's unvalidated query string. */
internal sealed interface AdvancedWebTarget {
    enum class RecordingTool(val query: String) { SPEAKERS("speakers"), COMPARE("compare"), RAW("raw") }
    enum class Preparation(val category: String, val role: String) { AUDIO("audio", "dialogue"), OCR("images", "ocr"), IMAGE("images", "local-image") }
    data class Recording(val id: String, val tool: RecordingTool) : AdvancedWebTarget {
        init { require(MoteLink.uuidId(id) == id) }
    }
    data class Models(val preparation: Preparation) : AdvancedWebTarget
    fun hash(): String = when (this) {
        is Recording -> "#/" + CentralPageRoutes.library + "?evidence=" + URLEncoder.encode("capture:$id", "UTF-8") + "&recordingTool=" + tool.query
        is Models -> "#/" + CentralPageRoutes.models + "?category=" + preparation.category + "&prepare=" + preparation.role
    }
}

internal data class AdvancedWebAccess(val server: String, val generation: Long, val authenticated: Boolean, val expiresAt: Long = 0)

/** A 401 still invokes CentralClient's existing logout. Its public target can
 * be offered on that login screen, never launched with the failed credential. */
internal sealed interface AdvancedWebResult {
    data class LoginRequired(val access: AdvancedWebAccess, val target: AdvancedWebTarget) : AdvancedWebResult
    class Ready internal constructor(private val selected: AdvancedWebAccess, val url: String, private val clock: () -> Long, private val deadline: Long? = null) : AdvancedWebResult {
        fun launch(current: () -> AdvancedWebAccess, visit: () -> Boolean, open: (String) -> Unit) {
            check(visit() && selected == current() && (!selected.authenticated || selected.expiresAt <= 0 || selected.expiresAt > clock()) && (deadline == null || deadline > clock())) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
            open(url)
        }
        override fun toString() = "AdvancedWebResult.Ready(url=redacted)"
    }
}

/** Public UI intent, separate from credential validity. The current page visit
 * may retain its target if logout polling wins the race with a 401 callback. */
internal class AdvancedWebIntent {
    private data class Request(val access: AdvancedWebAccess, val target: AdvancedWebTarget, val visit: () -> Boolean)
    @Volatile private var revision = 0L
    private var request: Request? = null
    var login: AdvancedWebResult.LoginRequired? = null; private set
    fun begin(access: AdvancedWebAccess, target: AdvancedWebTarget, pageVisit: () -> Boolean): () -> Boolean {
        val expected=++revision;val visit={expected==revision&&pageVisit()};login=null;request=Request(access,target,visit);return visit
    }
    fun observe(access: AdvancedWebAccess) {
        request?.let { selected ->
            if(selected.access.generation!=access.generation||selected.access.server!=access.server||!access.authenticated){
                request=null
                if(!access.authenticated&&selected.access.server==access.server&&selected.visit())login=AdvancedWebResult.LoginRequired(access,selected.target)
            }
        }
        if(login?.access!=access)login=null
    }
    fun retain(value: AdvancedWebResult.LoginRequired, visit: () -> Boolean) { check(visit());login=value;request=null }
    fun consumeLogin(origin: String, generation: Long): AdvancedWebTarget? {
        val target=login?.takeIf{it.access.server==origin&&it.access.generation==generation}?.target;cancel();return target
    }
    fun cancel() { revision++;request=null;login=null }
}

internal object AdvancedWebNavigation {
    fun prepare(target: AdvancedWebTarget, selected: AdvancedWebAccess, current: () -> AdvancedWebAccess, visit: () -> Boolean, clock: () -> Long = System::currentTimeMillis, ticket: () -> JSONObject): AdvancedWebResult {
        // CentralAccess already enforces the configured TLS/debug-HTTP policy.
        // Here the navigation boundary only accepts an exact node origin.
        val uri = URI(selected.server)
        require(uri.scheme in setOf("http", "https") && uri.host != null && uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in setOf("", "/") && uri.port in -1..65535)
        val origin = selected.server.trimEnd('/')
        fun active() { check(visit() && current() == selected && (!selected.authenticated || selected.expiresAt <= 0 || selected.expiresAt > clock())) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") } }
        active()
        val publicUrl = origin + "/" + target.hash()
        if (!selected.authenticated) return AdvancedWebResult.Ready(selected, publicUrl, clock)
        val deadline = clock() + 60000
        val response = try { ticket() } catch (error: CentralFailure) {
            if (error.status == 401) {
                val after = current()
                check(visit() && after.server == selected.server && !after.authenticated) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                return AdvancedWebResult.LoginRequired(after, target)
            }
            active()
            if (error.status == 403) return AdvancedWebResult.Ready(selected, publicUrl, clock)
            throw error
        }
        active()
        val code = response.optString("code")
        require(Regex("[A-Za-z0-9_-]{43}").matches(code)) { MoteI18n.text("中央响应格式无效，请刷新后重试。") }
        return AdvancedWebResult.Ready(selected, "$publicUrl&loginTicket=$code", clock, deadline)
    }
}
