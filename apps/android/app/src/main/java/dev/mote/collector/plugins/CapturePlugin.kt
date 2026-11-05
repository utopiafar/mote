package dev.mote.collector.plugins

import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.mote.collector.CaptureAccessibilityService
import dev.mote.collector.CaptureOverview
import dev.mote.collector.CapturePipeline
import dev.mote.collector.CaptureResume
import dev.mote.collector.CollectorConfig
import dev.mote.collector.LocalStateSnapshot
import dev.mote.collector.LocalStatusProducer
import dev.mote.collector.MediaCollectionService
import dev.mote.collector.MoteI18n
import dev.mote.collector.Notifications
import dev.mote.collector.ProjectionConsentHandoff
import dev.mote.collector.RuntimeSettings
import dev.mote.collector.SendPauseControl
import dev.mote.collector.Settings
import dev.mote.collector.SystemEventCollector
import dev.mote.collector.UploadWorker
import dev.mote.collector.captureResume
import dev.mote.collector.systemEntries
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Build-native capture provider. The plugin owns the screen, accessibility and
 * system-event controllers. The Android services are only platform containers:
 * they ask this owner for a controller after they start, and stop producing
 * when the scope is gone. */
internal object CapturePlugin {
    const val PROJECTION_CAPABILITY = "mote.capture.projection"
    const val ACCESSIBILITY_CAPABILITY = "mote.capture.accessibility"
    const val API_VERSION = "1"
    const val INSTANCE_ID = "dev.mote.capture"
    private const val PACKAGE_ID = "dev.mote.capture"
    private const val INSTALLATION_ID = "build-native"

    private val lock = Any()
    @Volatile private var runtime: CaptureControllers? = null

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(PROJECTION_CAPABILITY, API_VERSION, buildId = buildId, osGrants = listOf("projection")))
        registry.register(NativePluginProvider(ACCESSIBILITY_CAPABILITY, API_VERSION, buildId = buildId, osGrants = listOf("accessibility")))
    }

    internal fun requirements() = listOf(
        NativeRequirement(PROJECTION_CAPABILITY, API_VERSION),
        NativeRequirement(ACCESSIBILITY_CAPABILITY, API_VERSION),
    )

    /** Start or re-enable the one process-wide owner. A stopped scope is
     * replaced with a fresh admission; providers are never registered again. */
    internal fun start(host: NativePluginHost): CaptureControllers? = synchronized(lock) {
        val current = runtime
        if (current?.active == true && host.scope(INSTANCE_ID) != null) return current
        host.scope(INSTANCE_ID)?.let { host.stopScope(INSTANCE_ID) }
        val identity = PluginInstanceIdentity(PACKAGE_ID, INSTALLATION_ID, INSTANCE_ID)
        val descriptor = PluginInstanceDescriptor(
            identity,
            setOf("capture", "projection", "accessibility", "system-events"),
            requires = requirements(),
        )
        val scope = (host.createScope(descriptor) as? PluginResult.Ok)?.value ?: return null
        val controllers = current ?: CaptureControllers()
        val started = host.startPlugin(scope) { session ->
            controllers.activate(session)
            controllers
        }
        return when (started) {
            is PluginResult.Ok -> started.value.also {
                runtime = it
                runCatching { CaptureAccessibilityService.instance?.refreshSchedule() }
                runCatching { MediaCollectionService.refresh() }
            }
            is PluginResult.Failed -> {
                runCatching { controllers.deactivate() }
                null
            }
        }
    }

    /** The active controller set consumed by services. A stopped plugin has no
     * owner, so no service can obtain a producer. */
    internal fun controllers(): CaptureControllers? = runtime?.takeIf { it.active }

    internal fun controls(): CaptureControlsController = runtime?.controls ?: inactiveControls

    private val inactiveControls = CaptureControlsController { false }
}

/** Durable owner for the four capture controllers. Deactivation closes every
 * pipeline and observer it created; activation only binds a fresh host scope. */
internal class CaptureControllers internal constructor() {
    private val pipelineController = CapturePipelineController { active }
    private val eventController = SystemEventCollectorController { active }
    val reconfiguration = CaptureReconfigurationController { active }
    val controls = CaptureControlsController { active }
    @Volatile private var scope: PluginOwnerSession? = null

    internal val active: Boolean get() = scope?.let { !it.revoked } == true

    internal fun activate(session: PluginOwnerSession) {
        synchronized(this) {
            deactivate()
            scope = session
            session.registerService(PluginServiceRegistration("capture.pipeline", "mote.capture.pipeline"))
            session.registerService(PluginServiceRegistration("capture.system-events", "mote.capture.system-events"))
            session.registerService(PluginServiceRegistration("capture.controls", "mote.capture.controls"))
            session.registerService(PluginServiceRegistration("capture.reconfiguration", "mote.capture.reconfiguration"))
            session.registerJob(PluginJob("capture.runtime", durable = true, drain = { deactivate() }))
            session.defer { deactivate() }
        }
    }

    internal fun openPipeline(context: Context, scheduleUpload: (CollectorConfig) -> Unit = { UploadWorker.schedule(context, it) }): CapturePipeline? =
        pipelineController.open(context, scheduleUpload)

    internal fun closePipeline(pipeline: CapturePipeline?) = pipelineController.close(pipeline)

    internal fun openEventCollector(context: Context, worker: Handler): SystemEventCollector? =
        eventController.open(context, worker)

    internal fun deactivate() {
        synchronized(this) {
            scope = null
            pipelineController.closeAll()
            eventController.closeAll()
            reconfiguration.reset()
        }
    }
}

internal class CapturePipelineController(private val active: () -> Boolean) {
    private val pipelines = Collections.newSetFromMap(ConcurrentHashMap<CapturePipeline, Boolean>())

    fun open(context: Context, scheduleUpload: (CollectorConfig) -> Unit): CapturePipeline? {
        if (!active()) return null
        val pipeline = CapturePipeline(context, scheduleUpload)
        pipelines += pipeline
        if (!active()) { close(pipeline); return null }
        return pipeline
    }

    fun close(pipeline: CapturePipeline?) {
        if (pipeline == null) return
        pipelines.remove(pipeline)
        pipeline.close()
    }

    fun closeAll() {
        pipelines.toList().forEach { runCatching { it.close() } }
        pipelines.clear()
    }
}

internal class SystemEventCollectorController(private val active: () -> Boolean) {
    private val collectors = Collections.newSetFromMap(ConcurrentHashMap<SystemEventCollector, Boolean>())

    fun open(context: Context, worker: Handler): SystemEventCollector? {
        if (!active()) return null
        val collector = SystemEventCollector(context, worker) { active() }
        collectors += collector
        if (!active()) { collectors.remove(collector); collector.reset(); return null }
        return collector
    }

    fun closeAll() {
        collectors.toList().forEach { runCatching { it.reset() } }
        collectors.clear()
    }
}

/** Resume decisions and the projection-consent handoff belong to the active
 * plugin. A stopped owner always reports STOPPED and cannot request consent. */
internal class CaptureReconfigurationController(private val active: () -> Boolean) {
    private val consent = ProjectionConsentHandoff()

    fun resume(wasEnabled: Boolean, stillEnabled: Boolean, mode: String, projectionAlive: Boolean): CaptureResume =
        if (active()) captureResume(wasEnabled, stillEnabled, mode, projectionAlive) else CaptureResume.STOPPED

    fun takeConsentRequest(): Boolean = active() && consent.take()
    fun observeConsent(observer: (() -> Unit)?) { if (observer == null) consent.detach() else if (active()) consent.attach(observer) else consent.detach() }
    fun cancelConsent() = consent.cancel()
    fun requestConsent() { if (active()) consent.request() }
    fun reset() { consent.cancel(); consent.detach() }
}

/** Pauses shared by the home, the status panel, the notification and Quick Settings. Screen capture, all capture and
 * sending stay independent. Nothing here starts capture: resuming returns to the app's preview and system consent. */
internal class CaptureControlsController(private val active: () -> Boolean) {
    private val worker by lazy { Executors.newSingleThreadExecutor() }
    private val main by lazy { Handler(Looper.getMainLooper()) }

    fun pauseScreen(context: Context, finished: (Result<Boolean>) -> Unit = {}) {
        if (!active()) { finished(Result.success(false)); return }
        val app = context.applicationContext
        worker.execute {
            val current = runCatching { Settings(app).let { it to it.read() } }
            main.post {
                if (!active()) { finished(Result.success(false)); return@post }
                val (settings, config) = current.getOrElse { finished(Result.failure(it)); return@post }
                if (!settings.enabled || !config.screenCollectionEnabled || RuntimeSettings.stopping) { finished(Result.success(false)); return@post }
                settings.screenPaused(System.currentTimeMillis())
                RuntimeSettings.apply(app, config.copy(screenCollectionEnabled = false), expected = config) { result ->
                    if (result.isFailure) settings.screenPaused(null)
                    finished(result.map { true })
                }
            }
        }
    }

    fun stopAll(context: Context, finished: (Result<Unit>) -> Unit = {}) {
        if (!active()) { finished(Result.success(Unit)); return }
        val app = context.applicationContext
        RuntimeSettings.cancelProjectionConsentRequest()
        // Joining a stop under way still reports only after that stop and this status are saved.
        RuntimeSettings.stop(app) { result ->
            app.systemEntries().showEvents(null)
            if (result.isFailure) { finished(result); return@stop }
            worker.execute {
                runCatching {
                    val settings = Settings(app)
                    if (!settings.enabled) { settings.status("paused", MoteI18n.text("你已停止采集，已有记录保留，同步按所选策略运行")); UploadWorker.schedule(app, settings.read()) }
                }
                main.post { finished(result) }
            }
        }
    }

    /** Sending pause keeps local saving and capture running. */
    fun setSendingPaused(context: Context, paused: Boolean, finished: (Result<Unit>) -> Unit = {}) {
        if (!active()) { finished(Result.success(Unit)); return }
        val app = context.applicationContext
        worker.execute { val result = runCatching { SendPauseControl.set(app, paused) }; main.post { finished(result) } }
    }

    /** The tile and status surfaces read the same overview facts the status panel and notification consume. */
    fun overviewFacts(context: Context, done: (CaptureOverview.Facts?) -> Unit) {
        if (!active()) { done(null); return }
        val app = context.applicationContext
        worker.execute {
            val read = runCatching {
                val settings = Settings(app); val config = settings.read()
                val local = runCatching { LocalStatusProducer.get(app).state.value }.getOrDefault(LocalStateSnapshot())
                CaptureOverview.facts(app, settings, config, local)
            }.getOrNull()
            main.post { done(read) }
        }
    }
}
