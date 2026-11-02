package dev.mote.collector.plugins

/** The Android plugin host: scopes own their routes, services, view sessions
 * and jobs. A view dies with its Activity; the durable owner (capture
 * service, workers, drafts, route state) survives recreate. A half-failed
 * startup rolls back only that scope; durable work is never dropped by a
 * rollback, and an explicit quit drains durable jobs before disposing. */
class PluginOwnerSession internal constructor(
    val host: NativePluginHost,
    val identity: PluginInstanceIdentity,
    val capabilities: Set<String>,
) {
    internal val jobs = LinkedHashMap<String, PluginJob>()
    internal val routes = LinkedHashMap<String, PluginRouteFactory>()
    internal val services = LinkedHashMap<String, PluginServiceRegistration>()
    internal val disposers = mutableListOf<() -> Unit>()
    internal var revoked = false
    /** Route and draft state survive view recreation with the owner. */
    val routeState = mutableMapOf<String, String>()
    var view: PluginViewSession? = null; internal set

    /** A route owns how its contribution mounts into the shell container;
     * the host never reports a route handled before the mount succeeds. */
    fun registerRoute(routeId: String, factory: PluginRouteFactory) {
        check(!revoked) { "scope is revoked" }
        require(!routes.containsKey(routeId)) { "route already registered: $routeId" }
        routes[routeId] = factory
    }

    fun registerService(service: PluginServiceRegistration) {
        check(!revoked) { "scope is revoked" }
        require(!services.containsKey(service.id)) { "service already registered: ${service.id}" }
        services[service.id] = service
    }

    fun registerJob(job: PluginJob) {
        check(!revoked) { "scope is revoked" }
        require(!jobs.containsKey(job.id)) { "job already registered: ${job.id}" }
        jobs[job.id] = job
    }

    fun defer(dispose: () -> Unit) { disposers += dispose }

    /** A new view scope for this owner — Activity recreate swaps only this. */
    fun createView(): PluginViewSession {
        check(!revoked) { "scope is revoked" }
        view?.dispose()
        return PluginViewSession(this).also { view = it }
    }
}

data class PluginJob(val id: String, val durable: Boolean = false, val drain: (() -> Unit)? = null)

/** Mounts this route's contribution into the shell container. The container
 * is typed loosely so the ports stay JVM-testable; production passes the
 * real shell body. */
typealias PluginRouteFactory = (session: PluginViewSession, container: Any) -> PluginViewContribution
data class PluginServiceRegistration(val id: String, val capability: String)

data class PluginInstanceDescriptor(
    val identity: PluginInstanceIdentity,
    val capabilities: Set<String>,
    val requires: List<NativeRequirement> = emptyList(),
    val desired: Boolean = true,
    val compatible: Boolean = true,
)

class NativePluginHost(val registry: NativePluginRegistry) {
    private val scopes = LinkedHashMap<String, PluginOwnerSession>()
    private var closing = false
    private var quitResult: List<Throwable>? = null

    fun scope(instanceId: String): PluginOwnerSession? = scopes[instanceId]

    /** Registered plugin route factory for a page id, if any scope owns it. */
    fun route(pageId: String): PluginRouteFactory? = scopes.values.firstNotNullOfOrNull { it.routes[pageId] }
    fun routeOwner(pageId: String): PluginOwnerSession? = scopes.values.firstOrNull { it.routes.containsKey(pageId) }

    /** Admission: desired+compatible only; missing providers reject activation
     * with REQUIRES_BUILD — nothing is fake-installed and no class names are
     * resolved reflectively. */
    fun createScope(descriptor: PluginInstanceDescriptor): PluginResult<PluginOwnerSession> {
        if (closing) return PluginResult.Failed("closing", "host is shutting down", descriptor.identity.packageId, descriptor.identity.instanceId)
        if (scopes.containsKey(descriptor.identity.instanceId))
            return PluginResult.Failed("duplicate_instance", "scope already exists", descriptor.identity.packageId, descriptor.identity.instanceId)
        if (!descriptor.desired || !descriptor.compatible)
            return PluginResult.Failed("not_admitted", "instance is not desired or compatible", descriptor.identity.packageId, descriptor.identity.instanceId)
        for (requirement in descriptor.requires) {
            if (registry.availability(requirement) != PluginAvailability.ACTIVE)
                return PluginResult.Failed("requires_build", "missing provider ${requirement.capability}@${requirement.apiVersion}", descriptor.identity.packageId, descriptor.identity.instanceId)
        }
        val scope = PluginOwnerSession(this, descriptor.identity, descriptor.capabilities)
        scopes[descriptor.identity.instanceId] = scope
        return PluginResult.Ok(scope)
    }

    /** Run a plugin factory inside its scope. Any failure revokes only that
     * scope's registrations; durable jobs stay tracked for drain. */
    fun <T> startPlugin(scope: PluginOwnerSession, factory: (PluginOwnerSession) -> T): PluginResult<T> = try {
        PluginResult.Ok(factory(scope))
    } catch (error: Throwable) {
        revokeScope(scope, keepDurable = true)
        PluginResult.Failed("startup_failed", error.message ?: "plugin startup failed", scope.identity.packageId, scope.identity.instanceId)
    }

    /** Activity recreate: revoke only the view session — reads, callbacks and
     * contributions die; the durable owner, routes, jobs and drafts remain. */
    fun onViewRecreated(owner: PluginOwnerSession): PluginViewSession {
        owner.view?.dispose()
        return owner.createView()
    }

    /** Explicit quit: fence admission, await durable drains, then revoke all. */
    fun quit(): List<Throwable> {
        quitResult?.let { return it }
        // Fence admission on every existing scope before snapshotting drains:
        // new jobs/routes/services are rejected while already accepted drains
        // still run with their resources intact.
        closing = true
        for (scope in scopes.values) scope.revoked = true
        val errors = mutableListOf<Throwable>()
        val drains = scopes.values.flatMap { it.jobs.values.filter { j -> j.durable && j.drain != null }.map { j -> j.drain!! } }
        for (drain in drains) runCatching { drain() }.onFailure { errors += it }
        for (scope in scopes.values.toList()) errors += revokeScope(scope, keepDurable = false)
        scopes.clear()
        quitResult = errors
        return errors
    }

    fun stopScope(instanceId: String): List<Throwable> {
        val scope = scopes[instanceId] ?: return emptyList()
        val errors = revokeScope(scope, keepDurable = false)
        // The scope is always removed so the instance can restart; cleanup
        // errors still reach the caller.
        scopes.remove(instanceId)
        return errors
    }

    private fun revokeScope(scope: PluginOwnerSession, keepDurable: Boolean): List<Throwable> {
        val errors = mutableListOf<Throwable>()
        scope.revoked = true
        errors += scope.view?.dispose() ?: emptyList()
        scope.view = null
        for (id in scope.jobs.keys.toList()) {
            val job = scope.jobs.getValue(id)
            if (!(keepDurable && job.durable)) scope.jobs.remove(id)
        }
        scope.routes.clear(); scope.services.clear()
        for (dispose in scope.disposers.asReversed()) runCatching { dispose() }.onFailure { errors += it }
        scope.disposers.clear()
        return errors
    }
}
