package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import android.net.Uri
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralCaptureReader
import dev.mote.collector.CentralClient
import dev.mote.collector.CentralLibrary
import dev.mote.collector.CentralMemoryTopics
import dev.mote.collector.CentralScreens
import dev.mote.collector.LibraryCaptureProjection
import dev.mote.collector.LibraryLocalSources
import dev.mote.collector.LibraryRefreshPolicy
import dev.mote.collector.LibrarySourceProjection
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.WorkMemoryReference
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

    init {
        scope?.registerService(PluginServiceRegistration("library.browse", "${NativeLibraryPlugin.CAPABILITY}.browse"))
        scope?.registerService(PluginServiceRegistration("library.reader", "${NativeLibraryPlugin.CAPABILITY}.reader"))
        scope?.registerService(PluginServiceRegistration("library.sources", "${NativeLibraryPlugin.CAPABILITY}.sources"))
        scope?.registerService(PluginServiceRegistration("library.memory-topics", "${NativeLibraryPlugin.CAPABILITY}.memory-topics"))
        scope?.defer { close() }
    }

    internal val active get() = !closed && scope?.revoked != true

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

    fun refreshPolicy(revision: Long? = null, count: Int? = null) = LibraryRefreshPolicy(revision, count)

    fun localPage(context: Context, after: String, before: String, cursor: Pair<String, String>?, kind: String, sourceId: String): LibraryLocalSources.Page =
        LibraryLocalSources.page(context, after, before, cursor, kind, sourceId)

    fun supportsCapture(source: String) = CentralCaptureReader.supports(source)

    fun openCapture(activity: Activity, origin: String, row: JSONObject, conversationId: String?, workMemory: WorkMemoryReference?, accessGeneration: Long?) =
        CentralCaptureReader.open(activity, origin, row, conversationId, workMemory, accessGeneration)

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
        val history = client.get("/api/sources/" + enc(request.source) + "/history?externalId=" + enc(request.external)).getJSONArray("items")
        val content = record.optString("ocrText")
        val next = if (content.length > offset + 4000) offset + 4000 else null
        return LibraryPage(record, content.drop(offset).take(4000), next, file = file, history = history)
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
