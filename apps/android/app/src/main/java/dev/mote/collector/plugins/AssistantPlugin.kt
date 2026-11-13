package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import android.view.View
import dev.mote.collector.CentralScreens
import dev.mote.collector.MoteApplication
import dev.mote.collector.mountWorkbench
import dev.mote.collector.mountAssistant
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap

/** Build-native position for the assistant domain. The package owns the
 * feed, matters and workbench routes; opening one mounts its Central screen into the
 * host slot. Registering the provider never starts work or performs a command. */
internal object AssistantPlugin {
    const val CAPABILITY = "mote.assistant"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.assistant"
    const val WORKBENCH_ROUTE = "assistant.workbench"
    const val FEED_ROUTE = "assistant.feed"
    const val MATTERS_ROUTE = "assistant.matters"
    val PAGE_ROUTES = setOf(FEED_ROUTE, MATTERS_ROUTE, WORKBENCH_ROUTE)
    private const val PACKAGE_ID = "dev.mote.assistant"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, AssistantOwner>()
    private val screens = WeakHashMap<Activity, WeakReference<CentralScreens>>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** The central page binds its current screen so the route factory can
     * mount the exact owner view without a second navigation tree. */
    internal fun bind(activity: Activity, screen: CentralScreens) {
        synchronized(screens) { screens[activity] = WeakReference(screen) }
    }

    internal fun screen(activity: Activity): CentralScreens? = synchronized(screens) { screens[activity]?.get() }

    /** Open the assistant scope before resolving a cold-start view link. This
     * declares the page route; it does not read data or run a command. */
    internal fun ensure(context: Context) {
        runCatching { owner(context) }
    }

    internal fun owner(context: Context): AssistantOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): AssistantOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return AssistantOwner(null)
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return AssistantOwner(null, running = false)
        }
        return when (val started = host.startPlugin(scope) { session -> AssistantOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                AssistantOwner(null, running = false)
            }
        }
    }

    /** Test seam: the same owner on a real host scope. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): AssistantOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return AssistantOwner(scope)
    }
}

/** Durable owner: the plugin scope owns the assistant routes. A stopped scope
 * withdraws the page and every declared command route. */
internal class AssistantOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val running: Boolean = true,
) {
    @Volatile private var closed = false

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("assistant.workbench", "${AssistantPlugin.CAPABILITY}.workbench"))
            for (page in AssistantPlugin.PAGE_ROUTES) scope.registerRoute(page) { _, container ->
                val view = container as? View ?: error("assistant route needs a view container")
                val activity = view.context as? Activity ?: error("assistant route needs an Activity")
                val screen = AssistantPlugin.screen(activity) ?: error("assistant screen is not bound")
                if (page == AssistantPlugin.WORKBENCH_ROUTE) screen.mountWorkbench(container as android.view.ViewGroup)
                else screen.mountAssistant(page, container as android.view.ViewGroup)
            }
            scope.defer { close() }
        }
    }

    internal val active get() = running && !closed && scope?.revoked != true

    internal fun close() {
        closed = true
    }
}
