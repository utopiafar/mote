package dev.mote.collector.plugins

import android.content.Context
import com.google.zxing.BarcodeFormat
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import dev.mote.collector.BuildConfig
import dev.mote.collector.CentralAdmin
import dev.mote.collector.CentralProcessingPresentation
import dev.mote.collector.CentralScreens
import dev.mote.collector.CollectorConfig
import dev.mote.collector.ConnectionClient
import dev.mote.collector.ConnectionFailure
import dev.mote.collector.ConnectionInvitation
import dev.mote.collector.MoteApplication
import dev.mote.collector.RuntimeSettings
import dev.mote.collector.Settings
import dev.mote.collector.SettingsSummaryTracker
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for the owner administration surfaces: Central
 * management, committed settings summaries, runtime configuration changes and
 * the connection review. Activities pass intents and render results; the
 * plugin owns the managers and the one write path that may change settings. */
internal object NativeAdministrationPlugin {
    const val CAPABILITY = "mote.administration"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.administration"
    const val INSTALL_DOCUMENT = "https://github.com/utopiafar/mote/blob/main/docs/agent-install.md"
    private const val PACKAGE_ID = "dev.mote.administration"
    private const val INSTALLATION_ID = "build-native"

    const val INSTALL_PROMPT = """Help me install Mote from https://github.com/utopiafar/mote.
Read docs/agent-install.md and the linked deployment instructions first.
Inspect my environment and any existing Mote installation without changing it.
Use the project's CLI to create an isolated local trial, or reuse the installation
I explicitly choose. Preserve existing archives, profiles, credentials and settings.
Verify authenticated health and give me the actual Central address, then guide me
through connecting a collector and opening its first received original in Central.
Ask before changing network exposure, installing a persistent service, granting
new permissions, using a paid model, or changing existing data. Keep secrets out
of output and Git. Stop at an unavailable requirement and report what remains."""

    private val owners = ConcurrentHashMap<String, AdministrationOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the application-scoped owner once per process. */
    internal fun owner(context: Context): AdministrationOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): AdministrationOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return AdministrationOwner(null)
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return AdministrationOwner(null)
        }
        return when (val started = host.startPlugin(scope) { session -> AdministrationOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                throw IllegalStateException(started.message)
            }
        }
    }

    /** Test seam: the same owner on a real host scope without Android files. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): AdministrationOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return AdministrationOwner(scope)
    }

    /** Camera frames are decoded locally in memory; the plugin owns the mixed
     * polarity policy so the scan Activity only hosts the camera view. */
    fun scanDecoderFactory() = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE), null, null, Intents.Scan.MIXED_SCAN)
}

/** Durable owner for management and connection surfaces. A stopped scope
 * leaves no Central manager, settings tracker or connection writer behind. */
internal class AdministrationOwner internal constructor(
    private val scope: PluginOwnerSession?,
) {
    @Volatile private var closed = false; private set

    init {
        scope?.registerService(PluginServiceRegistration("administration.central", "${NativeAdministrationPlugin.CAPABILITY}.central"))
        scope?.registerService(PluginServiceRegistration("administration.settings", "${NativeAdministrationPlugin.CAPABILITY}.settings"))
        scope?.registerService(PluginServiceRegistration("administration.runtime", "${NativeAdministrationPlugin.CAPABILITY}.runtime"))
        scope?.registerService(PluginServiceRegistration("administration.connection", "${NativeAdministrationPlugin.CAPABILITY}.connection"))
        scope?.registerJob(PluginJob("administration.summary"))
        scope?.defer { close() }
    }

    internal val active get() = !closed && scope?.revoked != true

    fun centralAdmin(screens: CentralScreens): CentralAdmin {
        check(active) { "Native administration plugin is stopped" }
        return CentralAdmin(screens, this)
    }

    fun settings(context: Context): Settings {
        check(active) { "Native administration plugin is stopped" }
        return Settings(context)
    }

    fun settingsSummary() = SettingsSummaryTracker()

    fun processing(): CentralProcessingPresentation {
        check(active) { "Native administration plugin is stopped" }
        return CentralProcessingPresentation
    }

    fun current(context: Context): Pair<CollectorConfig, String> {
        check(active) { "Native administration plugin is stopped" }
        val settings = Settings(context)
        return settings.read() to settings.deviceId
    }

    fun initialConnection(context: Context): AdministrationConnection.Initial {
        check(active) { "Native administration plugin is stopped" }
        val current = current(context)
        val client = ConnectionClient(context)
        return AdministrationConnection.Initial(current.first, current.second, client.status(), client.statusAt())
    }

    /** The only settings write path for connection surfaces. The review is
     * staged first and the configuration is applied only by [confirm]. */
    fun connection(context: Context): AdministrationConnection {
        check(active) { "Native administration plugin is stopped" }
        return AdministrationConnection(
            commit = { config, invitation, name, allowHttp, finished ->
                RuntimeSettings.apply(
                    context, config, bindLocal = true,
                    change = { ConnectionClient(context).connect(invitation, name, allowHttp, bindLocal = true) },
                    nextServer = invitation.serverUrl, finished = finished,
                )
            },
        )
    }

    fun saveDeviceName(context: Context, expected: CollectorConfig, name: String, finished: (Result<RuntimeSettings.Applied>) -> Unit) {
        check(active) { "Native administration plugin is stopped" }
        val chosen = name.trim()
        require(chosen.isNotBlank() && chosen.length <= 128)
        RuntimeSettings.apply(context, expected.copy(deviceName = chosen), expected = expected, finished = finished)
    }

    fun resumeConnection(context: Context, config: CollectorConfig, server: String, name: String, allowHttp: Boolean, finished: (Result<RuntimeSettings.Applied>) -> Unit) {
        check(active) { "Native administration plugin is stopped" }
        RuntimeSettings.apply(
            context, config, bindLocal = true,
            change = { ConnectionClient(context).resume(name, allowHttp, bindLocal = true) },
            nextServer = server, finished = finished,
        )
    }

    fun testConnection(context: Context): String {
        check(active) { "Native administration plugin is stopped" }
        return ConnectionClient(context).test()
    }

    fun pendingServer(context: Context): String? {
        check(active) { "Native administration plugin is stopped" }
        return ConnectionClient(context).pendingServer()
    }

    fun progressLabel() = RuntimeSettings.progressLabel()

    fun currentConfiguration() = RuntimeSettings.currentConfiguration

    fun close() {
        if (closed) return
        closed = true
    }
}

/** One staged invitation. Parsing and review never touch persisted settings;
 * only [confirm] reaches the injected commit port, and a confirmed selection
 * cannot be replayed. */
internal class AdministrationConnection internal constructor(
    private val now: () -> Instant = Instant::now,
    private val debug: Boolean = BuildConfig.DEBUG,
    private val commit: (CollectorConfig, ConnectionInvitation, String, Boolean, (Result<RuntimeSettings.Applied>) -> Unit) -> Unit,
) {
    data class Initial(val config: CollectorConfig, val deviceId: String, val status: String, val statusAt: Long)

    private var staged: ConnectionInvitation? = null

    fun stage(raw: String, allowHttp: Boolean): ConnectionInvitation =
        ConnectionInvitation.parse(raw, allowHttp, debug, now()).also { staged = it }

    fun selected(): ConnectionInvitation? = staged

    fun clear() { staged = null }

    fun confirm(config: CollectorConfig, deviceName: String, allowHttp: Boolean, finished: (Result<RuntimeSettings.Applied>) -> Unit) {
        val invitation = staged ?: throw ConnectionFailure("invitation")
        val name = deviceName.trim()
        require(name.isNotBlank() && name.length <= 128)
        commit(config, invitation, name, allowHttp) { result ->
            if (result.isSuccess) staged = null
            finished(result)
        }
    }
}
