package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** The single producer of local queue/source status snapshots. The durable
 * transport plugin owns this instance; Activities only observe it and ask for a
 * refresh. Closing it unregisters the preference listener and cancels the
 * application coroutine. */
class LocalStatusProducer internal constructor(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutable = MutableStateFlow(LocalStateSnapshot())
    val state: StateFlow<LocalStateSnapshot> = mutable.asStateFlow()
    private val preferences = app.getSharedPreferences("mote", Context.MODE_PRIVATE)
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> LocalStateChanges.changed() }
    private var started = false
    private var closed = false

    /** Only the owning plugin starts the producer, once per process. */
    internal fun start() {
        synchronized(this) {
            check(!closed) { "Local status producer is closed" }
            if (started) return
            started = true
            preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        }
        scope.launch {
            LocalStateChanges.revisions.collect { request ->
                // StateFlow conflates bursts. A fixed delay (not debounce) guarantees progress
                // during continuous writes and permits only one storage read at a time.
                if (!request.immediate) delay(300)
                val previous = mutable.value
                val next = try {
                    check(!QueueStorage.recovering) { MoteI18n.text("正在恢复本机存储") }
                    // Settings.save may hold Settings.class while checking queued work.
                    // Resolve handles before taking the queue lock to keep that lock order.
                    val activeQueue = app.queue()
                    val quarantineQueue = BulkDedupeStore(app).quarantine()
                    // Index upgrades inspect a few records per lock acquisition; starting capture
                    // must not wait behind scanning the entire library.
                    if (previous.active == null || previous.error != null || previous.revision.storage != LocalStateChanges.revisions.value.storage) {
                        activeQueue.prepareIndex()
                        quarantineQueue.prepareIndex()
                    }
                    val (revision, active, pending) = DurableQueue.exclusive {
                        val version = LocalStateChanges.revisions.value
                        if (previous.error == null && previous.active != null && previous.quarantine != null && previous.revision.storage == version.storage)
                            Triple(version, previous.active, previous.quarantine)
                        else Triple(version, activeQueue.inventory(), quarantineQueue.inventory())
                    }
                    val settings = Settings(app)
                    LocalStateSnapshot(revision, active, pending, captureState = settings.state(), captureMessage = settings.message(),
                        syncMessage = settings.uploadStatus(), checkedAt = System.currentTimeMillis()).withSources {
                        val issues = SyncHealth.sourceAttentionCount(app)
                        val count = app.localSources().pendingSync().count + app.fileArchives().pendingSync().count
                        count to issues
                    }
                } catch (error: Exception) {
                    previous.copy(revision = LocalStateChanges.revisions.value, error = error.message ?: MoteI18n.text("本机状态暂不可读取"))
                }
                mutable.value = next
                // Notifications are a consumer even when no Activity is visible.
                withContext(Dispatchers.Main) { runCatching { Notifications.showLocalState(app, next) } }
            }
        }
    }

    fun refresh() = LocalStateChanges.changed(immediate = true)

    /** Idempotent; a stopped transport scope must not leave a second producer. */
    fun close() {
        synchronized(this) {
            if (closed) return
            closed = true
            if (started) runCatching { preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener) }
            scope.cancel()
        }
    }

    companion object {
        /** Resolve the producer installed by the durable transport plugin. */
        fun get(context: Context): LocalStatusProducer = dev.mote.collector.plugins.DurableTransportPlugin.get(context).localStatus
    }
}

/** Platform Activities explicitly pair this subscription with onResume/onPause. */
fun Activity.observeLocalState(onState: (LocalStateSnapshot) -> Unit): Job {
    val producer = LocalStatusProducer.get(this)
    producer.refresh() // Calibrate against storage after backgrounding or a missed process event.
    return CoroutineScope(Dispatchers.Main.immediate).launch {
        producer.state.collect { if (!isDestroyed && !isFinishing) onState(it) }
    }
}
