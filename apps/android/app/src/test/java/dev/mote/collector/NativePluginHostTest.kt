package dev.mote.collector

import dev.mote.collector.plugins.*
import org.junit.Assert.*
import org.junit.Test

private inline fun assertIllegal(block: () -> Unit) {
    try { block(); fail("expected rejection") } catch (expected: RuntimeException) {
        if (expected !is IllegalArgumentException && expected !is IllegalStateException) throw expected
    }
}

private fun stubView(id: String) = object : PluginViewContribution {
    override val routeId = id
    override fun dispose() { }
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

    @Test fun `builtin providers register in the APK registry with their OS grants`() {
        val registry = NativePluginRegistry().apply { registerBuiltinPlugins("test-build") }
        assertEquals(
            listOf("mote.capture.projection", "mote.capture.accessibility", "mote.durable-upload", "mote.system-entries", "mote.notes", "mote.ask", "mote.home", "mote.plugin-center"),
            registry.list().map { it.capability },
        )
        assertEquals(listOf("projection"), registry.provider("mote.capture.projection", "1")?.osGrants)
        assertEquals(listOf("accessibility"), registry.provider("mote.capture.accessibility", "1")?.osGrants)
        assertEquals(PluginAvailability.ACTIVE, PluginCenterPlugin.availability(registry))
        assertTrue(registry.list().all { it.buildId == "test-build" })
    }

    @Test fun `half-initialized scope rolls back registrations while durable jobs and siblings survive`() {
        val host = NativePluginHost(NativePluginRegistry())
        val ok = (host.createScope(descriptor("ok")) as PluginResult.Ok).value
        ok.registerRoute("ok.route") { _, _ -> stubView("ok.route") }
        val bad = (host.createScope(descriptor("bad")) as PluginResult.Ok).value
        var disposed = 0
        val outcome = host.startPlugin(bad) { scope ->
            scope.registerRoute("bad.route") { _, _ -> stubView("bad.route") }
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
        assertTrue("sibling scope untouched", ok.routes.containsKey("ok.route"))
    }

    @Test fun `view recreate disposes only the view - durable owner routes drafts and jobs stay`() {
        val host = NativePluginHost(NativePluginRegistry())
        val owner = (host.createScope(descriptor("capture")) as PluginResult.Ok).value
        owner.registerRoute("capture.page") { _, _ -> stubView("capture.page") }
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
        assertTrue(owner.routes.containsKey("capture.page"))
        assertEquals("route/draft state survives recreate", "unfinished-note", owner.routeState["draft"])
        assertTrue("durable owner keeps running", owner.jobs.containsKey("durable-capture"))
        assertIllegal { view.registerView(object : PluginViewContribution { override val routeId = "x"; override fun dispose() {} }) }
    }

    @Test fun `quit fences admission - drains durable jobs - then revokes every scope`() {
        val host = NativePluginHost(NativePluginRegistry())
        val a = (host.createScope(descriptor("a")) as PluginResult.Ok).value
        var drained = 0
        a.registerJob(PluginJob("durable-a", durable = true, drain = { drained++ }))
        a.registerRoute("a.route") { _, _ -> stubView("a.route") }
        host.quit()
        assertEquals(1, drained)
        assertNull(host.scope("a"))
        assertTrue(a.revoked && a.routes.isEmpty())
        val denied = host.createScope(descriptor("late"))
        assertTrue(denied is PluginResult.Failed && denied.code == "closing")
    }

    @Test fun `a cleanup failure in stopScope still frees the instance for restart`() {
        val host = NativePluginHost(NativePluginRegistry())
        val scope = (host.createScope(descriptor("notes")) as PluginResult.Ok).value
        scope.defer { throw RuntimeException("cleanup boom") }
        val errors = host.stopScope("notes")
        assertEquals(1, errors.size)
        assertNull(host.scope("notes"))
        assertTrue("instance restarts after failed cleanup", host.createScope(descriptor("notes")) is PluginResult.Ok)
    }

    @Test fun `quit fences job admission during drain while accepted drains complete`() {
        val host = NativePluginHost(NativePluginRegistry())
        val a = (host.createScope(descriptor("a")) as PluginResult.Ok).value
        var lateJob = false
        var drained = 0
        a.registerJob(PluginJob("first", durable = true, drain = {
            drained++
            try { a.registerJob(PluginJob("late", durable = true)); lateJob = true } catch (expected: RuntimeException) { }
        }))
        host.quit()
        assertEquals(1, drained)
        assertFalse("admission is fenced before draining", lateJob)
        assertTrue(a.revoked)
    }

    @Test fun `a registered route mounts its contribution before it is reported handled`() {
        val host = NativePluginHost(NativePluginRegistry())
        val owner = (host.createScope(descriptor("route")) as PluginResult.Ok).value
        var mounted = 0
        owner.registerRoute("route.page") { session, _ ->
            mounted++
            session.registerView(stubView("route.page"))
            stubView("route.page")
        }
        val factory = host.route("route.page")
        assertNotNull(factory)
        val session = host.onViewRecreated(owner)
        val contribution = factory!!.invoke(session, Any())
        assertEquals(1, mounted)
        assertEquals("route.page", contribution.routeId)
    }

    @Test fun `pause disposes the view while resume remounts through the same durable owner`() {
        val host = NativePluginHost(NativePluginRegistry())
        val owner = (host.createScope(descriptor("live")) as PluginResult.Ok).value
        owner.routeState["draft"] = "kept"
        var mounts = 0
        owner.registerRoute("live.page") { _, _ -> mounts++; stubView("live.page") }
        val view = owner.createView()
        // pause(): view callbacks revoked, owner/drafts/routes persist
        view.dispose()
        assertTrue(view.disposed && !owner.revoked && owner.routes.containsKey("live.page"))
        assertEquals("kept", owner.routeState["draft"])
        // resume(): same owner remounts a fresh view through the factory
        val next = host.onViewRecreated(owner)
        assertSame(owner, next.owner)
        assertFalse(next.disposed)
        val contribution = host.route("live.page")!!.invoke(next, Any())
        assertEquals("live.page", contribution.routeId)
    }
}
