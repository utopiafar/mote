package dev.mote.collector

import dev.mote.collector.plugins.*
import org.junit.Assert.*
import org.junit.Test

private inline fun assertIllegal(block: () -> Unit) {
    try { block(); fail("expected rejection") } catch (expected: RuntimeException) {
        if (expected !is IllegalArgumentException && expected !is IllegalStateException) throw expected
    }
}

class NativePluginHostTest {
    private fun provider(id: String, version: String = "1") =
        NativePluginProvider(capability = id, apiVersion = version, buildId = "test-build")
    private fun descriptor(id: String, requires: List<NativeRequirement> = emptyList(), desired: Boolean = true, compatible: Boolean = true) =
        PluginInstanceDescriptor(PluginInstanceIdentity("pkg.$id", "inst:$id", id), setOf("cap.$id"), requires, desired, compatible)

    @Test fun `duplicate and foreign providers are rejected - missing requirement reports requires-build`() {
        val registry = NativePluginRegistry()
        registry.register(provider("mote.capture"))
        assertIllegal { registry.register(provider("mote.capture")) }
        assertIllegal { registry.register(provider("mote.capture").copy(platform = "mac")) }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeRequirement("mote.capture", "1")))
        assertEquals(PluginAvailability.REQUIRES_BUILD, registry.availability(NativeRequirement("mote.missing", "1")))

        val host = NativePluginHost(registry)
        val denied = host.createScope(descriptor("absent", requires = listOf(NativeRequirement("mote.missing", "1"))))
        assertTrue(denied is PluginResult.Failed)
        assertEquals("requires_build", (denied as PluginResult.Failed).code)
        assertNull("nothing fake-installed for a missing provider", host.scope("absent"))
    }

    @Test fun `half-initialized scope rolls back registrations while durable jobs and siblings survive`() {
        val host = NativePluginHost(NativePluginRegistry())
        val ok = (host.createScope(descriptor("ok")) as PluginResult.Ok).value
        ok.registerRoute("ok.route", "entry")
        val bad = (host.createScope(descriptor("bad")) as PluginResult.Ok).value
        var disposed = 0
        val outcome = host.startPlugin(bad) { scope ->
            scope.registerRoute("bad.route", "entry")
            scope.registerJob(PluginJob("transient"))
            scope.registerJob(PluginJob("upload-queue", durable = true))
            scope.defer { disposed++ }
            error("half init")
        }
        assertTrue(outcome is PluginResult.Failed)
        assertEquals("startup_failed", (outcome as PluginResult.Failed).code)
        assertEquals("pkg.bad", outcome.pluginId); assertEquals("bad", outcome.instanceId)
        assertTrue(bad.revoked)
        assertTrue(bad.routes.isEmpty() && bad.services.isEmpty())
        assertEquals(1, disposed)
        assertTrue("durable job stays tracked for drain", bad.jobs.containsKey("upload-queue"))
        assertFalse(bad.jobs.containsKey("transient"))
        assertEquals("sibling scope untouched", "entry", ok.routes["ok.route"])
    }

    @Test fun `view recreate disposes only the view - durable owner routes drafts and jobs stay`() {
        val host = NativePluginHost(NativePluginRegistry())
        val owner = (host.createScope(descriptor("capture")) as PluginResult.Ok).value
        owner.registerRoute("capture.page", "entry")
        owner.routeState["draft"] = "unfinished-note"
        owner.registerJob(PluginJob("durable-capture", durable = true))
        val view = owner.createView()
        var viewDisposed = 0
        view.defer { viewDisposed++ }
        view.registerView(object : PluginViewContribution {
            override val routeId = "capture.page"
            override fun dispose() { viewDisposed++ }
        })

        val next = host.onViewRecreated(owner)
        assertTrue(view.disposed)
        assertEquals("view callbacks and contributions revoked", 2, viewDisposed)
        assertSame(owner, next.owner)
        assertFalse(owner.revoked)
        assertEquals("entry", owner.routes["capture.page"])
        assertEquals("route/draft state survives recreate", "unfinished-note", owner.routeState["draft"])
        assertTrue("durable owner keeps running", owner.jobs.containsKey("durable-capture"))
        assertIllegal { view.registerView(object : PluginViewContribution { override val routeId = "x"; override fun dispose() {} }) }
    }

    @Test fun `quit fences admission - drains durable jobs - then revokes every scope`() {
        val host = NativePluginHost(NativePluginRegistry())
        val a = (host.createScope(descriptor("a")) as PluginResult.Ok).value
        var drained = 0
        a.registerJob(PluginJob("durable-a", durable = true, drain = { drained++ }))
        a.registerRoute("a.route", "entry")
        host.quit()
        assertEquals(1, drained)
        assertNull(host.scope("a"))
        assertTrue(a.revoked && a.routes.isEmpty())
        val denied = host.createScope(descriptor("late"))
        assertTrue(denied is PluginResult.Failed && denied.code == "closing")
    }
}
