package dev.mote.collector.plugins

import android.content.Context
import dev.mote.collector.CalendarActionPresentation
import dev.mote.collector.CalendarActionWorker
import dev.mote.collector.CalendarActions
import dev.mote.collector.CalendarCapabilityPublisher
import dev.mote.collector.ManagedCalendarJournal
import dev.mote.collector.MoteApplication
import dev.mote.collector.Settings
import dev.mote.collector.SourceRules
import dev.mote.collector.secretBox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for managed calendar actions. The plugin owns the
 * action controller, delivery scheduling, capability publication and the
 * encrypted receipt journal; the Activity only routes intents and renders the
 * returned facts. */
internal object ManagedCalendarPlugin {
    const val CAPABILITY = "mote.managed-calendar"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.managed-calendar"
    private const val PACKAGE_ID = "dev.mote.managed-calendar"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, ManagedCalendarOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId, osGrants = listOf("calendar")))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the application-scoped owner once per process. The first calendar
     * entry opens it; unrelated pages never pay for the scope. */
    internal fun owner(context: Context): ManagedCalendarOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): ManagedCalendarOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return ManagedCalendarOwner(null, app)
        // A scope without a live cached owner is stale (an earlier failed start
        // or an explicitly stopped plugin); admit a fresh instance instead of
        // reusing it.
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return ManagedCalendarOwner(null, app)
        }
        return when (val started = host.startPlugin(scope) { session -> ManagedCalendarOwner(session, app) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                throw IllegalStateException(started.message)
            }
        }
    }

    /** Test seam: the same owner on a real host scope without Android files. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): ManagedCalendarOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return ManagedCalendarOwner(scope, null)
    }

    /** The only construction entry for the calendar action controller. */
    internal fun controller(context: Context, foreground: Boolean = false, sessionIdentity: Pair<String, Long>? = null): ManagedCalendarController =
        owner(context).controller(context, foreground, sessionIdentity)

    /** Worker and background delivery enter the plugin here; no caller builds a
     * second controller or journal. */
    internal fun deliver(context: Context) = owner(context).deliver()

    internal fun schedule(context: Context) = owner(context).schedule()

    internal fun stateKey(kind: String, status: String, resolution: String = "", managedState: String = ""): String? =
        CalendarActionPresentation.stateKey(kind, status, resolution, managedState)
}

/** Durable owner: the plugin scope owns delivery scheduling, the capability
 * publisher and the encrypted journal. A stopped scope offers no calendar
 * action control. */
internal class ManagedCalendarOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val context: Context?,
) {
    @Volatile private var closed = false; private set

    init {
        scope?.registerService(PluginServiceRegistration("calendar.actions", "${ManagedCalendarPlugin.CAPABILITY}.actions"))
        scope?.registerService(PluginServiceRegistration("calendar.capability", "${ManagedCalendarPlugin.CAPABILITY}.capability"))
        scope?.registerService(PluginServiceRegistration("calendar.delivery", "${ManagedCalendarPlugin.CAPABILITY}.delivery"))
        scope?.registerJob(PluginJob("calendar.delivery", durable = true))
        scope?.defer { close() }
    }

    internal val active get() = !closed && scope?.revoked != true

    internal fun controller(context: Context, foreground: Boolean = false, sessionIdentity: Pair<String, Long>? = null): ManagedCalendarController {
        check(active) { "Managed calendar plugin is stopped" }
        return ManagedCalendarController(
            CalendarActions(
                context, foreground, sessionIdentity,
                scheduleDelivery = ::schedule,
                journalStore = journalStore(context),
                capabilityPublisher = ::publisher,
            ),
            context,
        )
    }

    internal fun deliver() {
        check(active) { "Managed calendar plugin is stopped" }
        val app = requireNotNull(context) { "Calendar delivery requires an application context" }
        CalendarActions(app, scheduleDelivery = ::schedule, journalStore = journalStore(app), capabilityPublisher = ::publisher).deliver()
    }

    internal fun schedule() {
        check(active) { "Managed calendar plugin is stopped" }
        CalendarActionWorker.schedule(requireNotNull(context) { "Calendar scheduling requires an application context" })
    }

    /** The plugin owns the encrypted receipt journal. Keyed by the current
     * Central origin and device id, it never follows another owner session. */
    internal fun journalStore(context: Context): ManagedCalendarJournalStore = ManagedCalendarJournalStore(context)

    /** The plugin owns capability publication; callers only pass device facts. */
    internal fun publisher(deviceId: String, transport: (String, JSONObject?) -> JSONObject): CalendarCapabilityPublisher =
        CalendarCapabilityPublisher(deviceId, transport)

    internal fun close() {
        if (closed) return
        closed = true
    }
}

/** Encrypted receipt journal storage owned by the managed calendar plugin. A
 * crash can only reconcile the same native event; it never inserts a second
 * one. */
internal class ManagedCalendarJournalStore(context: Context) {
    private val app = context.applicationContext
    private val settings = Settings(app)

    private fun root(): File = File(app.noBackupFilesDir, "calendar-actions/${SourceRules.hash(settings.read().server.trimEnd('/') + settings.deviceId)}").apply { mkdirs() }

    fun read(key: String): String? {
        val file = File(root(), key)
        return if (file.exists()) String(app.secretBox().open(file.readBytes()), Charsets.UTF_8) else null
    }

    fun write(key: String, value: String) {
        val directory = root()
        val temp = File(directory, "$key.tmp")
        FileOutputStream(temp).use {
            it.write(app.secretBox().seal(value.toByteArray(Charsets.UTF_8)))
            it.fd.sync()
        }
        check(temp.renameTo(File(directory, key)))
    }

    fun journal(deviceId: String, request: (String, JSONObject?) -> JSONObject): ManagedCalendarJournal =
        ManagedCalendarJournal(deviceId, request, ::read, ::write)
}

/** Routes received calendar actions to the plugin-owned executor. Delivery and
 * receipt acknowledgement stay inside the plugin, including reconciliation of
 * a retained external event after permission loss. */
internal class ManagedCalendarController internal constructor(
    private val actions: CalendarActions,
    private val context: Context,
) {
    fun permissions(): Boolean = actions.permissions()
    fun calendars(): JSONArray = actions.calendars()
    fun list(cursor: Long = 0): JSONObject = actions.list(cursor)
    fun connect(): JSONArray = actions.connect()
    fun connectAndList(cursor: Long): JSONObject {
        connect()
        return list(cursor)
    }
    fun confirm(action: JSONObject, event: JSONObject, calendarId: String?): JSONObject = actions.confirm(action, event, calendarId)
    fun dismiss(action: JSONObject) = actions.dismiss(action)
    fun execute(id: String, managedOperationId: String? = null) = actions.execute(id, managedOperationId)

    /** Route one page of received actions and execute only what already carries
     * an owner-approved device target. A revoked permission skips every new
     * write while retained receipt reconciliation stays available. */
    fun refresh(cursor: Long): JSONObject = executeApproved(cursor, setOf("approved"), requirePermission = true)

    fun sync(cursor: Long): JSONObject = executeApproved(cursor, setOf("approved", "executing", "uncertain"), requirePermission = false)

    private fun executeApproved(cursor: Long, statuses: Set<String>, requirePermission: Boolean): JSONObject {
        val data = actions.list(cursor)
        if (!requirePermission || actions.permissions()) {
            val items = data.getJSONArray("items")
            val deviceId = Settings(context).deviceId
            for (index in 0 until items.length()) {
                val action = items.getJSONObject(index)
                if (action.optJSONObject("target")?.optString("deviceId") == deviceId && action.optString("status") in statuses)
                    actions.execute(action.getString("id"), action.optJSONObject("managed")?.let { action.getString("operationId") })
            }
        }
        return actions.list(cursor)
    }
}
