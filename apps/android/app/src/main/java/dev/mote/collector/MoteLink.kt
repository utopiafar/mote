package dev.mote.collector

import java.net.URI

/** Android mirror of the shared deep-link schema (packages/shared deep-link.ts):
 * one link carries an instance scope plus a typed route over the same hash
 * vocabulary every end emits and parses. Links address committed central
 * state only — never credentials, drafts or body text. Kept JVM-safe so the
 * route/scope rules test without a device. */
object MoteLink {
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val material = Regex("material:mat_[a-f0-9]{64}@[a-f0-9]{64}")
    private val controls = Regex("[\\u0000-\\u001f\\u007f]")
    private val token = Regex("[\\x21-\\x7e]{1,256}")

    data class Scope(val origin: String)

    sealed interface Route {
        data class Conversation(val id: String) : Route
        data class Run(val id: String) : Route
        data class Reference(val ref: String, val conversation: String? = null) : Route
        data class View(val packageId: String, val routeId: String, val ref: String) : Route
    }

    data class Link(val scope: Scope, val route: Route)

    sealed interface Resolution {
        data class Keep(val route: Route) : Resolution
        data class Reader(val ref: String) : Resolution
        object ForeignScope : Resolution
        object Denied : Resolution
        object Missing : Resolution
    }

    /** Resolution projected onto the existing guarded intent extras. */
    sealed interface Destination {
        data class Extras(val page: String, val conversationId: String? = null, val evidenceId: String? = null) : Destination
        object None : Destination
    }

    fun uuidId(value: String): String? = if (uuid.matches(value)) value.lowercase() else null
    fun runId(value: String): Boolean = value.isNotBlank() && value.length <= 512 && !controls.containsMatchIn(value)

    /** Percent-decode like JS decodeURIComponent: '+' stays literal. */
    private fun uriDecode(value: String): String? {
        val out = java.io.ByteArrayOutputStream(value.length)
        val chars = StringBuilder()
        var i = 0
        fun flush() { if (out.size() > 0) { chars.append(out.toString("UTF-8")); out.reset() } }
        while (i < value.length) {
            val c = value[i]
            if (c == '%') {
                if (i + 2 >= value.length) return null
                val hi = value[i + 1].digitToIntOrNull(16) ?: return null
                val lo = value[i + 2].digitToIntOrNull(16) ?: return null
                out.write(hi * 16 + lo); i += 3
            } else { flush(); chars.append(c); i++ }
        }
        flush(); return chars.toString()
    }

    /** Percent-encode like JS encodeURIComponent. */
    private fun uriComponentEncode(value: String): String {
        val unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        val out = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val i = b.toInt() and 0xFF
            if (i.toChar() in unreserved) out.append(i.toChar())
            else out.append('%').append("0123456789ABCDEF"[i shr 4]).append("0123456789ABCDEF"[i and 15])
        }
        return out.toString()
    }

    /** Typed public references shared across ends. */
    fun reference(value: String): String? {
        if (value.length > 1600) return null
        val trimmed = value.trim()
        val kind = trimmed.substringBefore(':')
        if (kind.equals("capture", true) || kind.equals("memory", true)) {
            val id = trimmed.substringAfter(':')
            if (uuid.matches(id)) return "${kind.lowercase()}:${id.lowercase()}"
        }
        if (material.matches(trimmed)) return trimmed
        if (trimmed.startsWith("artifact:")) {
            val parts = trimmed.substringAfter(':').split(':', limit = 2)
            if (parts.size == 2) {
                val id = uriDecode(parts[0]); val revision = uriDecode(parts[1])
                if (id != null && revision != null && id.isNotEmpty() && revision.isNotEmpty() && id.length <= 128 && revision.length <= 128 &&
                    uriComponentEncode(id) == parts[0] && uriComponentEncode(revision) == parts[1]) return trimmed
            }
        }
        return null
    }

    private fun validate(route: Route): Route {
        when (route) {
            is Route.Conversation -> require(uuidId(route.id) != null) { "Invalid conversation" }
            is Route.Run -> require(runId(route.id)) { "Invalid run" }
            is Route.Reference -> {
                require(reference(route.ref) == route.ref) { "Invalid reference" }
                require(route.conversation == null || uuidId(route.conversation) != null) { "Invalid conversation" }
            }
            is Route.View -> require(token.matches(route.packageId) && token.matches(route.routeId) && reference(route.ref) == route.ref) { "Invalid view route" }
        }
        return route
    }

    private fun encode(value: String): String {
        val out = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val i = b.toInt() and 0xFF
            val c = i.toChar()
            if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '*' || c == '-' || c == '.' || c == '_') out.append(c)
            else if (c == ' ') out.append('+')
            else out.append('%').append("0123456789ABCDEF"[i shr 4]).append("0123456789ABCDEF"[i and 15])
        }
        return out.toString()
    }

    /** Canonical hash form shared with the central surface. */
    fun hash(route: Route): String = when (val r = validate(route)) {
        is Route.Conversation -> "#/ask?conversation=" + encode(r.id)
        is Route.Run -> "#/activity?work=" + encode(r.id)
        is Route.Reference -> "#/ask?evidence=" + encode(r.ref) + (r.conversation?.let { "&conversation=" + encode(it) } ?: "")
        is Route.View -> "#/view?package=" + encode(r.packageId) + "&route=" + encode(r.routeId) + "&evidence=" + encode(r.ref)
    }

    private fun query(text: String): Map<String, List<String>>? {
        val out = LinkedHashMap<String, MutableList<String>>()
        for (pair in text.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val pairOut = runCatching {
                val k = java.net.URLDecoder.decode(if (eq < 0) pair else pair.substring(0, eq), "UTF-8")
                val v = java.net.URLDecoder.decode(if (eq < 0) "" else pair.substring(eq + 1), "UTF-8")
                out.getOrPut(k) { mutableListOf() }.add(v)
            }
            if (pairOut.isFailure) return null
        }
        return out
    }

    /** Parse the shared hash vocabulary; defining keys must appear once. */
    fun parseHash(value: String?): Route? {
        if (value == null || !value.startsWith('#')) return null
        var target = value.substring(1)
        if (target.isNotEmpty() && !target.startsWith('/')) target = "/$target"
        val at = target.indexOf('?')
        val path = if (at < 0) target else target.substring(0, at)
        val params = query(if (at < 0) "" else target.substring(at + 1)) ?: return null
        for (key in listOf("evidence", "conversation", "work", "package", "route")) if ((params[key]?.size ?: 0) > 1) return null
        val evidence = params["evidence"]?.firstOrNull()
        val conversation = params["conversation"]?.firstOrNull()
        return when (path) {
            "/ask" -> when {
                evidence != null -> {
                    val ref = reference(evidence) ?: return null
                    if (conversation == null) Route.Reference(ref) else uuidId(conversation)?.let { Route.Reference(ref, it) }
                }
                conversation != null -> uuidId(conversation)?.let { Route.Conversation(it) }
                else -> null
            }
            "/activity" -> params["work"]?.firstOrNull()?.takeIf(::runId)?.let { Route.Run(it) }
            "/view" -> {
                val p = params["package"]?.firstOrNull(); val r = params["route"]?.firstOrNull()
                if (p == null || r == null || evidence == null || !token.matches(p) || !token.matches(r)) null
                else reference(evidence)?.let { Route.View(p, r, it) }
            }
            else -> null
        }
    }

    private fun origin(u: URI): String? {
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host ?: return null
        val local = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
        if (scheme != "https" && !(scheme == "http" && local)) return null
        if (u.userInfo != null || u.rawQuery != null) return null
        if (u.rawPath != "" && u.rawPath != "/") return null
        val port = u.port
        return "$scheme://${host.lowercase()}${if (port >= 0 && port != if (scheme == "https") 443 else 80) ":$port" else ""}"
    }

    /** Canonical origin of a configured node address. */
    fun scopeOrigin(value: String): String? {
        val u = runCatching { URI(value.trim()) }.getOrNull() ?: return null
        if (u.rawFragment != null) return null
        return origin(u)
    }

    fun serialize(scope: Scope, route: Route): String {
        val origin = scopeOrigin(scope.origin) ?: throw IllegalArgumentException("Mote links need an https or loopback http origin")
        return origin + "/" + hash(route)
    }

    /** Strictly parse a serialized link; anything else returns null instead of
     * guessing at another object. */
    fun parse(value: String): Link? {
        if (value.isBlank() || value != value.trim() || value.length > 2048) return null
        val u = runCatching { URI(value) }.getOrNull() ?: return null
        val origin = origin(u) ?: return null
        if (u.rawPath != "/" && u.rawPath != "" || u.rawFragment == null) return null
        val route = parseHash("#" + u.rawFragment) ?: return null
        return Link(Scope(origin), route)
    }

    /** Resolve against the answering end's live registries: foreign scope
     * stays foreign, revoked access is denied, a deleted record stays missing
     * and an unregistered view falls to the generic reader for the same ref. */
    fun resolve(link: Link, origin: String, granted: Boolean = true, exists: Boolean = true, knownRoute: ((Route.View) -> Boolean)? = null): Resolution {
        if (scopeOrigin(origin) != link.scope.origin) return Resolution.ForeignScope
        if (!granted) return Resolution.Denied
        if (!exists) return Resolution.Missing
        val r = link.route
        if (r is Route.View && knownRoute != null && !knownRoute(r)) return Resolution.Reader(r.ref)
        return Resolution.Keep(r)
    }

    fun destination(link: Link, origin: String, granted: Boolean = true, exists: Boolean = true, knownRoute: ((Route.View) -> Boolean)? = null): Destination = when (val r = resolve(link, origin, granted, exists, knownRoute)) {
        is Resolution.Keep -> when (val route = r.route) {
            is Route.Conversation -> Destination.Extras("ask", conversationId = route.id)
            is Route.Run -> Destination.Extras("activity")
            is Route.Reference -> Destination.Extras("ask", conversationId = route.conversation, evidenceId = route.ref)
            is Route.View -> Destination.Extras(route.routeId)
        }
        is Resolution.Reader -> Destination.Extras("ask", evidenceId = r.ref)
        else -> Destination.None
    }
}
