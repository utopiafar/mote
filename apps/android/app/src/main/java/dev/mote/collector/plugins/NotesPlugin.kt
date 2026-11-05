package dev.mote.collector.plugins

import android.content.Context
import dev.mote.collector.CollectorConfig
import dev.mote.collector.ConnectionFailure
import dev.mote.collector.ConnectionGuard
import dev.mote.collector.LocalDataFormat
import dev.mote.collector.localContentCipher
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.NoteDraftController
import dev.mote.collector.NoteDraftOperations
import dev.mote.collector.NoteDraftStore
import dev.mote.collector.RecordDraftStore
import dev.mote.collector.Settings
import dev.mote.collector.SupportEvents
import dev.mote.collector.UploadWorker
import dev.mote.collector.EventCode
import dev.mote.collector.EventStage
import dev.mote.collector.queue
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Build-native notes provider. The plugin owns the editable drafts, their
 * encrypted attachment originals and both note submission paths; Activities
 * only route intents, render the editor and return the local receipt. */
object NotesPlugin {
    const val CAPABILITY = "mote.notes"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.notes"
    private const val PACKAGE_ID = "dev.mote.notes"
    private const val INSTALLATION_ID = "build-native"

    private val executor = Executors.newSingleThreadExecutor()
    internal val io: ExecutorService = executor
    private val owners = ConcurrentHashMap<String, NotesOwner>()
    private val recordStores = ConcurrentHashMap<String, RecordDraftStore>()
    private val homeStores = ConcurrentHashMap<String, NoteDraftStore>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    internal fun owner(context: Context): NotesOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        return owners.computeIfAbsent(key) {
            open(app, draftStore(app), homeStore(app), io, host = (app as? MoteApplication)?.pluginHost)
        }
    }

    private fun open(app: Context, draft: RecordDraftStore, home: NoteDraftStore, executor: ExecutorService, host: NativePluginHost?): NotesOwner {
        if (host == null) return NotesOwner(app, draft, home, executor, null, null)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = host.scope(INSTANCE_ID) ?: run {
            val descriptor = PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(NativeRequirement(CAPABILITY, API_VERSION)))
            (host.createScope(descriptor) as? PluginResult.Ok)?.value
                ?: error("notes plugin provider is unavailable")
        }
        val started = host.startPlugin(scope) { session ->
            session.registerJob(PluginJob("notes.draft", durable = true))
            NotesOwner(app, draft, home, executor, host, session)
        }
        return (started as? PluginResult.Ok)?.value ?: error((started as PluginResult.Failed).message)
    }

    internal fun draftStore(context: Context): RecordDraftStore {
        LocalDataFormat.requireCurrent(context)
        val app = context.applicationContext
        val directory = File(app.noBackupFilesDir, "record-draft")
        return recordStores.computeIfAbsent(directory.absolutePath) {
            RecordDraftStore(directory, app.localContentCipher()) {
                app.getSharedPreferences("mote", Context.MODE_PRIVATE).getInt("maxQueue", 256) * 1024L * 1024L -
                    app.queue().stats().bytes -
                    File(app.filesDir, "record-pending").listFiles().orEmpty().sumOf { file -> file.length() }
            }
        }
    }

    internal fun homeStore(context: Context): NoteDraftStore {
        LocalDataFormat.requireCurrent(context)
        val app = context.applicationContext
        val directory = File(app.noBackupFilesDir, "note-draft")
        return homeStores.computeIfAbsent(directory.absolutePath) { NoteDraftStore(directory, app.localContentCipher()) }
    }

    internal fun controller(context: Context): NoteDraftController = owner(context).controller

    fun saveQuickNote(context: Context, text: String, mood: String): String =
        saveQuickNote(context, text, mood) { config -> UploadWorker.schedule(context, config) }

    internal fun saveQuickNote(context: Context, text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String =
        owner(context).saveQuickNote(text, mood, scheduleUpload)

    /** Test seam: a real host scope plus private stores, without Android file
     * or application wiring. */
    internal fun open(host: NativePluginHost, scope: PluginOwnerSession, draft: RecordDraftStore, home: NoteDraftStore, executor: ExecutorService = io): NotesOwner =
        NotesOwner(null, draft, home, executor, host, scope)
}

/** Durable owner: drafts, attachment originals, the home quick-note controller
 * and the local receipt outlive every editor view. */
internal class NotesOwner internal constructor(
    private val context: Context?,
    internal val draft: RecordDraftStore,
    private val home: NoteDraftStore,
    internal val executor: ExecutorService,
    private val host: NativePluginHost?,
    private val scope: PluginOwnerSession?,
) {
    internal val controller = NoteDraftController(object : NoteDraftOperations {
        override fun read() = home.read()
        override fun update(text: String, mood: String) = home.update(text, mood)
        override fun clear() = home.clear()
        override fun save(text: String, mood: String) = saveQuickNote(text, mood) { config -> requireContext().let { UploadWorker.schedule(it, config) } }
    }, executor)

    internal fun view(): NotesEditor {
        val session = if (host != null && scope != null) host.onViewRecreated(scope) else null
        return NotesEditor(this, session)
    }

    private fun validateConversation(origin: JSONObject, presentation: JSONObject?, settings: Settings) {
        if (origin.optString("kind") == "conversation") {
            check(presentation?.optString("server") == settings.dataOrigin() && settings.dataOrigin().isNotBlank()) {
                MoteI18n.text("访问凭据已失效，请重新连接。")
            }
        }
    }

    private fun recordEvent(text: String, origin: JSONObject, description: String, settings: Settings, config: CollectorConfig) =
        JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId).put("deviceName", config.deviceName)
            .put("platform", "android").put("capturedAt", Instant.now().toString()).put("durationMs", 0)
            .put("appId", "dev.mote.notes").put("appName", MoteI18n.text("记录")).put("source", "note").put("ocrText", text)
            .put("metadata", JSONObject().put("version", 1).put("observedAt", Instant.now().toString()).put("noteOrigin", origin).also { metadata ->
                description.takeIf { it.isNotBlank() }?.let { metadata.put("ownerDescription", it) }
            })
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))

    private fun receipt(id: String, firstUse: Boolean): String {
        NativeRecordReceipt.recordId = id
        NativeRecordReceipt.fromFirstUse = firstUse
        return id
    }

    internal fun submitRecord(text: String, attachments: JSONArray, origin: JSONObject, description: String, presentation: JSONObject?, firstUse: Boolean): String {
        val app = requireContext()
        val id = ConnectionGuard.sync {
            draft.edit(text, attachments, origin, description, presentation)
            val settings = Settings(app)
            val config = settings.read()
            config.validate()
            validateConversation(origin, presentation, settings)
            val event = draft.prepare(settings.dataOrigin()) { current ->
                recordEvent(current.getString("text"), current.getJSONObject("origin"), current.optString("description"), settings, config)
            }
            app.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
            // The draft is retained with its prepared identity: only explicit Clear or an
            // edit ends it, and a repeated save reuses the same queued record.
            runCatching { UploadWorker.schedule(app, config) }
            event.getString("id")
        } ?: error(MoteI18n.text("请稍后重试"))
        return receipt(id, firstUse)
    }

    internal fun submitStandalone(text: String, attachments: JSONArray, origin: JSONObject, description: String, presentation: JSONObject?): String {
        val app = requireContext()
        val id = ConnectionGuard.sync {
            val settings = Settings(app)
            val config = settings.read()
            config.validate()
            require(text.length <= 100000 && attachments.length() <= 10 && description.length <= 12000)
            validateConversation(origin, presentation, settings)
            val event = recordEvent(text, origin, description, settings, config)
            draft.prepareSubmission(settings.dataOrigin(), event, attachments, presentation)
            app.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
            runCatching { UploadWorker.schedule(app, config) }
            event.getString("id")
        } ?: error(MoteI18n.text("请稍后重试"))
        return receipt(id, false)
    }

    internal fun saveQuickNote(text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String =
        ConnectionGuard.sync { saveCurrent(text, mood, scheduleUpload) } ?: throw ConnectionFailure("busy")

    private fun saveCurrent(text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String {
        val app = requireContext()
        require(text.isNotBlank() && text.length <= 100_000) { MoteI18n.text("记录须为 1..100000 字符") }
        require(mood.length <= 80) { MoteI18n.text("心情最多 80 字符") }
        home.update(text, mood)
        val settings = Settings(app)
        val config = settings.read()
        config.validate()
        val prepared = home.prepare(settings.dataOrigin()) {
            val id = UUID.randomUUID().toString()
            val event = JSONObject().put("id", id).put("deviceId", settings.deviceId).put("deviceName", config.deviceName)
                .put("platform", "android").put("capturedAt", Instant.now().toString()).put("durationMs", 0)
                .put("appId", "dev.mote.notes").put("appName", MoteI18n.text("记录")).put("ocrText", text).put("source", "note")
                .apply { if (config.metadataEnabled) put("metadata", dev.mote.collector.CollectorMetadata.snapshot(app, "manual")) }
                .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
            if (mood.isNotBlank()) event.put("mood", mood)
            event
        }
        val event = prepared.prepared!!
        app.queue().enqueue(event, null, config.maxQueueMiB * 1024L * 1024L)
        SupportEvents.record(app, EventStage.NOTE, EventCode.OK)
        try { scheduleUpload(config) } catch (_: Exception) {
            SupportEvents.record(app, EventStage.NOTE, EventCode.SCHEDULER)
            settings.uploadStatus(MoteI18n.text("记录已入队，同步调度未完成；草稿保持原提交 ID，可安全重试"))
            throw IllegalStateException(MoteI18n.text("记录已保存在队列；同步调度暂不可用，再次保存会重试同一条记录"))
        }
        home.clear()
        return event.getString("id")
    }

    private fun requireContext() = checkNotNull(context) { "notes submission requires an application context" }
}

/** Eager view-scoped surface used by the editor Activity. Closing it, or a
 * host view recreate, drops only callbacks; drafts and originals stay in the
 * durable owner. */
internal class NotesEditor internal constructor(private val owner: NotesOwner, private val session: PluginViewSession?) {
    @Volatile var closed = false; private set
    val io: ExecutorService get() = owner.executor
    private val contribution = object : PluginViewContribution {
        override val routeId = "notes.editor"
        override fun dispose() { closed = true }
    }

    init { session?.registerView(contribution) }

    fun close() {
        if (closed) return
        closed = true
        session?.dispose()
    }

    fun draft(): JSONObject = owner.draft.draft()
    fun edit(text: String, attachments: JSONArray, origin: JSONObject, description: String = "", presentation: JSONObject? = null) =
        owner.draft.edit(text, attachments, origin, description, presentation)
    fun clearDraft(): JSONObject = owner.draft.clear()
    fun restoreDraft(draft: JSONObject) = owner.draft.restore(draft)
    fun stage(bytes: ByteArray, name: String, mime: String, stagedId: String? = null): JSONObject = owner.draft.stage(bytes, name, mime, stagedId)
    fun holdMedia(item: JSONObject) = owner.draft.holdMedia(item)
    fun finishMedia(id: String) = owner.draft.finishMedia(id)
    fun pendingMedia(): JSONArray = owner.draft.pendingMedia()
    fun bytes(id: String): ByteArray = owner.draft.bytes(id)
    fun record(id: String): JSONObject? = owner.draft.record(id)
    fun submit(text: String, attachments: JSONArray, origin: JSONObject, description: String, presentation: JSONObject?, firstUse: Boolean): String =
        owner.submitRecord(text, attachments, origin, description, presentation, firstUse)
    fun submitStandalone(text: String, attachments: JSONArray, origin: JSONObject, description: String, presentation: JSONObject?): String =
        owner.submitStandalone(text, attachments, origin, description, presentation)
}

/** The local save receipt belongs to the plugin, not to an Activity instance. */
internal object NativeRecordReceipt {
    @Volatile var recordId: String? = null
    @Volatile var fromFirstUse: Boolean = false
}

/** Current Central note-save acknowledgement. The body carries the capture
 * receipt; duplicate retries preserve the original identity. */
data class NoteSaveReceipt(val id: String, val duplicate: Boolean) {
    companion object {
        fun parse(response: JSONObject): NoteSaveReceipt {
            val invalid = { throw IllegalArgumentException(MoteI18n.text("中央响应格式无效，请刷新后重试。")) }
            val id = runCatching { UUID.fromString(response.getString("id")).toString() }.getOrElse { invalid() }
            val receipt = response.optJSONObject("receipt") ?: invalid()
            if (receipt.optInt("version") != 2 || receipt.optString("kind") != "capture" || receipt.optString("state") != "received") invalid()
            val receiptId = runCatching { UUID.fromString(receipt.getString("id")).toString() }.getOrElse { invalid() }
            if (receiptId != id || !receipt.has("duplicate") || receipt.getBoolean("duplicate") != response.optBoolean("duplicate")) invalid()
            return NoteSaveReceipt(id, receipt.getBoolean("duplicate"))
        }
    }
}
