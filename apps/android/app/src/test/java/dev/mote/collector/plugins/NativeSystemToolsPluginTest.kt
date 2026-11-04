package dev.mote.collector.plugins

import dev.mote.collector.CollectorConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** System tools own diagnostics, the safe support package policy and the
 * replacement-only update installer behind one build-native scope. */
class NativeSystemToolsPluginTest {
    private fun started(): Pair<NativePluginHost, SystemToolsOwner> {
        val registry = NativePluginRegistry().apply { NativeSystemToolsPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.system-tools", "generated-installation", NativeSystemToolsPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeSystemToolsPlugin.CAPABILITY), requires = listOf(NativeSystemToolsPlugin.requirement()))) as PluginResult.Ok).value
        return host to NativeSystemToolsPlugin.open(host, scope)
    }

    @Test fun builtinProviderRegistersTheSystemToolScopeAndServices() {
        val registry = NativePluginRegistry().apply { NativeSystemToolsPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeSystemToolsPlugin.requirement()))

        val (host, owner) = started()
        assertTrue(owner.active)
        assertEquals(
            setOf("system-tools.diagnostics", "system-tools.support", "system-tools.updates"),
            host.scope(NativeSystemToolsPlugin.INSTANCE_ID)!!.services.keys,
        )
        host.stopScope(NativeSystemToolsPlugin.INSTANCE_ID)
        assertFalse(owner.active)
    }

    @Test fun supportConfigurationIsAnAllowlistAndNeverCarriesSecrets() {
        val config = CollectorConfig(
            server = "https://generated-support.invalid",
            token = "generated-support-credential-0123456789",
            deviceName = "Generated private device name",
        )
        val safe = NativeSystemToolsPlugin.supportConfiguration(config)
        assertTrue(safe.getBoolean("configured"))
        assertTrue(safe.getBoolean("diagnosticsEnabled") == config.diagnosticsEnabled)
        val text = safe.toString()
        for (privateValue in listOf(config.server, config.token, config.deviceName)) {
            assertFalse("support configuration must omit $privateValue", text.contains(privateValue))
        }
        assertFalse(safe.has("server")); assertFalse(safe.has("token")); assertFalse(safe.has("deviceName"))
        assertEquals(0, NativeSystemToolsPlugin.supportConfiguration(null).length())
    }
}
