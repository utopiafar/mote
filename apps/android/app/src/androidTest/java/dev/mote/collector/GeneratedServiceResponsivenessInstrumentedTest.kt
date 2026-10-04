package dev.mote.collector

import android.app.Service
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Actual Settings/worker contention in bare services. No MediaProjection grant, Surface or pixels. */
@RunWith(AndroidJUnit4::class)
class GeneratedServiceResponsivenessInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private var original: CollectorConfig? = null

    @Before fun generatedEnvironmentOnly() {
        require(context.packageName == "dev.mote.collector.dev" && Build.VERSION.SDK_INT == 35 &&
            Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (QueueStorage.recovering && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        require(!QueueStorage.recovering && QueueStorage.recoveryFailure == null && context.queue().depth() == 0)
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
        val settings = Settings(context); original = settings.read()
        settings.save(original!!.copy(server = "", token = "", syncMode = "manual", screenCollectionEnabled = false,
            mediaCollectionEnabled = false, notificationCollectionEnabled = false, deviceEventCollectionEnabled = false))
    }
    @After fun restoreSettings() {
        Settings(context).enabled = false
        original?.let { Settings(context).save(it) }
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
    }

    private fun <T : Service> attached(service: T): T {
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
            .apply { isAccessible = true }.invoke(service, context)
        Service::class.java.getDeclaredField("mClassName").apply { isAccessible = true }.set(service, service.javaClass.name)
        Service::class.java.getDeclaredField("mToken").apply { isAccessible = true }.set(service, android.os.Binder())
        // Only the foreground-service binder is replaced. It cannot create a projection or
        // capture anything; notification/Settings/WorkManager APIs remain the real fixture APIs.
        val field = Service::class.java.getDeclaredField("mActivityManager").apply { isAccessible = true }
        field.set(service, Proxy.newProxyInstance(field.type.classLoader, arrayOf(field.type)) { _, method, _ ->
            when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                java.lang.Integer.TYPE -> 0
                java.lang.Long.TYPE -> 0L
                else -> null
            }
        })
        return service
    }
    private fun connected(service: CaptureAccessibilityService) = CaptureAccessibilityService::class.java
        .getDeclaredMethod("onServiceConnected").apply { isAccessible = true }.invoke(service)
    private fun ended(service: ProjectionService) = ProjectionService::class.java.getDeclaredMethod("projectionEnded", String::class.java)
        .apply { isAccessible = true }.invoke(service, "Generated projection ended")
    private fun drain(service: Service, fieldName: String) {
        val value = service.javaClass.getDeclaredField(fieldName).apply { isAccessible = true }.get(service)
        when (value) {
            is ExecutorService -> if (value.isShutdown) assertTrue(value.awaitTermination(20, TimeUnit.SECONDS)) else repeat(2) {
                value.submit {}.get(20, TimeUnit.SECONDS); instrumentation.runOnMainSync {}
            }
            is Handler -> {
                val done = CountDownLatch(1); assertTrue(value.post { done.countDown() }); assertTrue(done.await(20, TimeUnit.SECONDS))
            }
        }
    }
    private fun mainWhileSettingsLocked(label: String, action: () -> Unit) {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val done = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val holder = Thread({ synchronized(Settings::class.java) { entered.countDown(); release.await(20, TimeUnit.SECONDS) } }, "generated-service-settings-writer").apply { start() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val started = SystemClock.elapsedRealtime()
            Handler(Looper.getMainLooper()).post { try { action() } catch (error: Throwable) { failure.set(error) } finally { done.countDown() } }
            assertTrue("$label must not join Settings.class on the main looper", done.await(1, TimeUnit.SECONDS))
            failure.get()?.let { throw AssertionError(label, it) }
            println("MOTE_GENERATED_SERVICE $label elapsedMs=${SystemClock.elapsedRealtime() - started}")
        } finally { release.countDown(); holder.join(5000); assertTrue(done.await(10, TimeUnit.SECONDS)) }
    }
    private fun waitUntil(label: String, ready: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (!ready() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        assertTrue(label, ready())
    }

    @Test fun projectionLifecycleDoesNotWaitForSettings() {
        val service = attached(ProjectionService())
        try {
            mainWhileSettingsLocked("projection-create") { service.onCreate() }
            mainWhileSettingsLocked("projection-ended") { ended(service) }
            mainWhileSettingsLocked("projection-destroy") { service.onDestroy() }
            drain(service, "state")
            assertFalse(ProjectionService.running)
            assertEquals(0, context.queue().depth())
        } finally { instrumentation.runOnMainSync { service.onDestroy() } }
    }

    @Test fun accessibilityConnectSchedulePauseAndDestroyDoNotWaitForSettings() {
        val service = attached(CaptureAccessibilityService())
        try {
            mainWhileSettingsLocked("accessibility-connect") { connected(service) }
            drain(service, "stateWorker")
            Settings(context).enabled = true // Screen collection is explicitly disabled in this fixture.
            mainWhileSettingsLocked("accessibility-refresh-interrupt-stop") { service.refreshSchedule(); service.onInterrupt(); service.stopCapture() }
            mainWhileSettingsLocked("accessibility-destroy") { service.onDestroy() }
            drain(service, "stateWorker")
            assertFalse(CaptureAccessibilityService.connected)
            assertEquals(0, context.queue().depth())
        } finally { if (CaptureAccessibilityService.instance === service) instrumentation.runOnMainSync { service.onDestroy() } }
    }

    @Test fun mediaCreateAndGeneratedNotificationStayOffTheMainSettingsLock() {
        val service = attached(MediaCollectionService())
        try {
            mainWhileSettingsLocked("media-create") { service.onCreate() }
            drain(service, "worker")
            val notification = android.app.Notification.Builder(context, "mote_capture").setContentTitle("Generated service notification").build()
            val posted = android.service.notification.StatusBarNotification("dev.mote.generated", "dev.mote.generated", 123, null,
                android.os.Process.myUid(), android.os.Process.myPid(), 0, notification, android.os.Process.myUserHandle(), System.currentTimeMillis())
            mainWhileSettingsLocked("media-notification") { service.onNotificationPosted(posted) }
            drain(service, "worker")
            mainWhileSettingsLocked("media-destroy") { service.onDestroy() }
            assertEquals(0, context.queue().depth())
        } finally { if (MediaCollectionService.instance === service) instrumentation.runOnMainSync { service.onDestroy() } }
    }

    @Test fun visibleNotificationsStopReceiverAndPipelinePauseDoNotJoinSettings() {
        val settings = Settings(context); settings.save(settings.read().copy(diagnosticsEnabled = true))
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        val pipeline = CapturePipeline(context) { }
        Notifications.show(context, "Generated initial service status")
        try {
            mainWhileSettingsLocked("notification-stop-pause") {
                Notifications.show(context, "Generated changed service status")
                StopReceiver().onReceive(context, Intent(context, StopReceiver::class.java))
                pipeline.pause("Generated pipeline pause")
            }
            waitUntil("accepted stop must persist after the settings writer releases") { !RuntimeSettings.stopping }
            assertFalse(settings.enabled); assertFalse(ConnectionGuard.reconfiguring())
            assertEquals(0, context.queue().depth())
        } finally { pipeline.close(); Notifications.clear(context); Notifications.showEvents(context, null) }
    }

    @Test fun heartbeatSnapshotWaitDoesNotOwnTheSchedulingMonitor() {
        val config = Settings(context).read().copy(server = "https://127.0.0.1:1", token = "generated-heartbeat-monitor-token-123456", syncMode = "realtime")
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val invalidated = CountDownLatch(1)
        val error = AtomicReference<Throwable?>()
        val holder = Thread { synchronized(Settings::class.java) { entered.countDown(); release.await(20, TimeUnit.SECONDS) } }.apply { start() }
        val reader = Thread { runCatching { HeartbeatWorker.stateChanged(context, config) }.onFailure(error::set) }
        var invalidator: Thread? = null
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS)); reader.start()
            waitUntil("actual heartbeat method must reach the contended Settings constructor") {
                reader.state == Thread.State.BLOCKED && reader.stackTrace.any { it.className == Settings::class.java.name }
            }
            invalidator = Thread {
                HeartbeatWorker.invalidate(); HeartbeatWorker.configure(context, config.copy(syncMode = "manual")); invalidated.countDown()
            }.apply { start() }
            assertTrue("Settings wait must leave the heartbeat monitor available", invalidated.await(1, TimeUnit.SECONDS))
        } finally { release.countDown(); holder.join(5000); reader.join(10_000); invalidator?.join(5000) }
        assertFalse(reader.isAlive); error.get()?.let { throw AssertionError(it) }
    }

    @Test fun oldProjectionShutdownCannotDisableANewerGeneratedInstance() {
        val old = attached(ProjectionService()); val next = attached(ProjectionService())
        instrumentation.runOnMainSync { old.onCreate() }
        Settings(context).enabled = true
        try {
            mainWhileSettingsLocked("projection-generation-replacement") {
                ended(old); next.onCreate()
                ProjectionService::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, next)
                ProjectionService::class.java.getDeclaredField("running").apply { isAccessible = true }.setBoolean(null, true)
                val consent = RuntimeSettings::class.java.getDeclaredField("projectionConsent").apply { isAccessible = true }.get(null) as ProjectionConsentHandoff
                consent.request()
                (ProjectionService::class.java.getDeclaredField("callback").apply { isAccessible = true }.get(old) as android.media.projection.MediaProjection.Callback).onStop()
                assertTrue("old callback cannot cancel the new projection consent request", RuntimeSettings.takeProjectionConsentRequest())
                old.onDestroy()
                assertTrue(ProjectionService.running)
            }
            drain(old, "state")
            assertTrue("old asynchronous cleanup cannot clear newer capture intent", Settings(context).enabled)
            assertSame(next, ProjectionService.instance)
        } finally { instrumentation.runOnMainSync { next.onDestroy() }; drain(next, "state") }
    }
}
