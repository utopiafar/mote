package dev.mote.collector

import dev.mote.collector.plugins.NativePluginHost

/** The one resolver for typed plugin view deep links. A view route is known
 * only when the exact package owns a live route; an unregistered, stopped or
 * foreign-package route falls back to the generic reader for the same pinned
 * reference. Resolving a route never mounts it. */
internal object MoteLinkNavigation {
    enum class Refusal(val messageKey: String) {
        INVALID("Mote 连接链接格式无效"),
        FOREIGN_SCOPE("Mote 连接链接格式无效"),
        ACCESS_DENIED("访问凭据已失效，请重新连接。"),
        MISSING("请求的资源不存在或已删除。"),
    }

    sealed interface Outcome {
        data class Open(val destination: MoteLink.Destination) : Outcome
        data class Refused(val reason: Refusal) : Outcome
    }

    fun knownRoute(host: NativePluginHost?, view: MoteLink.Route.View): Boolean =
        host?.route(view.packageId, view.routeId) != null

    fun destination(
        host: NativePluginHost?,
        link: MoteLink.Link,
        origin: String,
        granted: Boolean = true,
        exists: Boolean = true,
    ): MoteLink.Destination =
        MoteLink.destination(link, origin, granted, exists) { knownRoute(host, it) }

    /** A link that cannot open still produces a visible result. A malformed
     * link is never guessed into another object; foreign scope, revoked access
     * and missing state each keep their own refusal. Resolving does not mount
     * a route or perform a command. */
    fun open(
        host: NativePluginHost?,
        raw: String?,
        origin: String,
        granted: Boolean = true,
        exists: Boolean = true,
    ): Outcome {
        val link = raw?.let(MoteLink::parse) ?: return Outcome.Refused(Refusal.INVALID)
        return when (val resolution = MoteLink.resolve(link, origin, granted, exists) { knownRoute(host, it) }) {
            is MoteLink.Resolution.Keep -> when (val route = resolution.route) {
                is MoteLink.Route.Conversation -> Outcome.Open(MoteLink.Destination.Extras("ask", conversationId = route.id))
                is MoteLink.Route.Run -> Outcome.Open(MoteLink.Destination.Extras("activity", workId = route.id))
                is MoteLink.Route.Reference -> Outcome.Open(MoteLink.Destination.Extras("ask", conversationId = route.conversation, evidenceId = route.ref))
                is MoteLink.Route.View -> Outcome.Open(MoteLink.Destination.Extras(route.routeId))
            }
            is MoteLink.Resolution.Reader -> Outcome.Open(MoteLink.Destination.Extras("ask", evidenceId = resolution.ref))
            MoteLink.Resolution.ForeignScope -> Outcome.Refused(Refusal.FOREIGN_SCOPE)
            MoteLink.Resolution.Denied -> Outcome.Refused(Refusal.ACCESS_DENIED)
            MoteLink.Resolution.Missing -> Outcome.Refused(Refusal.MISSING)
        }
    }
}
