package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import dev.mote.collector.HomeNotice
import dev.mote.collector.HomeNoticeRow
import dev.mote.collector.HomeConversationView
import dev.mote.collector.HomeLocalSignature
import dev.mote.collector.HomeLocalState
import dev.mote.collector.HomeReadGate
import dev.mote.collector.HomeSection
import dev.mote.collector.MoteActivity
import dev.mote.collector.MoteApplication
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for the daily home. The plugin owns the home read
 * cadence and local render signatures, the capture line and the recent
 * conversations block. The Activity only mounts the returned sections and
 * routes their actions; a hidden home never refreshes a section. */
internal object DailyHomePlugin {
    const val CAPABILITY = "mote.home"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.home"
    private const val PACKAGE_ID = "dev.mote.home"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, DailyHomeOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** The one application-scoped home owner. Its revision cache and render
     * signatures survive Activity recreation, while mounted sections do not. */
    internal fun owner(context: Context): DailyHomeOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): DailyHomeOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return DailyHomeOwner(null)
        // A scope without a live cached owner is stale (a failed start or an
        // explicitly stopped plugin); admit a fresh instance instead of reusing it.
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return DailyHomeOwner(null)
        }
        return when (val started = host.startPlugin(scope) { session -> DailyHomeOwner(session) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                DailyHomeOwner(null)
            }
        }
    }

    /** Test seam: the same owner on a real host scope. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): DailyHomeOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return DailyHomeOwner(scope)
    }
}

/** One home mount. Sections are paused before the owner is marked visible, so
 * a refresh while another page is open cannot issue an HTTP read. */
internal class DailyHomeSections {
    private val sections = mutableListOf<HomeSection>()
    private var visible = false

    internal val count get() = sections.size

    fun add(section: HomeSection): HomeSection {
        sections += section
        if (!visible) section.pause()
        return section
    }

    fun show() { visible = true }

    fun pause() {
        visible = false
        sections.toList().forEach { it.pause() }
    }

    /** Hidden sections are not refreshed even if the shell still calls this on
     * a background lifecycle tick. */
    fun refresh() {
        if (!visible) return
        sections.toList().forEach { it.refresh() }
    }

    fun close() {
        visible = false
        sections.toList().forEach { it.close() }
        sections.clear()
    }
}

/** Durable owner: home reads and render signatures live with the plugin scope;
 * a new Activity asks for a fresh section group over the same state. */
internal class DailyHomeOwner internal constructor(
    private val scope: PluginOwnerSession?,
) {
    private val local = HomeLocalState()
    @Volatile private var closed = false; private set

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("home.read", "${DailyHomePlugin.CAPABILITY}.read"))
            scope.registerService(PluginServiceRegistration("home.local", "${DailyHomePlugin.CAPABILITY}.local"))
            scope.registerService(PluginServiceRegistration("home.sections", "${DailyHomePlugin.CAPABILITY}.sections"))
            scope.defer { close() }
        }
    }

    internal val active get() = !closed && scope?.revoked != true

    internal fun sections(): DailyHomeSections {
        check(active) { "Daily home plugin is stopped" }
        // A recreated Activity mounts empty views; only the record revision
        // cache survives, not the previous mount's rendered signatures.
        local.resetSignatures()
        return DailyHomeSections()
    }

    internal fun noticeRow(activity: Activity, open: (HomeNotice) -> Unit, act: (HomeNotice) -> Unit): HomeNoticeRow {
        check(active) { "Daily home plugin is stopped" }
        return HomeNoticeRow(activity, open, act)
    }

    internal fun conversation(activity: MoteActivity, archiveEmpty: (Boolean) -> Unit = {}, open: (String) -> Unit): HomeConversationView {
        check(active) { "Daily home plugin is stopped" }
        return HomeConversationView(activity, archiveEmpty, open)
    }

    /** The plugin's read cadence, exposed for home blocks owned by sibling
     * plugins; a hidden block wakes the gate and lets its late result drop. */
    internal fun readGate(): HomeReadGate {
        check(active) { "Daily home plugin is stopped" }
        return HomeReadGate()
    }

    internal fun captures(
        recordsRevision: Long,
        draft: JSONObject,
        savedReceipt: JSONObject?,
        pendingRecovery: () -> Boolean,
        exists: () -> Boolean,
    ): JSONObject {
        check(active) { "Daily home plugin is stopped" }
        return local.captures(recordsRevision, draft, savedReceipt, pendingRecovery, exists)
    }

    internal fun sourceSignature(rows: List<Triple<String, String, String>>) =
        HomeLocalSignature.sources(rows)

    internal fun receiptSignature(id: String, preview: String, capturedAt: String, connected: Boolean) =
        HomeLocalSignature.receipt(id, preview, capturedAt, connected)

    /** True when the rendered sources changed; an unchanged signature reuses
     * the mounted rows without rebuilding them. */
    internal fun sourcesChanged(signature: String) = local.sourcesChanged(signature)

    /** True when the saved-receipt card changed; an unchanged signature keeps
     * the existing card. */
    internal fun receiptChanged(signature: String) = local.receiptChanged(signature)

    internal fun close() {
        closed = true
    }
}
