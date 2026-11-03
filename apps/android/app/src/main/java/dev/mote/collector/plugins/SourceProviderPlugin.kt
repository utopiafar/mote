package dev.mote.collector.plugins

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import dev.mote.collector.ByteCipher
import dev.mote.collector.CalendarChoice
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralFailure
import dev.mote.collector.FileArchiveQueue
import dev.mote.collector.FileSyncProgress
import dev.mote.collector.HttpJson
import dev.mote.collector.LocalContentPresentation
import dev.mote.collector.LocalSource
import dev.mote.collector.LocalSourceStore
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.Settings
import dev.mote.collector.SourceAccess
import dev.mote.collector.SourceContextSnapshot
import dev.mote.collector.SourceProviders
import dev.mote.collector.SourceRules
import dev.mote.collector.SourceWork
import dev.mote.collector.binaryFiles
import dev.mote.collector.fileArchives
import dev.mote.collector.localContentCipher
import dev.mote.collector.localSources
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

/** Build-native source provider. The plugin owns source configuration,
 * adapters, scheduling, file traversal, the encrypted archive queue and the
 * provider-backed metadata/context operations. Activities route intents and
 * render returned state; WorkManager only instantiates the workers. */
internal object SourceProviderPlugin {
    const val CAPABILITY = "mote.sources"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.sources"
    private const val PACKAGE_ID = "dev.mote.sources"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, SourceOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId, osGrants = listOf("calendar", "documents")))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the one application-scoped source owner. Repeating startup returns
     * the same owner; a stopped scope is replaced with a fresh admission. */
    internal fun start(context: Context, host: NativePluginHost): SourceOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active && host.scope(INSTANCE_ID) != null }?.let { return it }
        synchronized(this) {
            owners[key]?.takeIf { it.active && host.scope(INSTANCE_ID) != null }?.let { return it }
            host.scope(INSTANCE_ID)?.let { host.stopScope(INSTANCE_ID) }
            val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
            val descriptor = PluginInstanceDescriptor(identity, setOf("sources", "source-files"), requires = listOf(requirement()))
            val scope = when (val admitted = host.createScope(descriptor)) {
                is PluginResult.Ok -> admitted.value
                is PluginResult.Failed -> error("${admitted.code}: ${admitted.message}")
            }
            val owner = SourceOwner(
                context = app,
                scope = scope,
                store = app.localSources(),
                queue = app.fileArchives(),
                scheduler = WorkManagerSourceScheduler(app),
                authorization = { SourceAccess.available(app, it) },
                cipher = app.localContentCipher(),
            )
            val started = host.startPlugin(scope) { owner }
            val value = when (started) {
                is PluginResult.Ok -> started.value
                is PluginResult.Failed -> error("${started.code}: ${started.message}")
            }
            owners[key] = value
            return value
        }
    }

    internal fun owner(context: Context): SourceOwner {
        val app = context.applicationContext
        owners[app.noBackupFilesDir.absolutePath]?.takeIf { it.active }?.let { return it }
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: error("source plugin provider is unavailable")
        return start(app, host)
    }

    /** Test seam: a real host scope, private stores and an injected scheduler. */
    internal fun open(
        host: NativePluginHost,
        scope: PluginOwnerSession,
        store: LocalSourceStore,
        queue: FileArchiveQueue,
        scheduler: SourceScheduler,
        authorization: (LocalSource) -> Boolean = { true },
        cipher: ByteCipher? = null,
    ): SourceOwner = SourceOwner(null, scope, store, queue, scheduler, authorization, cipher)
}

/** WorkManager scheduling is a plugin port: the source owner can cancel one
 * revoked source without touching its siblings. */
internal interface SourceScheduler {
    fun schedule(manual: Boolean = false, syncExplicit: Boolean = false)
    fun upload(explicit: Boolean = false)
    fun cancel(sourceId: String)
    fun cancelAll()
}

private class WorkManagerSourceScheduler(private val context: Context) : SourceScheduler {
    override fun schedule(manual: Boolean, syncExplicit: Boolean) = SourceWork.schedule(context, manual, syncExplicit)
    override fun upload(explicit: Boolean) = SourceWork.upload(context, explicit)
    override fun cancel(sourceId: String) = SourceWork.cancel(context, sourceId)
    override fun cancelAll() = SourceWork.cancelAll(context)
}

internal data class SourceSnapshot(
    val source: LocalSource,
    val state: JSONObject,
    val pending: Int,
    val progress: FileSyncProgress?,
    val local: List<JSONObject>,
    val localTotal: Int,
    val contextConflict: Boolean,
)

internal data class SourceRevocation(val sourceId: String, val reason: String)

internal data class FileSelection(
    val uri: String,
    val displayName: String,
    val existing: LocalSource?,
    val contextConflict: Boolean,
)

internal data class FileRefresh(val row: JSONObject, val folderSummary: String, val accessGeneration: Long)

/** Values returned by the content page. The Activity only lays them out. */
internal data class FileDetail(
    val source: LocalSource,
    val row: JSONObject,
    val item: JSONObject,
    val access: CentralAccess.Selection,
    val capture: JSONObject?,
    val file: JSONObject?,
    val material: JSONObject?,
    val read: String?,
    val nextOffset: Int?,
    val total: Int?,
    val selectedReader: String?,
    val localPreview: Pair<String, Boolean>?,
    val failed: Boolean,
    val retryRead: Boolean,
    val folderSummary: String,
)

/** Durable owner for source configuration, scheduling, drafts, file archive
 * publication and provider reads. It survives Activity recreate; closing the
 * view only drops the page callbacks, never the source work. */
internal class SourceOwner internal constructor(
    private val context: Context?,
    private val scope: PluginOwnerSession?,
    private val store: LocalSourceStore,
    private val queue: FileArchiveQueue,
    private val scheduler: SourceScheduler,
    private val authorization: (LocalSource) -> Boolean,
    private val cipher: ByteCipher?,
) {
    @Volatile private var closed = false

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("sources.files", "${SourceProviderPlugin.CAPABILITY}.files"))
            scope.registerService(PluginServiceRegistration("sources.schedule", "${SourceProviderPlugin.CAPABILITY}.schedule"))
            scope.registerService(PluginServiceRegistration("sources.context", "${SourceProviderPlugin.CAPABILITY}.context"))
            scope.registerJob(PluginJob("sources.runtime", durable = true))
            scope.defer { close() }
        }
    }

    internal val active: Boolean get() = !closed
    private fun requireActive() = check(active) { "source plugin is stopped" }

    internal fun sources(): List<LocalSource> = store.sources()

    internal fun source(id: String): LocalSource? = store.sources().firstOrNull { it.id == id }

    internal fun state(source: LocalSource): JSONObject =
        if (source.binaryFiles()) queue.state(source.id).put("status", store.state(source.id).optString("status"))
        else store.state(source.id)

    internal fun pending(source: LocalSource): Int =
        if (source.binaryFiles()) queue.pendingCount(source.id) else store.state(source.id).optJSONArray("pending")?.length() ?: 0

    /** One bounded page of the exact source projection consumed by the sources page. */
    internal fun snapshots(detailSourceId: String?, offset: Int, pageSize: Int): List<SourceSnapshot> =
        store.sources().filter { detailSourceId == null || it.id == detailSourceId }.map { source ->
            val local = if (detailSourceId != null && source.binaryFiles())
                queue.rows(source.id).filter { it.optJSONObject("candidate") != null && !it.optBoolean("deleted") }
                    .sortedByDescending { it.getJSONObject("candidate").optString("modifiedAt") }
            else emptyList()
            val state = state(source)
            SourceSnapshot(
                source = source,
                state = state,
                pending = pending(source),
                progress = if (source.binaryFiles()) queue.progress(source) else null,
                local = local.drop(offset).take(pageSize),
                localTotal = local.size,
                contextConflict = state.optString("status") == "context-conflict" &&
                    (source.contextDirty || state.optJSONObject("contextConflict")?.optInt("version", -1) != source.contextVersion),
            )
        }

    internal fun schedule(manual: Boolean = false, syncExplicit: Boolean = false) {
        requireActive()
        reconcileAuthorization()
        scheduler.schedule(manual, syncExplicit)
    }

    internal fun upload(explicit: Boolean = false) {
        requireActive()
        scheduler.upload(explicit)
    }

    internal fun enqueueUpload(config: dev.mote.collector.CollectorConfig, explicit: Boolean, continuation: Boolean = false, delaySeconds: Long = 0) {
        requireActive()
        SourceWork.enqueueUpload(checkNotNull(context) { "source upload requires an application context" }, config, explicit, continuation, delaySeconds)
    }

    /** Explicit pause/resume is the owner's decision; a stale UI action cannot
     * resurrect a source that was removed in the meantime. */
    internal fun setEnabled(id: String): Boolean {
        requireActive()
        val source = source(id) ?: return false
        val changed = store.setEnabled(id, !source.enabled)
        if (changed) {
            if (source.enabled) scheduler.cancel(id)
            scheduler.schedule(manual = true)
        }
        return changed
    }

    internal fun save(source: LocalSource) {
        requireActive()
        store.save(source)
        if (!source.enabled) scheduler.cancel(source.id)
        scheduler.schedule(manual = true)
    }

    internal fun remove(id: String) {
        requireActive()
        val source = store.sources().firstOrNull { it.id == id }
        store.remove(id)
        queue.remove(id)
        source?.uri?.let(::releaseUnused)
        scheduler.cancel(id)
        scheduler.schedule()
    }

    /** Uninstalling a grant that no remaining source uses. A provider may
     * already have revoked it, so release failures are not source failures. */
    internal fun releaseUnused(uri: String) {
        val app = context ?: return
        if (store.sources().none { it.uri == uri }) runCatching {
            app.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    internal fun calendars(): List<CalendarChoice> =
        SourceProviders(checkNotNull(context) { "calendar provider requires an application context" }.contentResolver).calendars()

    /** A revoked SAF grant stops its source and cancels the source-scoped work
     * that would keep waking to retry it. Other sources remain scheduled. */
    internal fun reconcileAuthorization(): List<SourceRevocation> {
        requireActive()
        val revoked = store.sources().filter {
            it.enabled && it.kind == "local-files" && !authorization(it) &&
                !(!it.syncContinuously && queue.state(it.id).optBoolean("importCaptured"))
        }
        revoked.forEach { source ->
            store.status(source.id, "permission")
            scheduler.cancel(source.id)
        }
        if (revoked.isNotEmpty() && store.sources().none { it.enabled && (it.kind != "local-files" || authorization(it)) }) scheduler.cancelAll()
        return revoked.map { SourceRevocation(it.id, "permission") }
    }

    internal fun remoteContext(source: LocalSource): SourceContextSnapshot {
        val app = checkNotNull(context) { "source context requires an application context" }
        val config = Settings(app).read()
        check(config.hasSyncConnection()) { MoteI18n.text("等待网络/节点恢复") }
        val (code, body) = HttpJson.get(config.server.trimEnd('/') + "/api/sources/${source.id}/context", config.connectionToken())
        check(code in 200..299 && body != null) { MoteI18n.text("无法读取中央资料说明；本机草稿保留，请重试。") }
        return SourceContextSnapshot.from(body!!, source.id)
    }

    internal fun confirmContext(source: LocalSource, snapshot: SourceContextSnapshot): LocalSource? {
        val app = checkNotNull(context) { "source context requires an application context" }
        val config = Settings(app).read()
        return store.confirmContext(source, SourceRules.target(config.server, config.token), snapshot)
    }

    internal fun applyContextChoice(source: LocalSource, remote: SourceContextSnapshot, useRemote: Boolean): LocalSource {
        val app = checkNotNull(context) { "source context requires an application context" }
        val config = Settings(app).read()
        return source.copy(
            description = if (useRemote) remote.description else source.description,
            contextVersion = remote.version,
            contextTarget = SourceRules.target(config.server, config.token),
            contextDirty = !useRemote,
        )
    }

    /** Provider selection is routed here so the Activity never takes persisted
     * grants, opens a document or decides whether an existing source applies. */
    internal fun select(uri: String, tree: Boolean, savedSource: LocalSource?): FileSelection {
        val app = checkNotNull(context) { "document selection requires an application context" }
        app.contentResolver.takePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            val document = if (tree) DocumentsContract.buildDocumentUriUsingTree(Uri.parse(uri), DocumentsContract.getTreeDocumentId(Uri.parse(uri))) else Uri.parse(uri)
            val display = app.contentResolver.query(document, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
            val existing = if (savedSource == null) store.sources().find { it.kind == "local-files" && it.uri == uri } else null
            return FileSelection(
                uri = uri,
                displayName = (display ?: MoteI18n.text(if (tree) "选择的文件目录" else "选择的文件")).take(200),
                existing = existing,
                contextConflict = existing?.let { store.state(it.id).optString("status") == "context-conflict" } ?: false,
            )
        } catch (error: Exception) {
            releaseUnused(uri)
            throw error
        }
    }

    /** Save a reviewed form against the exact source it was opened from. A
     * concurrent background context acknowledgement may update only metadata. */
    internal fun saveAgainstOriginal(next: LocalSource, original: LocalSource?, descriptionText: String): LocalSource {
        requireActive()
        val latest = store.sources().find { it.id == next.id }
        val acknowledgedOnly = original != null && latest != null &&
            latest.copy(contextVersion = original.contextVersion, contextDirty = original.contextDirty, contextTarget = original.contextTarget) == original
        check(latest == original || acknowledgedOnly) { MoteI18n.text("来源已在后台更新，请重新打开设置；当前草稿仍在页面中。") }
        val saved = if (acknowledgedOnly &&
            next.contextVersion == original!!.contextVersion && next.contextTarget == original.contextTarget)
            next.copy(contextVersion = latest.contextVersion, contextTarget = latest.contextTarget, contextDirty = latest.contextDirty || descriptionText != latest.description)
        else next
        store.save(saved)
        if (!saved.enabled) scheduler.cancel(saved.id)
        scheduler.schedule(manual = true)
        return saved
    }

    internal fun saveFile(next: LocalSource, original: LocalSource?, descriptionText: String, draftKey: String): LocalSource {
        requireActive()
        return saveAgainstOriginal(next, original, descriptionText).also { saved ->
            draftFile(draftKey)?.delete()
            original?.uri?.takeIf { it != saved.uri }?.let(::releaseUnused)
        }
    }

    internal fun readDraft(key: String): JSONObject? {
        val file = draftFile(key) ?: return null
        if (!file.exists()) return null
        val box = checkNotNull(cipher) { "source drafts require the local content cipher" }
        return JSONObject(String(box.open(file.readBytes()), Charsets.UTF_8))
    }

    internal fun saveDraft(key: String, values: JSONObject, preset: String, retentionEdited: Boolean) {
        val app = context ?: return
        val file = draftFile(key) ?: return
        val box = checkNotNull(cipher) { "source drafts require the local content cipher" }
        val draft = JSONObject().put("values", values).put("preset", preset).put("retentionEdited", retentionEdited)
        val temp = File(file.parentFile, file.name + ".tmp")
        try {
            java.io.FileOutputStream(temp).use {
                it.write(box.seal(draft.toString().toByteArray(Charsets.UTF_8)))
                it.fd.sync()
            }
            check(temp.renameTo(file))
        } finally { temp.delete() }
    }

    internal fun deleteDraft(key: String) { draftFile(key)?.delete() }

    private fun draftFile(key: String): File? {
        val app = context ?: return null
        return File(app.noBackupFilesDir, "file-task-${SourceRules.hash(key)}.enc")
    }

    internal fun fileRefresh(sourceId: String, external: String): FileRefresh {
        val app = checkNotNull(context) { "file refresh requires an application context" }
        val source = store.sources().first { it.id == sourceId }
        val row = queue.presentationRow(source, queue.row(sourceId, external))
        return FileRefresh(row, if (source.tree) LocalContentPresentation.folderStatus(app, source) else "", CentralAccess.resolve(app).generation)
    }

    internal fun fileIdentity(row: JSONObject): String =
        SourceRules.fileSignature(row.getJSONObject("candidate")) + ":" +
            row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item")?.optString("revision").orEmpty() + ":" +
            LocalContentPresentation.currentReceipt(row).orEmpty()

    /** Exact local/Central page used by the file content Activity. All reads
     * happen here; the Activity receives only the bounded presentation. */
    internal fun loadFile(
        sourceId: String,
        external: String,
        offset: Int,
        pinnedReader: String?,
        pinnedCapture: String?,
        pinnedOrigin: String?,
        selectedRevision: String?,
    ): FileDetail {
        val app = checkNotNull(context) { "file content requires an application context" }
        val source = store.sources().first { it.id == sourceId }
        val row = queue.presentationRow(source, queue.row(sourceId, external))
        val item = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item") ?: row.getJSONObject("candidate")
        selectedRevision?.let { selected ->
            val actual = row.optJSONObject("pending")?.optJSONObject("manifest")?.optJSONObject("item")?.optString("revision")
                ?: if (LocalContentPresentation.currentReceipt(row) != null) row.optString("revision")
                else "candidate:" + SourceRules.fileSignature(row.getJSONObject("candidate"))
            check(selected == actual) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
        }
        val local = if (row.has("pending")) runCatching { queue.pendingPreview(sourceId, external, item.getString("revision")) }.getOrNull() else null
        val access = CentralAccess.resolve(app)
        var capture: JSONObject? = null
        var file: JSONObject? = null
        var material: JSONObject? = null
        var read: String? = null
        var next: Int? = null
        var total: Int? = null
        var failed = false
        var retryRead = false
        // A pending newer version must not be represented by the previous version's receipt.
        val id = LocalContentPresentation.currentReceipt(row).orEmpty()
        var selectedReader = pinnedReader
        if (pinnedReader != null) check(id == pinnedCapture && access.server == pinnedOrigin) { MoteI18n.text("此版本已变化，请返回资料列表重新选择。") }
        if (id.isNotBlank() && access.client != null) {
            runCatching {
                val record = access.client.get("/api/capture-browser/" + android.net.Uri.encode(id))
                val provenance = record.optJSONObject("provenance")
                check(record.optString("id") == id && record.optString("deviceId") == Settings(app).deviceId && provenance?.optString("sourceId") == sourceId && provenance.optString("externalId") == external && provenance.optString("revision") == row.optString("revision"))
                capture = record
                file = access.client.get("/api/files/" + android.net.Uri.encode(id))
                check(file?.optString("captureId") == id)
                val ref = pinnedReader ?: record.optString("memoryMaterialRef").takeIf { Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matches(it) } ?: "chunks"
                selectedReader = ref
                val match = Regex("^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$").matchEntire(ref)
                if (match != null) {
                    val materialId = match.groupValues[1]
                    val revision = match.groupValues[2]
                    val page = access.client.get("/api/materials/" + android.net.Uri.encode(materialId) + "/read?offset=$offset&length=4000&revision=" + android.net.Uri.encode(revision))
                    check(page.getJSONObject("material").optString("ref") == ref)
                    material = page.getJSONObject("material")
                    read = page.optString("text")
                    page.optJSONObject("textRange")?.let { range ->
                        total = range.optInt("total")
                        if (!range.isNull("nextOffset")) next = range.getInt("nextOffset")
                    }
                }
                if (ref == "chunks") {
                    val page = access.client.get("/api/files/" + android.net.Uri.encode(id) + "/chunks?offset=$offset")
                    val chunks = page.optJSONArray("items") ?: org.json.JSONArray()
                    read = (0 until chunks.length()).joinToString("\n\n") { chunks.getJSONObject(it).optString("ocrText") }
                    if (!page.isNull("nextOffset")) next = page.getInt("nextOffset")
                }
            }.onFailure { error ->
                failed = true
                retryRead = error !is CentralFailure || error.status !in setOf(401, 403)
                if (error is CentralFailure && error.status in setOf(401, 403, 404, 409, 410)) {
                    capture = null
                    file = null
                    material = null
                    read = null
                    next = null
                    total = null
                }
            }
        }
        return FileDetail(source, row, item, access, capture, file, material, read, next, total, selectedReader, local, failed, retryRead,
            if (source.tree) LocalContentPresentation.folderStatus(app, source) else "")
    }

    internal fun exportPending(sourceId: String, external: String, revision: String, output: OutputStream) =
        queue.exportPending(sourceId, external, revision, output)

    internal fun close() {
        if (closed) return
        closed = true
    }
}

/** The source plugin's scheduling port also fences the legacy global workers
 * when a source is revoked. This is the only code that knows WorkManager names. */
internal object SourceWorkNames {
    const val SCAN = "mote-source-scan"
    const val PERIODIC = "mote-source-periodic"
    const val UPLOAD = "mote-source-upload"
    fun scan(sourceId: String) = "$SCAN:$sourceId"
}
