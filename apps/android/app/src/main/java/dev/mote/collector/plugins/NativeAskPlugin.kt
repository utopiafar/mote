package dev.mote.collector.plugins

import android.content.Context
import dev.mote.collector.CentralStateFile
import dev.mote.collector.LocalDataFormat
import dev.mote.collector.MoteApplication
import dev.mote.collector.secretBox
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** Build-native Ask provider. The plugin owns the run ticket, evidence scope,
 * private image references, conversation presentation and the encrypted draft
 * journal; Activities and screens only route user actions and render results. */
internal object NativeAskPlugin {
    const val CAPABILITY = "mote.ask"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.ask"
    private const val PACKAGE_ID = "dev.mote.ask"
    private const val INSTALLATION_ID = "build-native"

    @Volatile private var owner: NativeAskOwner? = null

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)

    /** The one application-scoped Ask owner. Its draft journal is keyed by the
     * Central origin directory, so a connection change never mixes drafts. */
    internal fun owner(context: Context): NativeAskOwner {
        val app = context.applicationContext
        owner?.let { return it }
        return synchronized(this) {
            owner ?: run {
                val host = (app as? MoteApplication)?.let { application -> runCatching { application.pluginHost }.getOrNull() }
                val storage = { directory: File ->
                    LocalDataFormat.requireCurrent(app)
                    NativeAskDraftStorage(CentralStateFile(directory, "ask", app.secretBox()))
                }
                val created = if (host == null) {
                    NativeAskOwner(null, null, storage)
                } else {
                    val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
                    val descriptor = PluginInstanceDescriptor(identity, setOf(CAPABILITY), requires = listOf(requirement()))
                    val scope = when (val admitted = host.createScope(descriptor)) {
                        is PluginResult.Ok -> admitted.value
                        is PluginResult.Failed -> error("${admitted.code}: ${admitted.message}")
                    }
                    when (val started = host.startPlugin(scope) { NativeAskOwner(it, null, storage) }) {
                        is PluginResult.Ok -> started.value
                        is PluginResult.Failed -> error("${started.code}: ${started.message}")
                    }
                }
                created.also { owner = it }
            }
        }
    }

    /** Test seam: a real host scope with a generated private journal. */
    internal fun open(scope: PluginOwnerSession, storage: NativeAskDraftStorage): NativeAskOwner =
        NativeAskOwner(scope, storage, null)
}

/** Durable owner: the encrypted journal and the host services outlive every
 * Ask view. A new Activity asks for a fresh controller over the same journal. */
internal class NativeAskOwner internal constructor(
    scope: PluginOwnerSession?,
    private val fixedStorage: NativeAskDraftStorage?,
    private val storageFactory: ((File) -> NativeAskDraftStorage)?,
) {
    private val storages = ConcurrentHashMap<String, NativeAskDraftStorage>()
    @Volatile private var closed = false; private set

    init {
        if (scope != null) {
            scope.registerService(PluginServiceRegistration("ask.draft", "${NativeAskPlugin.CAPABILITY}.draft"))
            scope.registerService(PluginServiceRegistration("ask.runs", "${NativeAskPlugin.CAPABILITY}.runs"))
            scope.registerJob(PluginJob("ask.draft", durable = true))
            scope.defer { close() }
        }
    }

    internal fun controller(directory: File): NativeAskController {
        check(!closed) { "Ask plugin is closed" }
        val storage = fixedStorage ?: storages.computeIfAbsent(directory.absolutePath) {
            requireNotNull(storageFactory).invoke(directory)
        }
        return NativeAskController(storage)
    }

    internal fun close() {
        closed = true
    }
}
