package dev.mote.collector

import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.PluginInstanceDescriptor
import dev.mote.collector.plugins.PluginInstanceIdentity
import dev.mote.collector.plugins.PluginOwnerSession
import dev.mote.collector.plugins.PluginResult
import dev.mote.collector.plugins.PluginViewContribution
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Typed view links resolve only against the exact package that owns a live
 * route. Disabling a package withdraws the page, retains the pinned reference
 * as reader fallback, and re-enabling restores the route without mounting it. */
class MoteLinkNavigationTest {
    private val origin = "https://central.example"
    private val ref = "capture:1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d"

    private fun scope(host: NativePluginHost, packageId: String): PluginOwnerSession {
        val identity = PluginInstanceIdentity(packageId, "install:$packageId", packageId)
        return (host.createScope(PluginInstanceDescriptor(identity, emptySet())) as PluginResult.Ok).value
    }

    private fun route(packageId: String, routeId: String) = MoteLink.Route.View(packageId, routeId, ref)

    @Test fun `a view route belongs to one package and a foreign package falls back to the reader`() {
        val host = NativePluginHost(NativePluginRegistry())
        val assistant = scope(host, "dev.mote.assistant")
        assistant.registerRoute("assistant.matters") { _, _ -> object : PluginViewContribution {
            override val routeId = "assistant.matters"
            override fun dispose() = Unit
        } }
        val foreign = route("dev.mote.other", "assistant.matters")
        assertTrue(MoteLinkNavigation.knownRoute(host, route("dev.mote.assistant", "assistant.matters")))
        assertFalse(MoteLinkNavigation.knownRoute(host, foreign))
        val foreignLink = MoteLink.Link(MoteLink.Scope(origin), foreign)
        assertEquals(MoteLink.Destination.Extras("assistant.matters"), MoteLinkNavigation.destination(host, MoteLink.Link(MoteLink.Scope(origin), route("dev.mote.assistant", "assistant.matters")), origin))
        assertEquals(MoteLink.Destination.Extras("ask", evidenceId = ref), MoteLinkNavigation.destination(host, foreignLink, origin))
    }

    @Test fun `refused deep links keep an explicit result instead of retargeting`() {
        val conversation = MoteLink.serialize(MoteLink.Scope(origin), MoteLink.Route.Conversation("6a1f2b3c-4d5e-46f7-8a9b-0c1d2e3f4a5b"))
        assertEquals(
            MoteLinkNavigation.Outcome.Open(MoteLink.Destination.Extras("ask", conversationId = "6a1f2b3c-4d5e-46f7-8a9b-0c1d2e3f4a5b")),
            MoteLinkNavigation.open(null, conversation, origin),
        )
        assertEquals(MoteLinkNavigation.Outcome.Refused(MoteLinkNavigation.Refusal.INVALID), MoteLinkNavigation.open(null, "not-a-link", origin))
        assertEquals(MoteLinkNavigation.Outcome.Refused(MoteLinkNavigation.Refusal.FOREIGN_SCOPE),
            MoteLinkNavigation.open(null, conversation, "https://other.example"))
        assertEquals(MoteLinkNavigation.Outcome.Refused(MoteLinkNavigation.Refusal.ACCESS_DENIED),
            MoteLinkNavigation.open(null, conversation, origin, granted = false))
        assertEquals(MoteLinkNavigation.Outcome.Refused(MoteLinkNavigation.Refusal.MISSING),
            MoteLinkNavigation.open(null, conversation, origin, exists = false))
    }

    @Test fun `a stopped workbench route still falls back to the pinned reader`() {
        val host = NativePluginHost(NativePluginRegistry())
        val packageId = "dev.mote.assistant"
        val view = route(packageId, "assistant.workbench")
        val link = MoteLink.serialize(MoteLink.Scope(origin), view)
        assertEquals(MoteLinkNavigation.Outcome.Open(MoteLink.Destination.Extras("ask", evidenceId = ref)),
            MoteLinkNavigation.open(host, link, origin))
        val owner = scope(host, packageId)
        owner.registerRoute("assistant.workbench") { _, _ -> object : PluginViewContribution {
            override val routeId = "assistant.workbench"
            override fun dispose() = Unit
        } }
        assertEquals(MoteLinkNavigation.Outcome.Open(MoteLink.Destination.Extras("assistant.workbench")),
            MoteLinkNavigation.open(host, link, origin))
    }

    @Test fun `stopping a package preserves the reference and re-enabling does not replay the page`() {
        val host = NativePluginHost(NativePluginRegistry())
        var mounts = 0
        val packageId = "dev.mote.assistant"
        val view = route(packageId, "assistant.workbench")
        fun start() {
            val owner = scope(host, packageId)
            owner.registerRoute("assistant.workbench") { _, _ ->
                mounts++
                object : PluginViewContribution {
                    override val routeId = "assistant.workbench"
                    override fun dispose() = Unit
                }
            }
        }
        start()
        assertEquals(MoteLink.Destination.Extras("assistant.workbench"), MoteLinkNavigation.destination(host, MoteLink.Link(MoteLink.Scope(origin), view), origin))
        assertEquals("resolving a route never mounts it", 0, mounts)

        host.stopScope(packageId)
        assertFalse(MoteLinkNavigation.knownRoute(host, view))
        assertEquals(MoteLink.Destination.Extras("ask", evidenceId = ref), MoteLinkNavigation.destination(host, MoteLink.Link(MoteLink.Scope(origin), view), origin))

        start()
        assertEquals(MoteLink.Destination.Extras("assistant.workbench"), MoteLinkNavigation.destination(host, MoteLink.Link(MoteLink.Scope(origin), view), origin))
        assertEquals("re-enabling restores the route only when the owner opens it", 0, mounts)
    }
}
