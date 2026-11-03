package dev.mote.collector.plugins

import android.content.Context
import android.content.Intent
import dev.mote.collector.AppUpdateInstaller
import dev.mote.collector.CollectorConfig
import dev.mote.collector.Diagnostics
import dev.mote.collector.MoteApplication
import dev.mote.collector.SupportEvents
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for the owner system tools: numeric diagnostics, the
 * safe support bundle and the replacement-only update installer. The plugin
 * owns the export policy and install entry points; Activities and receivers
 * only route their explicit commands. */
internal object NativeSystemToolsPlugin {
    const val CAPABILITY = "mote.system-tools"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.system-tools"
    private const val PACKAGE_ID = "dev.mote.system-tools"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, SystemToolsOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    internal fun owner(context: Context): SystemToolsOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): SystemToolsOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return SystemToolsOwner(null)
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return SystemToolsOwner(null)
        }
        return when (val started = host.startPlugin(scope) { session -> SystemToolsOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                throw IllegalStateException(started.message)
            }
        }
    }

    /** Test seam: the same owner on a real host scope without Android files. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): SystemToolsOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return SystemToolsOwner(scope)
    }

    /** The support bundle configuration is an allowlist, never a copy of the
     * saved configuration. Endpoint, credential, device name and private
     * drafts cannot reach an exported package. */
    fun supportConfiguration(config: CollectorConfig?): JSONObject = SupportEvents.supportConfiguration(config)

    fun diagnostics(context: Context): Diagnostics = owner(context).diagnostics(context)
}

/** Durable owner for diagnostics, support export and the update installer.
 * Closing the scope withdraws these controls; the platform receiver can no
 * longer publish a pending install through this owner. */
internal class SystemToolsOwner internal constructor(
    private val scope: PluginOwnerSession?,
) {
    @Volatile private var closed = false; private set

    init {
        scope?.registerService(PluginServiceRegistration("system-tools.diagnostics", "${NativeSystemToolsPlugin.CAPABILITY}.diagnostics"))
        scope?.registerService(PluginServiceRegistration("system-tools.support", "${NativeSystemToolsPlugin.CAPABILITY}.support"))
        scope?.registerService(PluginServiceRegistration("system-tools.updates", "${NativeSystemToolsPlugin.CAPABILITY}.updates"))
        scope?.defer { close() }
    }

    internal val active get() = !closed && scope?.revoked != true

    fun diagnostics(context: Context): Diagnostics {
        check(active) { "Native system tools plugin is stopped" }
        return Diagnostics(context)
    }

    fun supportBundle(context: Context, hours: Int = 24): String {
        check(active) { "Native system tools plugin is stopped" }
        return SupportEvents.export(context, hours)
    }

    fun requestUpdate(context: Context): String {
        check(active) { "Native system tools plugin is stopped" }
        return AppUpdateInstaller.request(context)
    }

    fun stageUpdate(context: Context, ticket: String, beforeCreate: (() -> Unit)? = null): Int {
        check(active) { "Native system tools plugin is stopped" }
        return AppUpdateInstaller.stage(context, ticket, beforeCreate)
    }

    fun cancelUpdate(context: Context) {
        check(active) { "Native system tools plugin is stopped" }
        AppUpdateInstaller.cancelSession(context)
    }

    fun reconcileUpdates(context: Context) {
        check(active) { "Native system tools plugin is stopped" }
        AppUpdateInstaller.reconcile(context)
    }

    fun confirmUpdate(context: Context, intent: Intent, sessionId: Int) {
        check(active) { "Native system tools plugin is stopped" }
        AppUpdateInstaller.confirmation(context, intent, sessionId)
    }

    internal fun <T> withoutActiveInstall(context: Context, action: () -> T): T {
        check(active) { "Native system tools plugin is stopped" }
        return AppUpdateInstaller.withoutActiveInstall(context, action)
    }

    fun close() {
        if (closed) return
        closed = true
    }
}
