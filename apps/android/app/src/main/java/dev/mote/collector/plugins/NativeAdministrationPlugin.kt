package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import dev.mote.collector.BuildConfig
import dev.mote.collector.CentralAdmin
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralProcessingPresentation
import dev.mote.collector.CentralScreens
import dev.mote.collector.CollectorConfig
import dev.mote.collector.ConnectionClient
import dev.mote.collector.ConnectionFailure
import dev.mote.collector.ConnectionInvitation
import dev.mote.collector.MemoryDetailPanel
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteDialogBuilder
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeColorRole
import dev.mote.collector.NativeFontRole
import dev.mote.collector.RuntimeSettings
import dev.mote.collector.Settings
import dev.mote.collector.SettingsSummaryTracker
import dev.mote.collector.moteDp
import dev.mote.collector.ui.MoteComponents
import org.json.JSONArray
import org.json.JSONObject
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

/** The four authored "m" destinations. Their pages keep the current bottom tab
 * and return to it; only the connection destination changes from device
 * pairing to the owner's external services. */
internal enum class ManageDestination(val navId: String, val page: String) {
    MEMORY("memory", "MEMORY"),
    SKILLS("skills", "SKILLS"),
    CONNECTIONS("connections", "SERVICES"),
    SETTINGS("settings", "SETTINGS");

    companion object {
        fun forNavId(id: String): ManageDestination? = entries.firstOrNull { it.navId == id }
    }
}

internal object ManageBack {
    private val pages = setOf("MEMORY", "SKILLS", "SERVICES", "SETTINGS", "CONNECTION")

    /** The tab a manage page was opened from; null means the page has its own parent. */
    fun target(page: String, lastTab: String): String? = lastTab.takeIf { page in pages }
}

/** Phone settings stay phone-specific: the four existing groups plus
 * notifications and the one Central workspace entry. */
internal enum class SettingsAction(val label: String, val group: String, val external: Boolean = false) {
    CONNECTION("连接与设备", "connection"),
    APPEARANCE("外观与语言", "choices"),
    BACKUP("备份与恢复", "choices"),
    DIAGNOSTICS("诊断与支持", "choices"),
    NOTIFICATIONS("通知", "choices"),
    ABOUT("关于与更新", "about"),
    CENTRAL_WORKBENCH("中央工作台", "workbench", external = true),
}

/** The local connection card follows the last connection attempt. A rejected
 * credential changes the card to reauthorization instead of looking healthy. */
internal object AdministrationConnectionStatus {
    fun label(status: String): String = when (status) {
        "connected" -> MoteI18n.text("已连接")
        "unchecked" -> MoteI18n.text("尚未测试连接")
        "authentication", "permission", "expired", "invite_rejected" -> MoteI18n.text("需要重新授权")
        "network" -> MoteI18n.text("网络不可用")
        else -> MoteI18n.text("需要处理")
    }

    fun needsReauthorization(status: String): Boolean =
        status in setOf("authentication", "permission", "expired", "invite_rejected")
}

/** CT1 connection cards. The client only renders the state and action set the
 * owner API returned; it never infers an action from a connector name. */
internal data class ConnectionServiceJob(
    val kind: String,
    val every: String,
    val lastAt: String,
    val lastCount: Int?,
)

internal data class ConnectionService(
    val id: String,
    val name: String,
    val kind: String,
    val state: String,
    val jobs: List<ConnectionServiceJob>,
    val tools: List<String>,
    val actions: List<String>,
)

internal data class ConnectionServices(val revision: String, val services: List<ConnectionService>)

internal object ConnectionServicesProjection {
    fun read(client: CentralClient): ConnectionServices = view(client.get("/api/connections/services"))

    fun view(value: JSONObject): ConnectionServices {
        val services = value.optJSONArray("services") ?: JSONArray()
        return ConnectionServices(
            value.optString("revision"),
            (0 until services.length()).mapNotNull { index ->
                val item = services.optJSONObject(index) ?: return@mapNotNull null
                val id = item.optString("id")
                if (id.isBlank()) return@mapNotNull null
                ConnectionService(
                    id = id,
                    name = item.optString("name").ifBlank { id },
                    kind = if (item.optString("kind") == "ai-access") "ai-access" else "service",
                    state = item.optString("state"),
                    jobs = jobs(item.optJSONArray("jobs")),
                    tools = strings(item.optJSONArray("tools")),
                    actions = strings(item.optJSONArray("actions")),
                )
            },
        )
    }

    private fun strings(value: JSONArray?): List<String> = value?.let { array ->
        (0 until array.length()).mapNotNull { index -> array.optString(index).takeIf(String::isNotBlank) }
    }.orEmpty()

    private fun jobs(value: JSONArray?): List<ConnectionServiceJob> = value?.let { array ->
        (0 until array.length()).mapNotNull { index ->
            val job = array.optJSONObject(index) ?: return@mapNotNull null
            val kind = job.optString("kind")
            if (kind.isBlank()) return@mapNotNull null
            ConnectionServiceJob(
                kind = kind,
                every = job.optString("every"),
                lastAt = job.optString("lastAt"),
                lastCount = if (job.has("lastCount") && !job.isNull("lastCount")) job.optInt("lastCount") else null,
            )
        }
    }.orEmpty()

    fun stateLabel(state: String): String = when (state) {
        "connected" -> MoteI18n.text("已连接")
        "reauth" -> MoteI18n.text("需要重新授权")
        "error" -> MoteI18n.text("需要处理")
        "paused" -> MoteI18n.text("已暂停")
        else -> state
    }

    fun actionLabel(action: String): String = when (action) {
        "sync" -> MoteI18n.text("立即同步")
        "dry-run" -> MoteI18n.text("试运行")
        "reauth" -> MoteI18n.text("重新授权")
        "pause" -> MoteI18n.text("暂停")
        "resume" -> MoteI18n.text("继续")
        "remove" -> MoteI18n.text("移除")
        else -> action
    }

    fun kindLabel(kind: String): String =
        if (kind == "ai-access") MoteI18n.text("AI 接入") else MoteI18n.text("外部服务")

    fun attention(state: String): Boolean = state == "reauth" || state == "error"

    fun jobLabel(job: ConnectionServiceJob): String = buildList {
        add(MoteI18n.text("取数"))
        add(job.kind)
        job.every.takeIf(String::isNotBlank)?.let(::add)
        job.lastAt.takeIf(String::isNotBlank)?.let { add(MoteI18n.text("上次") + " " + MemoryDetailPanel.displayTime(it)) }
        job.lastCount?.let { add(MoteI18n.text("{0} 条", it)) }
    }.joinToString(" · ")
}

/** Native external-service cards. Read-only facts plus the actions that are
 * safe without connector-specific endpoint knowledge: dry-run and removing an
 * AI access token. Other allowed actions stay visible and link to Central. */
internal class ConnectionServicesSection(
    private val activity: Activity,
    private val parent: LinearLayout,
    private val client: CentralClient,
    private val openCentral: () -> Unit,
) {
    private var generation = 0

    fun load() {
        val stamp = ++generation
        parent.removeAllViews()
        parent.addView(text(MoteI18n.text("正在读取…"), NativeFontRole.SUPPORT, NativeColorRole.MUTED))
        Thread {
            val result = runCatching { ConnectionServicesProjection.read(client) }
            activity.runOnUiThread {
                if (stamp != generation || activity.isDestroyed || activity.isFinishing) return@runOnUiThread
                parent.removeAllViews()
                result.onSuccess { render(it) }.onFailure { failure(it) }
            }
        }.start()
    }

    private fun render(view: ConnectionServices) {
        val toolbar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        }
        toolbar.addView(text(MoteI18n.text("外部服务"), NativeFontRole.SECTION, NativeColorRole.INK),
            LinearLayout.LayoutParams(0, -2, 1f))
        toolbar.addView(MoteComponents.smallButton(activity, "刷新") { load() })
        parent.addView(toolbar)
        val links = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.START }
        links.addView(MoteComponents.smallButton(activity, "在中央打开") { openCentral() })
        parent.addView(links, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
        if (view.services.isEmpty()) {
            parent.addView(text(MoteI18n.text("还没有连接"), NativeFontRole.BODY, NativeColorRole.MUTED))
            return
        }
        view.services.forEach { service -> parent.addView(card(service)) }
    }

    private fun card(service: ConnectionService): View {
        val card = MoteComponents.group(activity)
        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(10), dp(14), dp(4))
        }
        header.addView(text(service.name, NativeFontRole.ROW, NativeColorRole.INK, medium = true),
            LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(text(ConnectionServicesProjection.stateLabel(service.state), NativeFontRole.META,
            if (ConnectionServicesProjection.attention(service.state)) NativeColorRole.WARNING else NativeColorRole.MUTED))
        card.addView(header)
        val detail = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(14), dp(10)) }
        detail.addView(text(ConnectionServicesProjection.kindLabel(service.kind), NativeFontRole.META, NativeColorRole.MUTED))
        service.jobs.forEach { job -> detail.addView(text(ConnectionServicesProjection.jobLabel(job), NativeFontRole.META, NativeColorRole.MUTED)) }
        if (service.tools.isNotEmpty()) detail.addView(text(MoteI18n.text("工具") + " · " + service.tools.joinToString(" · "), NativeFontRole.META, NativeColorRole.MUTED))
        if (service.actions.isNotEmpty()) detail.addView(text(
            MoteI18n.text("操作") + " · " + service.actions.joinToString(" · ") { ConnectionServicesProjection.actionLabel(it) },
            NativeFontRole.META, NativeColorRole.MUTED,
        ))
        card.addView(detail)
        val actions = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), 0, dp(8), dp(2)) }
        if ("dry-run" in service.actions) actions.addView(MoteComponents.smallButton(activity, "试运行") { dryRun(service, card) })
        if (service.kind == "ai-access" && "remove" in service.actions) actions.addView(MoteComponents.smallButton(activity, "移除") { confirmRemove(service) })
        if (actions.childCount > 0) card.addView(actions)
        card.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        return card
    }

    private fun dryRun(service: ConnectionService, card: LinearLayout) {
        val result = text(MoteI18n.text("正在读取…"), NativeFontRole.META, NativeColorRole.MUTED)
        card.addView(result)
        Thread {
            val outcome = runCatching {
                client.post("/api/connections/services/" + CentralScreens.encode(service.id) + "/dry-run", JSONObject())
            }
            activity.runOnUiThread {
                if (activity.isDestroyed || activity.isFinishing) return@runOnUiThread
                outcome.onSuccess { value ->
                    result.text = MoteI18n.text("试运行") + " · " + MoteI18n.text("{0} 条", value.optInt("count"))
                }.onFailure { failure ->
                    result.text = failure.message ?: MoteI18n.text("需要处理")
                    result.setTextColor(NativeColorRole.WARNING.color())
                }
            }
        }.start()
    }

    private fun confirmRemove(service: ConnectionService) {
        MoteDialogBuilder(activity).setTitle(MoteI18n.text("移除连接"))
            .setMessage(MoteI18n.text("停止此连接的后续访问，已归档资料保留。再次接入需要生成新配置。"))
            .setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("移除")) { _, _ ->
                Thread {
                    val outcome = runCatching { client.delete("/api/connections/" + CentralScreens.encode(service.id)) }
                    activity.runOnUiThread {
                        if (activity.isDestroyed || activity.isFinishing) return@runOnUiThread
                        outcome.onSuccess { load() }.onFailure { failure ->
                            android.widget.Toast.makeText(activity, failure.message ?: MoteI18n.text("需要处理"), android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                }.start()
            }.show()
    }

    private fun failure(error: Throwable) {
        parent.addView(text(error.message ?: MoteI18n.text("需要处理"), NativeFontRole.SUPPORT, NativeColorRole.WARNING))
        parent.addView(MoteComponents.smallButton(activity, "重试") { load() })
    }

    private fun text(value: String, role: NativeFontRole, color: NativeColorRole, medium: Boolean = false): TextView =
        TextView(activity).apply {
            text = value
            MoteUi.type(this, role, medium = medium)
            MoteUi.textColor(this, color)
            setPadding(0, dp(4), 0, dp(4))
        }

    private fun dp(value: Int) = activity.moteDp(value)
}
