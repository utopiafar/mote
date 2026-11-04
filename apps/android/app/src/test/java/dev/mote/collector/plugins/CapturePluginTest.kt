package dev.mote.collector.plugins

import dev.mote.collector.CaptureResume
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A stopped capture plugin withdraws every producer controller; a later
 * enable only re-admits the existing runtime and never registers providers or
 * services twice. */
class CapturePluginTest {
    private fun registry() = NativePluginRegistry().apply { CapturePlugin.register(this, "generated-build") }
    private fun host() = NativePluginHost(registry())

    @Test fun stoppingThePluginWithdrawsEveryProducerAndReEnableDoesNotDuplicateRegistration() {
        val host = host()
        val first = CapturePlugin.start(host)!!
        assertTrue(first.active)
        assertSame(first, CapturePlugin.controllers())
        val providers = host.registry.list().map { it.capability }
        assertEquals(listOf(CapturePlugin.PROJECTION_CAPABILITY, CapturePlugin.ACCESSIBILITY_CAPABILITY), providers)
        val services = host.scope(CapturePlugin.INSTANCE_ID)!!.services.keys.toSet()
        assertEquals(setOf("capture.pipeline", "capture.system-events", "capture.controls", "capture.reconfiguration"), services)

        assertEquals(CaptureResume.EXISTING_PROJECTION, first.reconfiguration.resume(true, true, "projection", true))
        assertEquals(CaptureResume.NEW_PROJECTION, first.reconfiguration.resume(true, true, "projection", false))
        first.reconfiguration.requestConsent()
        assertTrue(first.reconfiguration.takeConsentRequest())

        host.stopScope(CapturePlugin.INSTANCE_ID)

        assertFalse(first.active)
        assertNull(CapturePlugin.controllers())
        assertEquals(CaptureResume.STOPPED, first.reconfiguration.resume(true, true, "projection", true))
        first.reconfiguration.requestConsent()
        assertFalse("a stopped plugin cannot request projection consent", first.reconfiguration.takeConsentRequest())

        val second = CapturePlugin.start(host)!!
        assertTrue(second.active)
        assertSame(first, second)
        assertEquals(providers, host.registry.list().map { it.capability })
        assertEquals(1, host.registry.list().count { it.capability == CapturePlugin.PROJECTION_CAPABILITY })
        assertEquals(services, host.scope(CapturePlugin.INSTANCE_ID)!!.services.keys.toSet())

        host.stopScope(CapturePlugin.INSTANCE_ID)
        assertFalse(second.active)
    }

    @Test fun missingProvidersLeaveNoCaptureController() {
        val empty = NativePluginHost(NativePluginRegistry())
        assertNull(CapturePlugin.start(empty))
        assertNull(CapturePlugin.controllers())
    }
}
