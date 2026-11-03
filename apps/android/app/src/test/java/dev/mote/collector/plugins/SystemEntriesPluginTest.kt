package dev.mote.collector.plugins

import dev.mote.collector.MoteQuickEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Disabling the native plugin removes every system entry and notification
 * action while the same scope state exposes the read-only reason. */
class SystemEntriesPluginTest {
    private fun started(): Pair<NativePluginHost, SystemEntriesOwner> {
        val registry = NativePluginRegistry().apply { SystemEntriesPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity(SystemEntriesPlugin.INSTANCE_ID, "generated-installation", SystemEntriesPlugin.INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(
            identity,
            setOf(SystemEntriesPlugin.CAPABILITY),
            requires = listOf(SystemEntriesPlugin.requirement()),
        )
        val scope = (host.createScope(descriptor) as PluginResult.Ok).value
        val owner = (host.startPlugin(scope) { SystemEntriesPlugin.open(it) } as PluginResult.Ok).value
        return host to owner
    }

    @Test fun builtinProviderRegistersForTheSystemEntryScope() {
        val registry = NativePluginRegistry().apply { SystemEntriesPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(SystemEntriesPlugin.requirement()))
        assertNotNull(registry.provider(SystemEntriesPlugin.CAPABILITY, SystemEntriesPlugin.API_VERSION))
    }

    @Test fun stoppingThePluginWithdrawsQuickEntriesAndNotificationActionsWithAReason() {
        val (host, owner) = started()
        val active = SystemEntriesPlugin.availability(host)
        assertTrue(active.active)
        assertEquals(MoteQuickEntry.entries, SystemEntriesPlugin.quickEntries(active))
        assertEquals(
            listOf(SystemEntriesPlugin.Action.PAUSE_SCREEN, SystemEntriesPlugin.Action.RECORD),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = true),
        )
        assertEquals(
            listOf(SystemEntriesPlugin.Action.STOP_CAPTURE, SystemEntriesPlugin.Action.RECORD),
            SystemEntriesPlugin.notificationActions(active, screenCapturing = false),
        )
        assertEquals(
            setOf("system-entries.notifications", "system-entries.quick", "system-entries.app-capture"),
            host.scope(SystemEntriesPlugin.INSTANCE_ID)!!.services.keys,
        )

        host.stopScope(SystemEntriesPlugin.INSTANCE_ID)

        val stopped = SystemEntriesPlugin.availability(host)
        assertFalse(stopped.active)
        assertTrue("the disabled plugin must explain itself", stopped.reason.orEmpty().isNotBlank())
        assertTrue(stopped.reason.orEmpty().contains("快捷入口"))
        assertTrue(owner.closed)
        assertTrue(SystemEntriesPlugin.quickEntries(stopped).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(stopped, screenCapturing = true).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(stopped, screenCapturing = false).isEmpty())
        assertEquals("Generated capture status\n" + stopped.reason, SystemEntriesPlugin.surfaceText(stopped, "Generated capture status"))
        assertEquals("Generated capture status", SystemEntriesPlugin.surfaceText(active, "Generated capture status"))
    }

    @Test fun missingProviderOrScopeNeverOffersASystemAction() {
        val missing = SystemEntriesPlugin.availability(NativePluginHost(NativePluginRegistry()))
        assertFalse(missing.active)
        assertTrue(missing.reason.orEmpty().isNotBlank())
        assertTrue(SystemEntriesPlugin.quickEntries(missing).isEmpty())
        assertTrue(SystemEntriesPlugin.notificationActions(missing, screenCapturing = true).isEmpty())

        val unloaded = SystemEntriesPlugin.availability(null)
        assertFalse(unloaded.active)
        assertTrue(unloaded.reason.orEmpty().isNotBlank())
    }
}
