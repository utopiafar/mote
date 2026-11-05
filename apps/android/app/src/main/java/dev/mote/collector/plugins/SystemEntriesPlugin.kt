package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import dev.mote.collector.AppCaptureEditor
import dev.mote.collector.AppCapturePresentation
import dev.mote.collector.AppCollectionMode
import dev.mote.collector.CaptureStatusOperation
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteQuickEntry
import dev.mote.collector.MoteSystemEntries
import dev.mote.collector.Notifications

/** Build-native provider for the system-level Mote surfaces: the capture status
 * notification and its actions, launcher shortcuts, the quick-entry widget and
 * its routing Activity, and the app capture editor page. The plugin owns the
 * publication policy; when its scope is stopped no entry or action is offered
 * and every surface shows the reason instead. */
internal object SystemEntriesPlugin {
    const val CAPABILITY = "mote.system-entries"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.system-entries"
    private const val PACKAGE_ID = "dev.mote.system-entries"
    private const val INSTALLATION_ID = "build-native"

    data class Availability(val active: Boolean, val reason: String? = null)

    /** One system action the status notification may offer. Unavailable scopes
     * offer none, and the reason stays visible in the notification text. */
    enum class Action { RECORD, PAUSE_SCREEN, RESUME_SCREEN, STOP_CAPTURE, ATTENTION }

    @Volatile private var owner: SystemEntriesOwner? = null
    private val fallback = java.util.concurrent.ConcurrentHashMap<String, Notifications>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId, osGrants = listOf("notifications", "shortcuts")))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the build-native owner once per process. A missing provider or a
     * failed scope leaves the surfaces unavailable with their reason. */
    internal fun start(context: Context, host: NativePluginHost): SystemEntriesOwner? {
        owner?.takeIf { it.active }?.let { return it }
        val app = context.applicationContext
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement()))
        val scope = (host.createScope(descriptor) as? PluginResult.Ok)?.value ?: return null
        val notifications = Notifications(app) { availability(host) }
        val started = host.startPlugin(scope) { session ->
            SystemEntriesOwner(session, notifications).also { it.start() }
        }
        return when (started) {
            is PluginResult.Ok -> started.value.also { owner = it }
            is PluginResult.Failed -> { notifications.close(); null }
        }
    }

    /** Test seam: a real host scope without Android notification or widget
     * wiring. */
    internal fun open(scope: PluginOwnerSession): SystemEntriesOwner = SystemEntriesOwner(scope, null)

    /** The publisher consumed by capture services and the local status
     * producer. A stopped scope falls back to an inert publisher that only
     * keeps a foreground service's required notification legal. */
    internal fun notifications(context: Context): Notifications {
        val app = context.applicationContext
        owner?.takeIf { it.active }?.notifications?.let { return it }
        return fallback.computeIfAbsent(app.noBackupFilesDir.absolutePath) { Notifications(app) { availability(app) } }
    }

    /** Rebuild every system surface after startup or a language change. */
    fun refresh(context: Context) = MoteSystemEntries.refresh(context)

    internal fun availability(context: Context): Availability {
        val host = (context.applicationContext as? MoteApplication)?.let { app -> runCatching { app.pluginHost }.getOrNull() }
        return availability(host)
    }

    internal fun availability(host: NativePluginHost?): Availability {
        if (host == null) return Availability(false, MoteI18n.text("系统入口插件未加载；快捷入口和通知动作不可用。"))
        if (host.registry.availability(requirement()) != PluginAvailability.ACTIVE)
            return Availability(false, MoteI18n.text("系统入口插件需要重新构建；快捷入口和通知动作不可用。"))
        val scope = host.scope(INSTANCE_ID)
        if (scope == null || scope.revoked) return Availability(false, MoteI18n.text("系统入口插件已停用；快捷入口和通知动作不可用。"))
        return Availability(true)
    }

    internal fun quickEntries(availability: Availability): List<MoteQuickEntry> =
        if (availability.active) MoteQuickEntry.entries else emptyList()

    /** Surfaces keep their status text and append the read-only reason when the
     * plugin cannot act. */
    internal fun surfaceText(availability: Availability, text: String): String =
        if (availability.active) text else listOfNotNull(text.takeIf(String::isNotBlank), availability.reason).joinToString("\n")

    /** Capturing offers record / pause screen / stop; a paused screen offers
     * resume, and a partial problem offers its repair before recording. */
    internal fun notificationActions(availability: Availability, screenCapturing: Boolean, screenPaused: Boolean, needsAction: Boolean): List<Action> =
        if (!availability.active) emptyList() else buildList {
            if (needsAction) add(Action.ATTENTION)
            add(Action.RECORD)
            if (!needsAction) when {
                screenPaused -> add(Action.RESUME_SCREEN)
                screenCapturing -> add(Action.PAUSE_SCREEN)
            }
            add(Action.STOP_CAPTURE)
        }

    /** The repair action named by the shared status row. */
    internal fun attentionLabel(operation: CaptureStatusOperation?): String = MoteI18n.text(when (operation) {
        CaptureStatusOperation.RECONNECT -> "连接"
        CaptureStatusOperation.RESTART_CAPTURE -> "重新开启"
        else -> "处理"
    })

    /** The only construction entry for the editor. The owning page supplies
     * its configuration draft; the plugin supplies the availability policy. */
    fun appCaptureEditor(
        activity: Activity,
        snapshot: () -> AppCapturePresentation.Snapshot?,
        change: (String, AppCollectionMode?) -> Unit,
        preview: (String) -> Unit,
        editRule: (String, String) -> Unit,
        loadRules: (String, String) -> Unit,
        importRules: (String, String) -> Unit,
        detailChanged: (Boolean) -> Unit,
    ): AppCaptureEditor = AppCaptureEditor(
        activity, snapshot, change, preview, editRule, loadRules, importRules, detailChanged,
        availability = { availability(activity) },
    )
}

/** Durable owner: the notification publisher lives and dies with the plugin
 * scope. Activities and broadcast receivers only route into it. */
internal class SystemEntriesOwner internal constructor(
    private val scope: PluginOwnerSession,
    internal val notifications: Notifications?,
) {
    @Volatile internal var closed = false; private set

    init {
        scope.registerService(PluginServiceRegistration("system-entries.notifications", "${SystemEntriesPlugin.CAPABILITY}.notifications"))
        scope.registerService(PluginServiceRegistration("system-entries.quick", "${SystemEntriesPlugin.CAPABILITY}.quick-entries"))
        scope.registerService(PluginServiceRegistration("system-entries.app-capture", "${SystemEntriesPlugin.CAPABILITY}.app-capture"))
        scope.defer { close() }
    }

    internal val active get() = !closed

    internal fun start() { notifications?.create() }

    internal fun close() {
        if (closed) return
        closed = true
        notifications?.close()
    }
}
