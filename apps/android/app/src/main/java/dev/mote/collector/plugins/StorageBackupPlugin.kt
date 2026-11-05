package dev.mote.collector.plugins

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.widget.LinearLayout
import dev.mote.collector.AppReleaseVerifier
import dev.mote.collector.BackupDocumentFacts
import dev.mote.collector.BackupDocumentMetadata
import dev.mote.collector.BackupDocumentSelection
import dev.mote.collector.BackupOperationView
import dev.mote.collector.CentralAccess
import dev.mote.collector.CentralSession
import dev.mote.collector.CollectorConfig
import dev.mote.collector.ConfigurationArchive
import dev.mote.collector.ConnectionGuard
import dev.mote.collector.MoteApplication
import dev.mote.collector.MoteI18n
import dev.mote.collector.Operations
import dev.mote.collector.QueueArchive
import dev.mote.collector.QueueInventory
import dev.mote.collector.QueueLocation
import dev.mote.collector.QueueStorage
import dev.mote.collector.QueueStorageChoice
import dev.mote.collector.RuntimeSettings
import dev.mote.collector.Settings
import dev.mote.collector.queue
import dev.mote.collector.requireStorageDirectory
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

private val backupWriter by lazy { Executors.newSingleThreadExecutor() }
private fun defaultBackupWriter(runnable: Runnable) = backupWriter.execute(runnable)
private fun defaultBackupPost(runnable: Runnable) = Handler(Looper.getMainLooper()).post(runnable)

/** Build-native storage, backup and recovery provider. The plugin owns the
 * queue-location controller (QueueStorage/QueueLocationStore), the storage
 * statistics scan, the backup document selection and one application-scoped
 * backup operation whose state survives Activity recreate. ConfigurationArchive
 * and QueueArchive stay the only archive formats; this plugin is their only
 * caller. Activities route intents, render returned snapshots and never start
 * a second operation for the same accepted work. */
internal object StorageBackupPlugin {
    const val CAPABILITY = "mote.storage-backup"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.storage-backup"
    private const val PACKAGE_ID = "dev.mote.storage-backup"
    private const val INSTALLATION_ID = "build-native"

    private val owners = ConcurrentHashMap<String, StorageBackupOwner>()

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** Start the application-scoped owner once per process. The first storage or
     * backup entry opens it; unrelated pages never pay for the scope. */
    internal fun owner(context: Context): StorageBackupOwner {
        val app = context.applicationContext
        val key = app.noBackupFilesDir.absolutePath
        owners[key]?.takeIf { it.active }?.let { return it }
        return synchronized(owners) {
            owners[key]?.takeIf { it.active } ?: open(app).also { owners[key] = it }
        }
    }

    private fun open(app: Context): StorageBackupOwner {
        val host = (app as? MoteApplication)?.let { runCatching { it.pluginHost }.getOrNull() }
            ?: return StorageBackupOwner(null, app)
        if (host.scope(INSTANCE_ID) != null) host.stopScope(INSTANCE_ID)
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val scope = when (val admitted = host.createScope(
            PluginInstanceDescriptor(
                identity, setOf(CAPABILITY),
                requires = listOf(requirement(), NativeRequirement("mote.durable-upload", "1")),
            ),
        )) {
            is PluginResult.Ok -> admitted.value
            is PluginResult.Failed -> return StorageBackupOwner(null, app)
        }
        return when (val started = host.startPlugin(scope) { session -> StorageBackupOwner(session, app) }) {
            is PluginResult.Ok -> started.value
            is PluginResult.Failed -> {
                host.stopScope(INSTANCE_ID)
                throw IllegalStateException(started.message)
            }
        }
    }

    /** Test seam: the same owner on a real host scope with explicit operation
     * dispatch and no Android files. */
    internal fun open(
        host: NativePluginHost,
        scope: PluginOwnerSession,
        execute: (Runnable) -> Unit = { it.run() },
        post: (Runnable) -> Unit = { it.run() },
    ): StorageBackupOwner {
        check(host.scope(INSTANCE_ID) === scope)
        return StorageBackupOwner(scope, null, execute, post)
    }
}

/** One accepted storage/backup operation. The plugin scope owns the executor;
 * an Activity recreate only swaps the observer. The result is held until one
 * observer claims it, so accepted work runs once and reports once. */
internal class BackupOperations(
    private val execute: (Runnable) -> Unit,
    private val post: (Runnable) -> Unit,
    private val discard: (BackupOutcome) -> Unit = {},
) {
    private class Active(var snapshot: BackupSnapshot) { var result: Result<BackupOutcome>? = null }

    private val lock = Any()
    private var active: Active? = null
    private var observer: BackupObserver? = null
    private var abandoned = false
    private var nextId = 0L

    val busy: Boolean get() = synchronized(lock) { active != null }

    /** Reserve the single operation slot. Deferred callers complete it after
     * their application-scoped work reports back. */
    fun begin(snapshot: BackupSnapshot): Boolean {
        val operation: Active
        synchronized(lock) {
            if (active != null) return false
            operation = Active(snapshot.copy(id = ++nextId))
            active = operation
            abandoned = false
        }
        notify(operation) { it.onBackupProgress(operation.snapshot) }
        return true
    }

    fun start(snapshot: BackupSnapshot, work: (BackupProgress) -> BackupOutcome): Boolean {
        if (!begin(snapshot)) return false
        val operation = synchronized(lock) { active } ?: return false
        val progress = object : BackupProgress {
            override fun message(value: String) = update(operation) { it.copy(message = value) }
            override fun file(value: BackupDocumentFacts?) = update(operation) { it.copy(file = value) }
        }
        try {
            execute(Runnable { complete(operation, runCatching { work(progress) }) })
        } catch (error: RejectedExecutionException) {
            complete(operation, Result.failure(error))
        }
        return true
    }

    fun complete(outcome: Result<BackupOutcome>) {
        val operation = synchronized(lock) { active } ?: return
        complete(operation, outcome)
    }

    private fun complete(operation: Active, outcome: Result<BackupOutcome>) {
        var drop: BackupOutcome? = null
        synchronized(lock) {
            if (active !== operation) return
            operation.result = outcome
            if (abandoned) {
                active = null
                drop = outcome.getOrNull()
            }
        }
        drop?.let(discard)
        post(Runnable { deliver() })
    }

    /** Attach the current Activity. A ready result is claimed by this call and
     * never published again; a running operation returns its snapshot. */
    fun attach(next: BackupObserver): BackupSnapshot? {
        var ready: BackupCompletion? = null
        var snapshot: BackupSnapshot? = null
        synchronized(lock) {
            observer = next
            val operation = active ?: return null
            if (abandoned) return null
            val result = operation.result
            if (result != null) {
                active = null
                ready = BackupCompletion(operation.snapshot, result)
            } else snapshot = operation.snapshot
        }
        ready?.let(next::onBackupResult)
        return snapshot
    }

    fun detach(current: BackupObserver) {
        synchronized(lock) { if (observer === current) observer = null }
    }

    /** The page withdrew its accepted operation: let already accepted work
     * finish, but drop the one result instead of showing it on a later page. */
    fun abandon(clearObserver: Boolean = false) {
        var drop: BackupOutcome? = null
        synchronized(lock) {
            abandoned = true
            if (clearObserver) observer = null
            val operation = active ?: return
            val result = operation.result
            if (result != null) {
                active = null
                drop = result.getOrNull()
            }
        }
        drop?.let(discard)
    }

    private fun update(operation: Active, transform: (BackupSnapshot) -> BackupSnapshot) {
        val snapshot = synchronized(lock) {
            if (active !== operation || operation.result != null) return
            transform(operation.snapshot).also { operation.snapshot = it }
        }
        notify(operation) { it.onBackupProgress(snapshot) }
    }

    private fun notify(operation: Active, publish: (BackupObserver) -> Unit) {
        post(Runnable {
            val target = synchronized(lock) {
                if (active === operation && operation.result == null) observer else null
            }
            target?.let(publish)
        })
    }

    private fun deliver() {
        val target: BackupObserver
        val completion: BackupCompletion
        synchronized(lock) {
            val operation = active ?: return
            val result = operation.result ?: return
            target = observer ?: return
            active = null
            completion = BackupCompletion(operation.snapshot, result)
        }
        target.onBackupResult(completion)
    }
}

internal enum class BackupKind { EXPORT, CONFIGURATION_READ, RESTORE_PREPARE, RESTORE_APPLY, CONFIGURATION_APPLY }

internal sealed interface BackupOutcome {
    data class Exported(val code: Int, val includeToken: Boolean) : BackupOutcome
    data class ConfigurationRead(val current: CollectorConfig, val next: CollectorConfig) : BackupOutcome
    data class RestorePrepared(val displayName: String, val count: Int, val origin: String) : BackupOutcome
    data class RestoreApplied(val displayName: String) : BackupOutcome
    data class ConfigurationApplied(val next: CollectorConfig) : BackupOutcome
}

/** Everything a recreated Activity needs to rebuild the accepted operation page.
 * [request] carries the document request code for export retry. */
internal data class BackupSnapshot(
    val kind: BackupKind,
    val title: String,
    val state: String = "",
    val heading: String,
    val message: String = "",
    val file: BackupDocumentFacts? = null,
    val detail: String = "",
    val request: Int = 0,
    val id: Long = 0,
)

internal data class BackupCompletion(val snapshot: BackupSnapshot, val outcome: Result<BackupOutcome>)

internal interface BackupObserver {
    fun onBackupProgress(snapshot: BackupSnapshot)
    fun onBackupResult(completion: BackupCompletion)
}

internal interface BackupProgress {
    fun message(value: String)
    fun file(value: BackupDocumentFacts?)
}

internal data class StorageStatus(
    val selected: Result<QueueLocation>,
    val current: Result<QueueLocation>,
    val choices: Result<List<QueueStorageChoice>>,
    val config: CollectorConfig?,
)

internal data class StorageReport(
    val summary: String,
    val total: Long,
    val types: Map<String, Long>,
    val days: Map<String, Long>,
    val inventory: QueueInventory,
    val ledger: JSONObject?,
)

internal data class RestorePreview(val displayName: String, val count: Int, val origin: String)

/** Durable owner: the plugin scope owns the location controller, the statistics
 * scan, the selected backup document and one serialized backup operation. A
 * stopped scope accepts no new storage/backup work. */
internal class StorageBackupOwner internal constructor(
    private val scope: PluginOwnerSession?,
    private val context: Context?,
    private val execute: (Runnable) -> Unit = ::defaultBackupWriter,
    private val post: (Runnable) -> Unit = ::defaultBackupPost,
) {
    private val closed = AtomicBoolean(false)
    private val document = BackupDocumentSelection()
    private val operations = BackupOperations(execute, post) { outcome ->
        if (outcome is BackupOutcome.RestorePrepared) releasePrepared()
    }
    private val reader = if (context == null) null else Executors.newSingleThreadExecutor()

    @Volatile private var prepared: QueueArchive.Prepared? = null
    @Volatile private var preparedName = ""
    @Volatile private var restoring = false
    @Volatile private var permanentlyDetached = true

    init {
        scope?.registerService(PluginServiceRegistration("storage.locations", "${StorageBackupPlugin.CAPABILITY}.locations"))
        scope?.registerService(PluginServiceRegistration("storage.statistics", "${StorageBackupPlugin.CAPABILITY}.statistics"))
        scope?.registerService(PluginServiceRegistration("storage.backup", "${StorageBackupPlugin.CAPABILITY}.backup"))
        scope?.registerJob(PluginJob("storage-backup", durable = true, drain = { close() }))
        scope?.defer { close() }
    }

    internal val active get() = !closed.get() && scope?.revoked != true
    internal val busy get() = operations.busy
    internal val operationEngine get() = operations

    /** The plugin owns the only construction of the queue-location controller. */
    internal fun queueStorage(): QueueStorage = QueueStorage(app())

    /** The operation surface is a plugin-owned view contribution; the Activity
     * only mounts it and routes its back action. */
    internal fun operationView(activity: Activity, body: LinearLayout, landing: LinearLayout, onReturn: () -> Unit) =
        BackupOperationView(activity, body, landing, onReturn)

    internal fun attach(observer: BackupObserver): BackupSnapshot? {
        permanentlyDetached = false
        return operations.attach(observer)
    }

    internal fun detach(observer: BackupObserver) = operations.detach(observer)

    /** Activity recreate keeps a running operation and its staged archive; a
     * page that is actually leaving drops the unclaimed result. */
    internal fun detachPermanently() {
        permanentlyDetached = true
        operations.abandon(clearObserver = true)
        document.clear()
        if (!restoring) releasePrepared()
    }

    /** Return to the landing page: already accepted work keeps running, but its
     * result is not shown again on this page. */
    internal fun abandonSurface() {
        operations.abandon()
        document.clear()
        if (!restoring) releasePrepared()
    }

    internal fun clearDocument() { document.clear() }

    internal fun documentFacts(): BackupDocumentFacts? = document.facts

    internal fun loadStorage(finished: (Result<StorageStatus>) -> Unit) {
        check(active) { "Storage backup plugin is stopped" }
        val app = app()
        val executor = reader ?: error("storage plugin has no Android context")
        executor.execute {
            val result = runCatching {
                val storage = queueStorage()
                StorageStatus(
                    selected = runCatching { storage.selected() },
                    current = runCatching { storage.current() },
                    choices = runCatching { storage.choices() },
                    config = runCatching { Settings(app).read() }.getOrNull(),
                )
            }
            post { finished(result) }
        }
    }

    internal fun migrate(activity: Activity, choice: QueueStorageChoice, finished: (Result<RuntimeSettings.Applied>) -> Unit) {
        check(active) { "Storage backup plugin is stopped" }
        val current = runCatching { Settings(activity).read() }.getOrElse { finished(Result.failure(it)); return }
        RuntimeSettings.apply(activity, current, change = { queueStorage().migrate(choice.id) }) { finished(it) }
    }

    internal fun statistics(finished: (Result<StorageReport>) -> Unit) {
        check(active) { "Storage backup plugin is stopped" }
        val app = app()
        val executor = reader ?: error("storage plugin has no Android context")
        executor.execute {
            val result = runCatching {
                val seen = mutableSetOf<String>()
                val types = sortedMapOf<String, Long>()
                val days = sortedMapOf<String, Long>()
                var total = 0L
                var count = 0
                var skipped = 0
                fun visit(file: File) {
                    try {
                        val path = file.absolutePath
                        if (!seen.add(path)) return
                        if (file.canonicalPath != path) { skipped++; return }
                        if (file.isDirectory) {
                            val children = file.listFiles()
                            if (children == null) skipped++ else children.forEach(::visit)
                        } else if (file.isFile) {
                            val size = file.length()
                            total += size
                            count++
                            val day = Instant.ofEpochMilli(file.lastModified()).atZone(ZoneOffset.UTC).toLocalDate().toString()
                            days[day] = (days[day] ?: 0L) + size
                            val kind = when (file.extension) {
                                "blob" -> "image"
                                "event", "enc", "json", "ndjson" -> "json"
                                "gguf", "bin", "onnx" -> "model"
                                "db", "sqlite" -> "database"
                                else -> file.extension.ifBlank { "other" }
                            }
                            types[kind] = (types[kind] ?: 0L) + size
                        }
                    } catch (_: Exception) { skipped++ }
                }
                listOf(File(app.applicationInfo.dataDir).canonicalFile, File(queueStorage().current().path).canonicalFile).forEach(::visit)
                StorageReport(
                    summary = MoteI18n.text("{0} MiB · 文件：{1}", "%.2f".format(total / 1048576.0), count) +
                        if (skipped > 0) "\n" + MoteI18n.text("部分文件无法读取，统计可能不完整。") else "",
                    total = total, types = types, days = days,
                    inventory = app.queue().inventory(),
                    ledger = runCatching { Operations.ledger(app).read() }.getOrNull(),
                )
            }
            post { finished(result) }
        }
    }

    internal fun export(uri: String, code: Int, includeToken: Boolean, generation: Pair<String, Long>?): Boolean {
        if (!active) return false
        val app = app()
        val selected = document.select(uri)
        val snapshot = BackupSnapshot(
            BackupKind.EXPORT, exportTitle(code), MoteI18n.text("正在导出"), exportLabel(code),
            file = BackupDocumentFacts.of(uri, null, null), request = code,
        )
        return operations.start(snapshot) { progress ->
            fun publish() {
                val facts = BackupDocumentMetadata.read(app.contentResolver, Uri.parse(uri))
                if (document.accept(selected, facts)) progress.file(facts)
            }
            publish()
            try { exportTo(app, uri, code, includeToken, generation) } finally { publish() }
            BackupOutcome.Exported(code, includeToken)
        }
    }

    internal fun readConfiguration(uri: String): Boolean {
        if (!active) return false
        val app = app()
        val snapshot = BackupSnapshot(BackupKind.CONFIGURATION_READ, MoteI18n.text("导入客户端配置"), heading = MoteI18n.text("正在读取配置…"))
        return operations.start(snapshot) {
            val current = Settings(app).read()
            val bytes = readLimited(app, uri, ConfigurationArchive.MAX_BYTES)
            require(bytes.size <= ConfigurationArchive.MAX_BYTES)
            BackupOutcome.ConfigurationRead(current, ConfigurationArchive.decode(AppReleaseVerifier.utf8(bytes), current))
        }
    }

    internal fun prepareRestore(uri: String): Boolean {
        if (!active || operations.busy) return false
        val app = app()
        releasePrepared()
        val snapshot = BackupSnapshot(BackupKind.RESTORE_PREPARE, MoteI18n.text("从备份恢复"), MoteI18n.text("正在校验备份…"), MoteI18n.text("校验并保存记录"))
        return operations.start(snapshot) {
            val settings = Settings(app)
            val staging = requireStorageDirectory(app.cacheDir)
            val staged = QueueArchive.prepare(
                requireNotNull(app.contentResolver.openInputStream(Uri.parse(uri))) { MoteI18n.text("备份无法读取") },
                File(staging, "restore-${UUID.randomUUID()}"),
                settings.read().maxQueueMiB * 1024L * 1024,
            )
            try {
                if (staged.origin != settings.dataOrigin()) error(MoteI18n.text("备份属于不同中央。先连接原节点"))
                prepared = staged
                preparedName = displayName(app, uri)
                BackupOutcome.RestorePrepared(preparedName, staged.count, staged.origin)
            } catch (error: Throwable) {
                staged.close()
                throw error
            }
        }
    }

    internal fun preparedPreview(): RestorePreview? {
        val staged = prepared ?: return null
        return RestorePreview(preparedName, staged.count, staged.origin)
    }

    internal fun restore(activity: Activity): Boolean {
        if (!active) return false
        val staged = prepared ?: return false
        val name = preparedName
        val app = activity.applicationContext
        val settings = Settings(app)
        val current = settings.read()
        val next = current.copy(syncMode = "manual")
        val snapshot = BackupSnapshot(
            BackupKind.RESTORE_APPLY, MoteI18n.text("从备份恢复"), MoteI18n.text("正在导入到本机"), MoteI18n.text("校验并保存记录"),
            MoteI18n.text("请保持备份文件与存储位置可用。"), detail = name,
        )
        if (!operations.begin(snapshot)) return false
        restoring = true
        RuntimeSettings.apply(activity, next, expected = current, change = {
            settings.save(next, current)
            QueueArchive.restore(staged, app.queue(), settings.dataOrigin(), next.maxQueueMiB * 1024L * 1024)
        }) { applied ->
            restoring = false
            if (applied.isSuccess || permanentlyDetached) releasePrepared()
            operations.complete(applied.map { BackupOutcome.RestoreApplied(name) })
        }
        return true
    }

    internal fun applyConfiguration(activity: Activity, current: CollectorConfig, next: CollectorConfig): Boolean {
        if (!active) return false
        val snapshot = BackupSnapshot(BackupKind.CONFIGURATION_APPLY, MoteI18n.text("客户端配置"), heading = MoteI18n.text("正在应用设置"))
        if (!operations.begin(snapshot)) return false
        RuntimeSettings.apply(activity, next, expected = current) { applied ->
            operations.complete(applied.map { BackupOutcome.ConfigurationApplied(next) })
        }
        return true
    }

    internal fun releasePrepared() {
        val staged = synchronized(this) {
            prepared?.also { prepared = null; preparedName = "" }
        } ?: return
        try { execute { staged.close() } } catch (_: RejectedExecutionException) { staged.close() }
    }

    internal fun close() {
        if (!closed.compareAndSet(false, true)) return
        operations.abandon(clearObserver = true)
        releasePrepared()
        reader?.shutdown()
    }

    private fun app(): Context = checkNotNull(context) { "storage plugin has no Android context" }

    private fun exportTo(app: Context, uri: String, code: Int, includeToken: Boolean, generation: Pair<String, Long>?) {
        when (code) {
            10 -> writeDocument(app, uri) { output ->
                output.bufferedWriter().use { it.write(ConfigurationArchive.encode(Settings(app).read(), includeToken)) }
            }
            12 -> {
                val queue = app.queue()
                val origin = Settings(app).dataOrigin()
                writeDocument(app, uri) { output ->
                    ConnectionGuard.sync { QueueArchive.export(queue, origin, output) }
                        ?: error(MoteI18n.text("设置正在变更，请稍后重试"))
                }
            }
            14 -> {
                val queue = app.queue()
                val records = JSONArray()
                queue.dedupeIds().forEach { id -> queue.capture(id)?.let(records::put) }
                writeDocument(app, uri) { output ->
                    output.bufferedWriter().use {
                        it.write(JSONObject().put("format", "mote-local-metadata").put("version", 1).put("records", records).toString())
                    }
                }
            }
            15, 16 -> {
                val client = CentralAccess.requireClient(app)
                check(generation != null && client.server == generation.first &&
                    CentralSession.get(app).generation == generation.second) { MoteI18n.text("登录会话已变更，请重新打开中央页面。") }
                val mode = if (code == 15) "metadata" else "data"
                writeDocument(app, uri) { output -> client.download("/api/export-bundle?mode=$mode", output) }
            }
            else -> error("unknown backup export request $code")
        }
    }

    private fun writeDocument(app: Context, uri: String, write: (OutputStream) -> Unit) {
        val output = requireNotNull(app.contentResolver.openOutputStream(Uri.parse(uri), "wt")) { MoteI18n.text("无法写入所选位置") }
        output.use(write)
    }

    private fun readLimited(app: Context, uri: String, limit: Int): ByteArray {
        val input = requireNotNull(app.contentResolver.openInputStream(Uri.parse(uri))) { MoteI18n.text("无法读取所选文件") }
        return input.use { stream ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                require(out.size() + count <= limit) { MoteI18n.text("配置文件过大") }
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    }

    private fun displayName(app: Context, uri: String): String = runCatching {
        app.contentResolver.query(Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    }.getOrNull() ?: MoteI18n.text("本机记录 ZIP")

    private fun exportTitle(code: Int) = MoteI18n.text(when (code) {
        10 -> "导出客户端配置"
        14 -> "导出本机元数据"
        15 -> "导出中央元数据"
        16 -> "导出中央资料与附件"
        else -> "导出本机记录"
    })

    private fun exportLabel(code: Int) = MoteI18n.text(when (code) {
        10 -> "正在导出配置…"
        14 -> "正在导出本机元数据…"
        15, 16 -> "正在导出中央资料…"
        else -> "正在导出本机记录…"
    })
}
