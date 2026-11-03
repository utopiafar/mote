package dev.mote.collector.plugins

import android.content.Context
import dev.mote.collector.CentralInsights
import dev.mote.collector.CentralScreens
import dev.mote.collector.CentralWorkActivity
import dev.mote.collector.HomeCalendarNeedsView
import dev.mote.collector.HomeDiscoveryView
import dev.mote.collector.MoteActivity
import dev.mote.collector.MoteApplication
import dev.mote.collector.WorkPolling
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for work and discovery. The plugin owns the activity
 * and discovery pages, their visible-page polling loop and the two home blocks
 * that read existing work: the saved-results block and the calendar
 * suggestions waiting for a time. Activities only route intents and render the
 * returned view. A stopped scope publishes no home block and arms no poll. */
internal object NativeWorkDiscoveryPlugin {
    const val CAPABILITY = "mote.work-discovery"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.work-discovery"
    private const val PACKAGE_ID = "dev.mote.work-discovery"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, NativeWorkDiscoveryOwner>()

    /** The home blocks this provider publishes while it is active. */
    enum class HomeSection { CALENDAR_NEEDS, DISCOVERY }

    data class Availability(val active: Boolean)

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** The one application-scoped owner. Work, discovery and the home blocks
     * share it so a stopped scope cannot leave one surface reading alone. */
    internal fun owner(context: Context): NativeWorkDiscoveryOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): NativeWorkDiscoveryOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return NativeWorkDiscoveryOwner(null)
        // A scope without a live cached owner is stale (an earlier failed start
        // or an explicitly stopped plugin); admit a fresh instance instead of
        // reusing it.
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return NativeWorkDiscoveryOwner(null, running = false)
        }
        return when (val started = host.startPlugin(scope) { session -> NativeWorkDiscoveryOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                // A failed scope is revoked in place; remove it so a later home
                // or page open can retry admission instead of reusing it.
                host.stopScope(INSTANCE_ID)
                NativeWorkDiscoveryOwner(null, running = false)
            }
        }
    }

    /** Test seam: the same owner on a real host scope. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): NativeWorkDiscoveryOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return NativeWorkDiscoveryOwner(scope)
    }

    internal fun availability(context: Context): Availability {
        val host = (context.applicationContext as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
        return availability(host)
    }

    internal fun availability(host: NativePluginHost?): Availability {
        if (host == null) return Availability(false)
        if (host.registry.availability(requirement()) != PluginAvailability.ACTIVE) return Availability(false)
        val scope = host.scope(INSTANCE_ID)
        return Availability(scope != null && !scope.revoked)
    }

    /** A stopped plugin publishes neither home block. */
    internal fun homeSections(availability: Availability): List<HomeSection> =
        if (availability.active) HomeSection.entries.toList() else emptyList()
}

/** Durable owner: the page controllers and the poll loop live with the plugin
 * scope. A stopped scope removes the home blocks and leaves no refresh armed. */
internal class NativeWorkDiscoveryOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val running: Boolean = true,
) {
    @Volatile private var closed = false; private set

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("work.activity", "${NativeWorkDiscoveryPlugin.CAPABILITY}.activity"))
            scope.registerService(PluginServiceRegistration("work.insights", "${NativeWorkDiscoveryPlugin.CAPABILITY}.insights"))
            scope.registerService(PluginServiceRegistration("work.discovery", "${NativeWorkDiscoveryPlugin.CAPABILITY}.discovery"))
            scope.registerService(PluginServiceRegistration("work.polling", "${NativeWorkDiscoveryPlugin.CAPABILITY}.polling"))
            scope.defer { close() }
        }
    }

    internal val active get() = running && !closed && scope?.revoked != true

    internal fun work(screens: CentralScreens): CentralWorkActivity {
        check(active) { "Native work-discovery plugin is stopped" }
        return CentralWorkActivity(screens)
    }

    internal fun insights(screens: CentralScreens): CentralInsights {
        check(active) { "Native work-discovery plugin is stopped" }
        return CentralInsights(screens)
    }

    internal fun homeDiscovery(activity: MoteActivity, present: (Boolean) -> Unit = {}, open: (String?) -> Unit): HomeDiscoveryView {
        check(active) { "Native work-discovery plugin is stopped" }
        return HomeDiscoveryView(activity, present, open, available = { active })
    }

    internal fun homeCalendarNeeds(activity: MoteActivity, open: () -> Unit): HomeCalendarNeedsView {
        check(active) { "Native work-discovery plugin is stopped" }
        return HomeCalendarNeedsView(activity, open, available = { active })
    }

    /** A page poll loop owned by the plugin: hiding the page cancels the pending
     * refresh and refuses to arm another one. */
    internal fun polling(visible: () -> Boolean, schedule: (Long) -> Unit, cancel: () -> Unit): WorkPolling.Session =
        WorkPolling.Session(visible, schedule, cancel)

    internal fun close() {
        closed = true
    }
}
