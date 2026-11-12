package dev.mote.collector

import dev.mote.collector.plugins.NativePluginHost

/** The one resolver for typed plugin view deep links. A view route is known
 * only when the exact package owns a live route; an unregistered, stopped or
 * foreign-package route falls back to the generic reader for the same pinned
 * reference. Resolving a route never mounts it. */
internal object MoteLinkNavigation {
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
}
