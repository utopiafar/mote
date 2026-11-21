package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import dev.mote.collector.CaptureAccessibilityService
import dev.mote.collector.CaptureOverview
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralCaptureReader
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralFileView
import dev.mote.collector.CentralFailure
import dev.mote.collector.CentralLibrary
import dev.mote.collector.CentralMemoryTopics
import dev.mote.collector.CentralScreens
import dev.mote.collector.LibraryCaptureProjection
import dev.mote.collector.LibraryLocalSources
import dev.mote.collector.LibraryRefreshPolicy
import dev.mote.collector.LibrarySourceProjection
import dev.mote.collector.MediaCollectionService
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteActivity
import dev.mote.collector.MoteUi
import dev.mote.collector.NativeColorRole
import dev.mote.collector.NativeRadiusRole
import dev.mote.collector.ProjectionService
import dev.mote.collector.SourcesActivity
import dev.mote.collector.WorkMemoryReference
import dev.mote.collector.ArchivedOriginal
import dev.mote.collector.CaptureUploadVersion
import dev.mote.collector.ReleasedCapture
import dev.mote.collector.Settings
import dev.mote.collector.TransferRequestGuard
import dev.mote.collector.UiTask
import dev.mote.collector.captureLibraryVersion
import dev.mote.collector.queue
import dev.mote.collector.recordDraftStore
import dev.mote.collector.meeting.meetingRecordings
import dev.mote.collector.moteDp
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Build-native provider for the Library surfaces: catalogs, the exact-version
 * reader, local source pages, the capture/source projections and memory topics.
 * The plugin owns every construction and read path; Activities only route
 * intents, render results and host the returned controls. */
internal object NativeLibraryPlugin {
    const val CAPABILITY = "mote.library"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.library"
    private const val PACKAGE_ID = "dev.mote.library"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, NativeLibraryOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the application-scoped owner once per process. The first Library
     * entry opens it; unrelated pages never pay for the scope. */
    internal fun owner(context: Context): NativeLibraryOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): NativeLibraryOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return NativeLibraryOwner(null, app)
        // A scope without a live cached owner is stale (an earlier failed start
        // or an explicitly stopped plugin); admit a fresh instance instead of
        // reusing it.
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement())),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return NativeLibraryOwner(null, app)
        }
        return when (val started = host.startPlugin(scope) { session -> NativeLibraryOwner(session, app) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                // A failed scope is revoked in place; remove it so a later
                // Library entry can retry admission instead of reusing it.
                host.stopScope(INSTANCE_ID)
                throw IllegalStateException(started.message)
            }
        }
    }

    /** Test seam: the same owner on a real host scope without Android files. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession): NativeLibraryOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return NativeLibraryOwner(scope, null)
    }

    /** Test seam: the pinned reader with an explicit access selection and no
     * local source store. Production reaches the same reader through
     * [NativeLibraryOwner.reader]. */
    internal fun reader(access: () -> LibraryReader.Access): LibraryReader =
        LibraryReader(access) { _, _ -> error("local source reader requires an application context") }

    internal fun version(item: JSONObject) = LibraryCaptureProjection.version(item)
    internal fun observations(item: JSONObject) = LibraryCaptureProjection.observations(item)
}

/** Durable owner: the plugin scope owns the Library page factory, the pinned
 * reader session, projections and local source pages. A stopped scope leaves no
 * stale reader or browse surface behind. */
internal class NativeLibraryOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val context: Context?,
) {
    @Volatile private var closed = false
    private val readers = java.util.concurrent.CopyOnWriteArraySet<() -> Unit>()

    init {
        scope?.registerService(PluginServiceRegistration("library.browse", "${NativeLibraryPlugin.CAPABILITY}.browse"))
        scope?.registerService(PluginServiceRegistration("library.reader", "${NativeLibraryPlugin.CAPABILITY}.reader"))
        scope?.registerService(PluginServiceRegistration("library.sources", "${NativeLibraryPlugin.CAPABILITY}.sources"))
        scope?.registerService(PluginServiceRegistration("library.memory-topics", "${NativeLibraryPlugin.CAPABILITY}.memory-topics"))
        scope?.defer { close() }
    }

    internal val active get() = !closed && scope?.revoked != true

    internal fun requireActive() { check(active) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") } }
    internal fun onClose(withdraw: () -> Unit): () -> Unit {
        readers.add(withdraw)
        if (!active) { readers.remove(withdraw); withdraw() }
        return { readers.remove(withdraw); Unit }
    }

    fun releaseCapture(id: String, version: String, current: () -> Unit) {
        val app = requireNotNull(context); val queue = app.queue()
        fun authorized() { requireActive(); current() }
        authorized()
        val original = requireNotNull(queue.archiveRecord(id)).first
        val drafts = app.recordDraftStore()
        if (original.optString("source") == "note") {
            drafts.requireReleasable(id)
            check(dev.mote.collector.QuickNotes.draft(app).read().prepared?.optString("id") != id) { MoteI18n.text("采集阶段仍有待处理输入，暂不能清理本机副本。") }
        }
        val libraryVersion = original.optJSONObject(ReleasedCapture.FIELD)?.getString("libraryVersion")
            ?: app.captureLibraryVersion(original, original.optString("_blob").takeIf(String::isNotBlank))
        queue.releaseContent(id, version, libraryVersion, ::authorized)
    }

    fun localCapture(id: String, version: String?, current: () -> Unit): Pair<JSONObject, ByteArray?> {
        requireActive(); current()
        val queue = requireNotNull(context).queue()
        val original = requireNotNull(queue.archiveRecord(id)).first
        if (version != null) check(CaptureUploadVersion.of(original) == version) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
        val release = original.optJSONObject(ReleasedCapture.FIELD)
        if (release == null || release.getBoolean("pending")) return (requireNotNull(queue.capture(id)) to if (release == null) queue.image(id) else null)
        return readOriginal(original.getJSONObject("_archiveAcknowledgment").getString("origin"), current) { client, authorized ->
            fun exact() { authorized(); check(queue.archiveRecord(id)?.first?.optJSONObject(ReleasedCapture.FIELD)?.toString() == release.toString()) }
            ArchivedOriginal.capture(client, original, ::exact).let { (record, image) ->
                exact(); record.put("localContentRelease", release).put("archiveAcknowledgment", original.getJSONObject("_archiveAcknowledgment")) to image
            }
        }
    }

    fun releaseMeeting(id: String, current: () -> Unit) {
        requireActive(); current(); val app = requireNotNull(context); val settings = Settings(app)
        val store = app.meetingRecordings(); check(store.sessions().first { it.id == id }.origin == settings.dataOrigin())
        store.releaseContent(id, settings.deviceId) { requireActive(); current() }
    }

    fun saveMeeting(id: String, destination: () -> java.io.OutputStream, current: () -> Unit) {
        val app = requireNotNull(context); val store = app.meetingRecordings(); val session = store.sessions().first { it.id == id }
        readOriginal(requireNotNull(session.origin), current) { client, authorized ->
            fun exact() { authorized(); check(store.sessions().firstOrNull { it.id == id } == session) }
            ArchivedOriginal.saveMeeting(client, session, app.cacheDir, destination, ::exact)
        }
    }

    private fun <T> readOriginal(origin: String, current: () -> Unit, read: (CentralClient, () -> Unit) -> T): T {
        val app = requireNotNull(context); val selection = CentralAccess.resolve(app); val connection = Settings(app).connectionGeneration()
        check(origin == selection.server) { MoteI18n.text("原中央与当前连接不一致，未发送读取请求。") }
        val client = requireNotNull(selection.client) { MoteI18n.text("先登录中央，各页面会共用这次登录") }
        fun authorized() {
            requireActive(); current(); val selected = CentralAccess.resolve(app)
            check(Settings(app).connectionGeneration() == connection && selected.server == selection.server && selected.generation == selection.generation && selected.client != null) { MoteI18n.text("访问凭据已失效，请重新连接。") }
        }
        return TransferRequestGuard.within(::authorized) { read(client, ::authorized).also { authorized() } }
    }

    fun library(screens: CentralScreens): CentralLibrary {
        check(active) { "Native library plugin is stopped" }
        return CentralLibrary(screens)
    }

    fun topics(
        screens: CentralScreens,
        controls: (android.widget.LinearLayout, Boolean) -> Unit,
        statusLabel: (JSONObject) -> String,
        openMemory: (String, () -> Unit, (JSONObject) -> Boolean) -> Unit,
    ): CentralMemoryTopics {
        check(active) { "Native library plugin is stopped" }
        return CentralMemoryTopics(screens, controls, statusLabel, openMemory)
    }

    fun captureProjection() = LibraryCaptureProjection()

    fun sourceProjection() = LibrarySourceProjection()

    fun sourceBar(activity: MoteActivity, filter: LibrarySourceFilter, select: (LibrarySourceFilter) -> Unit): LibrarySourceBar {
        requireActive()
        return LibrarySourceBar(activity, filter, select)
    }

    fun refreshPolicy(revision: Long? = null, count: Int? = null) = LibraryRefreshPolicy(revision, count)

    fun localPage(context: Context, after: String, before: String, cursor: Pair<String, String>?, kind: String, sourceId: String): LibraryLocalSources.Page =
        LibraryLocalSources.page(context, after, before, cursor, kind, sourceId)

    fun supportsCapture(source: String) = CentralCaptureReader.supports(source)

    fun openCapture(activity: Activity, origin: String, row: JSONObject, conversationId: String?, workMemory: WorkMemoryReference?, accessGeneration: Long?, citationExcerpt: String? = null) =
        CentralCaptureReader.open(activity, origin, row, conversationId, workMemory, accessGeneration, citationExcerpt)

    /** The only pinned reader for this Library scope. A new Activity view gets a
     * new session; the access selection is resolved on every read so a revoked
     * session can never reuse a previously loaded body. */
    fun reader(): LibraryReader {
        check(active) { "Native library plugin is stopped" }
        val app = requireNotNull(context) { "The library reader requires an application context" }
        return LibraryReader(
            access = {
                val selection = CentralAccess.resolve(app)
                LibraryReader.Access(selection.server, selection.generation, selection.client)
            },
        ) { request, offset ->
            val pinned = LibraryLocalSources.pinned(app, request.source, request.external, request.revision)
            LibraryReader.localPage(pinned, offset)
        }
    }

    fun close() {
        if (closed) return
        closed = true
        readers.toList().forEach { runCatching(it) }; readers.clear()
    }
}

internal class LibrarySourceBar(
    private val activity: MoteActivity,
    initial: LibrarySourceFilter,
    private val onSelect: (LibrarySourceFilter) -> Unit,
) : LinearLayout(activity) {
    private val task = UiTask(activity)
    private val settings = Settings(activity)
    private var selected = initial
    private var phone: LibrarySourceChoice? = null
    private var centralChoices = emptyList<LibrarySourceChoice>()
    private var accessGeneration: Pair<String, Long>? = null
    private var lastReadAt: Long? = null
    private var sourceRevision: String? = null
    private var active = false
    private var face: LibraryCaptureFace? = null
    private val choices = LinearLayout(activity).apply { tag = "library-source-bar" }
    private val capture = LinearLayout(activity).apply { orientation = VERTICAL; visibility = View.GONE }
    private val status = LinearLayout(activity).apply { orientation = VERTICAL }

    init {
        orientation = VERTICAL
        addView(HorizontalScrollView(activity).apply {
            isHorizontalScrollBarEnabled = false
            contentDescription = MoteI18n.text("来源")
            addView(choices)
        }, LayoutParams(-1, -2))
        addView(capture)
        addView(status)
        updatePhone()
    }

    fun updatePhone() {
        val nextPhone = SourceProviderPlugin.libraryPhone(settings.enabled && settings.screenPausedAt() == null, settings.state(), settings.syncState())
        val nextFace = runCatching { LibraryCaptureFaces.of(captureFacts()) }.getOrNull()
        if (phone == nextPhone && face == nextFace) return
        phone = nextPhone
        face = nextFace
        render()
    }

    fun resume() { active = true; refresh() }
    fun pause() { active = false }
    fun close() { pause(); task.close() }

    fun sourcesRevision(revision: String) {
        val previous = sourceRevision
        sourceRevision = revision
        refresh(force = previous != null && previous != revision)
    }

    fun refresh(force: Boolean = false) {
        if (!active) return
        updatePhone()
        val access = CentralAccess.resolve(activity)
        val identity = access.server to access.generation
        if (accessGeneration != identity) {
            accessGeneration = identity
            centralChoices = emptyList()
            lastReadAt = null
            status.removeAllViews()
            if (selected is LibrarySourceFilter.Device || selected is LibrarySourceFilter.Service) select(LibrarySourceFilter.All)
            else render()
        }
        val client = access.client ?: return
        if (task.busy) return
        val now = SystemClock.elapsedRealtime()
        if (!force && lastReadAt?.let { now - it < 30_000 } == true) return
        val prior = lastReadAt
        lastReadAt = now
        status.removeAllViews()
        if (prior == null) status.addView(MoteComponents.loadingLine(activity, MoteI18n.text("正在读取…")))
        task.start("", {}, {
            fun read(path: String) = runCatching { client.get(path) }
            val reports = read("/api/devices")
            val connections = read("/api/connections")
            val services = read("/api/sources").mapCatching(SourceProviderPlugin::libraryServices)
            val devices = runCatching { SourceProviderPlugin.libraryDevices(reports.getOrNull(), connections.getOrNull(), settings.deviceId) }
            val failures = listOf(reports, connections, services, devices).mapNotNull { it.exceptionOrNull() }
            (devices.getOrDefault(emptyList()) + services.getOrDefault(emptyList())) to failures
        }) { result ->
            if (!active) { lastReadAt = null; return@start }
            val current = CentralAccess.resolve(activity)
            if (accessGeneration != identity || identity != (current.server to current.generation)) { refresh(); return@start }
            val (values, errors) = result.getOrElse { emptyList<LibrarySourceChoice>() to listOf(it) }
            centralChoices = values
            if (errors.isEmpty() && selected !in values.map { it.filter } && (selected is LibrarySourceFilter.Device || selected is LibrarySourceFilter.Service)) {
                select(LibrarySourceFilter.All)
            } else render()
            status.removeAllViews()
            if (errors.isNotEmpty()) {
                val text = when {
                    errors.any { it is CentralFailure && it.status in setOf(401, 403, 410) } -> MoteI18n.text("已失效")
                    errors.all { it is java.io.IOException } -> MoteI18n.text("已离线")
                    else -> MoteI18n.text("状态读取失败。")
                }
                status.addView(MoteComponents.banner(activity, null, text, actionLabel = "重试") { refresh(force = true) })
            }
        }
    }

    private fun select(filter: LibrarySourceFilter) {
        if (filter == selected) return
        selected = filter
        render()
        onSelect(filter)
    }

    private fun render() {
        choices.removeAllViews()
        val all = LibrarySourceChoice(LibrarySourceFilter.All, MoteI18n.text("全部"), null)
        for (choice in listOfNotNull(all, phone) + centralChoices) {
            val activeChoice = selected == choice.filter
            val label = listOfNotNull(choice.name, choice.status?.label()).joinToString(" · ")
            val role = if (activeChoice) MoteUi.ButtonRole.PRIMARY else MoteUi.ButtonRole.SECONDARY
            val chip = MoteComponents.button(activity, label, role) { select(choice.filter) }.apply {
                isSelected = activeChoice
                maxWidth = activity.moteDp(244)
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                tag = when (val filter = choice.filter) {
                    LibrarySourceFilter.All -> "library-source:all"
                    LibrarySourceFilter.Phone -> "library-source:phone"
                    is LibrarySourceFilter.Device -> "library-source:device:${filter.id}"
                    is LibrarySourceFilter.Service -> "library-source:service:${filter.id}"
                }
                val glyph = when {
                    choice.platform in setOf("android", "ios") -> MoteGlyph.PHONE
                    choice.platform != null -> MoteGlyph.LAPTOP
                    choice.filter is LibrarySourceFilter.Service -> MoteGlyph.LINK
                    else -> null
                }
                glyph?.let { setCompoundDrawablesRelativeWithIntrinsicBounds(it.drawable, 0, 0, 0); compoundDrawablePadding = activity.moteDp(6) }
            }
            val attention = choice.filter == LibrarySourceFilter.Phone && face?.attention == true
            if (attention) chip.contentDescription = listOf(label, MoteI18n.text("需要处理")).joinToString("，")
            choices.addView(if (attention) phoneDot(chip) else chip, LayoutParams(-2, -2).apply { marginEnd = activity.moteDp(6) })
        }
        renderCapture()
    }

    /** The "这台手机" dot when capture needs the owner; the tab bar carries the same answer. */
    private fun phoneDot(chip: View): View = FrameLayout(activity).apply {
        addView(chip, FrameLayout.LayoutParams(-2, -2))
        addView(View(activity).apply {
            tag = "library-source-dot:phone"
            background = MoteUi.shape(activity, NativeColorRole.WARNING, NativeRadiusRole.PILL, false)
        }, FrameLayout.LayoutParams(activity.moteDp(8), activity.moteDp(8), Gravity.TOP or Gravity.END).apply {
            topMargin = activity.moteDp(1); marginEnd = activity.moteDp(6)
        })
    }

    /** The same one-line capture answer as the panel and notification, on the selected phone only. */
    private fun renderCapture() {
        capture.removeAllViews()
        val face = face
        if (selected != LibrarySourceFilter.Phone || face == null) { capture.visibility = View.GONE; return }
        capture.addView(MoteComponents.row(activity, MoteGlyph.PHONE, MoteI18n.text("采集与同步"),
            value = face.status, valueColor = if (face.warn) NativeColorRole.WARNING else NativeColorRole.MUTED,
            iconSizeDp = 20) { activity.startActivity(Intent(activity, SourcesActivity::class.java)) }.apply {
            tag = "library-capture-sync"
        })
        capture.visibility = View.VISIBLE
    }

    private fun captureFacts(): CaptureOverview.Facts {
        val config = settings.read()
        val projection = config.effectiveMode() == "projection"
        val screenLive = config.screenCollectionEnabled && (if (projection) ProjectionService.running else CaptureAccessibilityService.connected)
        val systemLive = config.observesSystem() && MediaCollectionService.connected
        return CaptureOverview.Facts(
            enabled = settings.enabled, state = settings.state(), message = settings.message(), used = true,
            screenSelected = config.screenCollectionEnabled, screenLive = screenLive, projection = projection,
            screenPausedAt = settings.screenPausedAt()?.takeIf { !config.screenCollectionEnabled },
            notifications = config.notificationCollectionEnabled, deviceEvents = config.deviceEventCollectionEnabled,
            media = config.mediaCollectionEnabled && config.metadataEnabled, systemLive = systemLive,
            queueFull = false, folders = 0, connected = config.hasSyncConnection(), sendPaused = config.syncPaused,
            sendState = settings.syncState(), pending = null, acknowledged = false,
        )
    }
}

/** The Library-side face of the capture state: the phone dot and the row above the records. */
internal data class LibraryCaptureFace(val status: String, val warn: Boolean, val attention: Boolean)

internal object LibraryCaptureFaces {
    /** Reads the same one-line capture answer as the home, panel and notification. */
    fun of(facts: CaptureOverview.Facts): LibraryCaptureFace {
        val line = CaptureOverview.line(facts)
        val attention = line.kind == CaptureOverview.Kind.ATTENTION
        return LibraryCaptureFace(
            status = line.title.ifBlank { MoteI18n.text("采集已暂停") },
            warn = attention,
            attention = attention,
        )
    }
}

/** Pinned Library reads. Exact references are resolved against the current
 * Central selection before and after every remote response; a changed or
 * withdrawn selection yields [Unreadable] and never a body. Local retained
 * originals stay readable because they do not depend on Central authorization. */
internal class LibraryReader(
    private val access: () -> Access,
    private val local: (Request, Int) -> LibraryPage,
) {
    data class Access(val server: String, val generation: Long, val client: CentralClient?)

    data class Request(
        val origin: String = "",
        val type: String = "",
        val source: String = "",
        val external: String = "",
        val device: String = "",
        val revision: String = "",
        val capture: String = "",
        val local: Boolean = false,
    )

    data class LibraryPage(
        val item: JSONObject,
        val text: String,
        val nextOffset: Int?,
        val range: JSONObject? = null,
        val members: JSONObject? = null,
        val file: JSONObject? = null,
        val fileView: CentralFileView? = null,
        val history: JSONArray? = null,
    )

    sealed interface Result
    data class Available(val page: LibraryPage) : Result
    object Unreadable : Result
    data class Failed(val error: Throwable) : Result

    sealed interface MemberResult
    data class MemberReference(val reference: String) : MemberResult
    data class MemberCapture(val server: String, val record: JSONObject) : MemberResult
    object MemberUnreadable : MemberResult
    data class MemberFailed(val error: Throwable) : MemberResult

    fun open(request: Request, offset: Int = 0, memberOffset: Int = 0): Result {
        if (request.local) return try {
            Available(local(request, offset))
        } catch (error: Throwable) {
            Failed(error)
        }
        val selected = access()
        val client = selected.client
        if (selected.server != request.origin || client == null) return Unreadable
        return try {
            val page = when (request.type) {
                "evidence" -> evidence(client, request, offset)
                "material" -> material(client, request, offset, memberOffset)
                else -> original(client, request, offset)
            }
            if (same(selected)) Available(page) else Unreadable
        } catch (error: Throwable) {
            if (same(selected)) Failed(error) else Unreadable
        }
    }

    /** True when the pinned origin can no longer be read under the current
     * selection. The Activity checks this before publishing a completed body. */
    fun unreadable(request: Request): Boolean {
        if (request.local) return false
        val selected = access()
        return selected.server != request.origin || selected.client == null
    }

    fun selection(): Access = access()

    /** Current capabilities for one exact original. A failure is reported to
     * the caller so a revoked source is not mistaken for a transient outage. */
    fun view(request: Request): CentralFileView? {
        if (request.local || request.capture.isBlank()) return null
        val selected = access()
        val client = selected.client ?: return null
        if (selected.server != request.origin) return null
        val view = CentralFileView.read(client.get("/api/files/" + enc(request.capture) + "/view"))
        return view.takeIf { same(selected) && it.captureId == request.capture }
    }

    fun member(reference: String): MemberResult {
        if (!reference.startsWith("capture:")) return MemberReference(reference)
        val selected = access()
        val client = selected.client ?: return MemberUnreadable
        return try {
            val record = client.get("/api/capture-browser/" + enc(reference.removePrefix("capture:")))
            if (same(selected)) MemberCapture(selected.server, record) else MemberUnreadable
        } catch (error: Throwable) {
            if (same(selected)) MemberFailed(error) else MemberUnreadable
        }
    }

    fun export(context: Context, request: Request, generation: Long?, origin: String?, destination: Uri) {
        val selected = access()
        check(selected.generation == generation && selected.server == origin) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
        val client = selected.client ?: error(MoteI18n.text("先登录中央，各页面会共用这次登录"))
        val output = context.contentResolver.openOutputStream(destination) ?: error("Destination unavailable")
        output.use { client.download("/api/files/" + enc(request.capture) + "/content", it) }
    }

    private fun same(selected: Access): Boolean {
        val current = access()
        return current.server == selected.server && current.generation == selected.generation
    }

    private fun evidence(client: CentralClient, request: Request, offset: Int): LibraryPage {
        val result = client.post(
            "/api/context/read",
            JSONObject().put("refs", JSONArray().put(request.source)).put("offset", offset).put("length", 4000),
        )
        val item = result.getJSONArray("items").optJSONObject(0)
            ?: throw IllegalStateException(MoteI18n.text("资料不存在或已删除。"))
        val range = item.optJSONObject("textRange")
        return LibraryPage(item, item.optString("text"), nextOffset(range), range = range)
    }

    private fun material(client: CentralClient, request: Request, offset: Int, memberOffset: Int): LibraryPage {
        val path = "/api/materials/" + enc(request.source)
        val revision = enc(request.revision)
        val read = client.get("$path/read?revision=$revision&offset=$offset&length=4000")
        val item = read.getJSONObject("material")
        check(item.getString("ref") == "material:${request.source}@${request.revision}") { invalidPinnedVersion() }
        val range = read.getJSONObject("textRange")
        val members = client.get("$path/members?revision=$revision&offset=$memberOffset&limit=20")
        return LibraryPage(item, read.getString("text"), nextOffset(range), range = range, members = members)
    }

    private fun original(client: CentralClient, request: Request, offset: Int): LibraryPage {
        val record = client.get("/api/capture-browser/" + enc(request.capture))
        val provenance = record.getJSONObject("provenance")
        check(
            record.getString("id") == request.capture && record.getString("deviceId") == request.device &&
                provenance.getString("sourceId") == request.source && provenance.getString("externalId") == request.external &&
                provenance.getString("revision") == request.revision,
        ) { invalidPinnedVersion() }
        val file = if (record.has("fileArchive")) client.get("/api/files/" + enc(request.capture)).also {
            check(it.getString("captureId") == request.capture)
        } else null
        val fileView = file?.let {
            CentralFileView.read(client.get("/api/files/" + enc(request.capture) + "/view")).also { view ->
                check(view.captureId == request.capture && view.revision == it.getJSONObject("item").optString("revision")) { invalidPinnedVersion() }
            }
        }
        val history = client.get("/api/sources/" + enc(request.source) + "/history?externalId=" + enc(request.external)).getJSONArray("items")
        val content = record.optString("ocrText")
        val next = if (content.length > offset + 4000) offset + 4000 else null
        return LibraryPage(record, content.drop(offset).take(4000), next, file = file, fileView = fileView, history = history)
    }

    private fun nextOffset(range: JSONObject?) = if (range == null || range.isNull("nextOffset")) null else range.getInt("nextOffset")

    private fun invalidPinnedVersion() = MoteI18n.text("此版本已变化，请返回资料列表重新选择。")

    private fun enc(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    companion object {
        internal fun localPage(pinned: LibraryLocalSources.Pinned, offset: Int) = LibraryPage(
            pinned.item,
            pinned.content.drop(offset).take(4000),
            if (pinned.content.length > offset + 4000) offset + 4000 else null,
        )
    }
}
