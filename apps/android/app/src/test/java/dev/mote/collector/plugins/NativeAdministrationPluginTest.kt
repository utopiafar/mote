package dev.mote.collector.plugins

import dev.mote.collector.SettingsSummaryConfig
import dev.mote.collector.SettingsSummaryState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Administration is one build-native scope owning the Central manager, the
 * committed settings summary and the processing presentation. */
class NativeAdministrationPluginTest {
    private fun started(): Pair<NativePluginHost, AdministrationOwner> {
        val registry = NativePluginRegistry().apply { NativeAdministrationPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.administration", "generated-installation", NativeAdministrationPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeAdministrationPlugin.CAPABILITY), requires = listOf(NativeAdministrationPlugin.requirement()))) as PluginResult.Ok).value
        return host to NativeAdministrationPlugin.open(host, scope)
    }

    @Test fun builtinProviderRegistersTheAdministrationScopeAndServices() {
        val registry = NativePluginRegistry().apply { NativeAdministrationPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeAdministrationPlugin.requirement()))

        val (host, owner) = started()
        assertTrue(owner.active)
        assertEquals(
            setOf("administration.central", "administration.settings", "administration.runtime", "administration.connection"),
            host.scope(NativeAdministrationPlugin.INSTANCE_ID)!!.services.keys,
        )
        assertTrue(host.scope(NativeAdministrationPlugin.INSTANCE_ID)!!.jobs.containsKey("administration.summary"))
    }

    @Test fun settingsSummaryAndProcessingPresentationBelongToTheOwner() {
        val (host, owner) = started()
        val summary = owner.settingsSummary()
        val config = SettingsSummaryConfig("https://generated.invalid", syncPaused = true)
        summary.committed(config)
        assertEquals(SettingsSummaryState.Current(config), summary.state)
        assertEquals("等待你确认", owner.processing().stateKey("blocked", "awaiting_confirmation"))
        assertEquals("处理结果未知", owner.processing().stateKey("waiting", "processor_response_unknown"))

        host.stopScope(NativeAdministrationPlugin.INSTANCE_ID)
        assertFalse(owner.active)
        val stopped = runCatching { owner.processing() }
        assertTrue(stopped.isFailure)
    }
}
