package dev.mote.collector.plugins

/** Frozen Kotlin typed ports for plugin view/service/dependency/result
 * surfaces. A view scope dies with its Activity view; the durable owner
 * (capture service, workers, drafts, route state) does not. These types carry
 * no android imports so the contracts stay JVM-testable. */
data class PluginInstanceIdentity(val packageId: String, val installationId: String, val instanceId: String)

sealed interface PluginResult<out T> {
    data class Ok<T>(val value: T) : PluginResult<T>
    data class Failed(val code: String, val message: String, val pluginId: String, val instanceId: String) : PluginResult<Nothing>
}

/** One mounted view contribution: what the host binds to the shell's slots. */
interface PluginViewContribution {
    val routeId: String
    fun dispose()
}

/** A view-scoped session: callbacks, reads and subscriptions die together;
 * nothing here may outlive dispose(). */
class PluginViewSession internal constructor(
    val owner: PluginOwnerSession,
    private val contributions: MutableList<PluginViewContribution> = mutableListOf(),
) {
    private val disposers = mutableListOf<() -> Unit>()
    var disposed = false; private set

    fun registerView(view: PluginViewContribution) {
        check(!disposed) { "view session is disposed" }
        contributions += view
    }

    fun defer(dispose: () -> Unit) {
        check(!disposed) { "view session is disposed" }
        disposers += dispose
    }

    /** Only the view layer is revoked: reads, callbacks, contributions. The
     * durable owner keeps running. */
    fun dispose(): List<Throwable> {
        val errors = mutableListOf<Throwable>()
        if (disposed) return errors
        disposed = true
        for (view in contributions.asReversed()) runCatching { view.dispose() }.onFailure { errors += it }
        contributions.clear()
        for (dispose in disposers.asReversed()) runCatching { dispose() }.onFailure { errors += it }
        disposers.clear()
        return errors
    }
}
