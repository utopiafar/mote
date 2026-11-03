package dev.mote.collector

import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.NativeWorkDiscoveryOwner
import dev.mote.collector.plugins.NativeWorkDiscoveryPlugin
import dev.mote.collector.plugins.PluginAvailability
import dev.mote.collector.plugins.PluginInstanceDescriptor
import dev.mote.collector.plugins.PluginInstanceIdentity
import dev.mote.collector.plugins.PluginOwnerSession
import dev.mote.collector.plugins.PluginResult
import org.junit.Assert.*
import org.junit.Test

/** Work and discovery are one plugin scope: the pages, their visible-page poll
 * loop and both home blocks disappear together when the scope is stopped. */
class NativeWorkDiscoveryPluginTest {
    private fun started(): Triple<NativePluginHost, PluginOwnerSession, NativeWorkDiscoveryOwner> {
        val registry = NativePluginRegistry().apply { NativeWorkDiscoveryPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeWorkDiscoveryPlugin.requirement()))
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.work-discovery", "generated-installation", NativeWorkDiscoveryPlugin.INSTANCE_ID)
        val scope = (host.createScope(
            PluginInstanceDescriptor(identity, setOf(NativeWorkDiscoveryPlugin.CAPABILITY), requires = listOf(NativeWorkDiscoveryPlugin.requirement())),
        ) as PluginResult.Ok).value
        return Triple(host, scope, NativeWorkDiscoveryPlugin.open(host, scope))
    }

    @Test fun `the build-native scope owns the pages the poll loop and the home blocks`() {
        val (_, scope, owner) = started()
        assertTrue(owner.active)
        assertEquals(setOf("work.activity", "work.insights", "work.discovery", "work.polling"), scope.services.keys)
        assertNotNull(owner.polling({ true }, {}, {}))
    }

    @Test fun `a hidden page never keeps a refresh armed`() {
        val (_, _, owner) = started()
        val scheduled = mutableListOf<Long>()
        var cancelled = 0
        var visible = true
        val polling = owner.polling({ visible }, { scheduled += it }, { cancelled++ })

        polling.rearm(WorkPolling.MS)
        assertEquals(listOf(WorkPolling.MS), scheduled)

        // Leaving the page: the pending refresh is cancelled and no hidden page
        // arms another one, even when a late response asks to rearm.
        visible = false
        polling.rearm(WorkPolling.MS)
        assertEquals("a hidden page scheduled no refresh", listOf(WorkPolling.MS), scheduled)
        assertEquals(2, cancelled)
        polling.stop()
        assertEquals("stopping cancels the pending refresh", 3, cancelled)

        visible = true
        polling.rearm(WorkPolling.TERMINAL_MS)
        assertEquals(listOf(WorkPolling.MS, WorkPolling.TERMINAL_MS), scheduled)
    }

    @Test fun `a stopped plugin publishes no home discovery or calendar block`() {
        val (host, _, _) = started()
        val active = NativeWorkDiscoveryPlugin.availability(host)
        assertTrue(active.active)
        assertEquals(
            listOf(NativeWorkDiscoveryPlugin.HomeSection.CALENDAR_NEEDS, NativeWorkDiscoveryPlugin.HomeSection.DISCOVERY),
            NativeWorkDiscoveryPlugin.homeSections(active),
        )

        host.stopScope(NativeWorkDiscoveryPlugin.INSTANCE_ID)
        val stopped = NativeWorkDiscoveryPlugin.availability(host)
        assertFalse(stopped.active)
        assertTrue("a stopped plugin hides both home blocks", NativeWorkDiscoveryPlugin.homeSections(stopped).isEmpty())
    }

    @Test fun `a missing provider is never reported as available`() {
        val registry = NativePluginRegistry()
        val host = NativePluginHost(registry)
        assertFalse(NativeWorkDiscoveryPlugin.availability(host).active)
        assertTrue(NativeWorkDiscoveryPlugin.homeSections(NativeWorkDiscoveryPlugin.availability(host)).isEmpty())
    }
}
