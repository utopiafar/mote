package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Opt-in API 35 Dev emulator and generated native-central server only. */
@RunWith(AndroidJUnit4::class)
class CentralLoginResponsivenessInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private var original: CollectorConfig? = null
    private val origin = "http://127.0.0.1:47883"

    @Before fun generatedEnvironmentOnly() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeCentralFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.VERSION.SDK_INT == 35 &&
            Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(!CaptureAccessibilityService.connected && !ProjectionService.running && !Settings(context).enabled)
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (QueueStorage.recovering && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        require(!QueueStorage.recovering && QueueStorage.recoveryFailure == null && context.queue().depth() == 0)
        val settings = Settings(context)
        original = settings.read()
        settings.save(original!!.copy(server = origin, token = "generated-native-central-owner-token-123456",
            debugHttp = true, authSignedOut = false, authExpiresAt = 0, authProcess = "", syncMode = "manual"), confirmCentralEndpoint = true)
        MoteI18n.select(context, "zh-CN")
    }

    @After fun restoreSettings() { original?.let { Settings(context).save(it, confirmCentralEndpoint = true) } }

    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }
    private fun content(activity: CentralActivity): CentralContent = CentralActivity::class.java.getDeclaredField("content")
        .apply { isAccessible = true }.get(activity) as CentralContent
    private fun waitFor(scenario: ActivityScenario<CentralActivity>, label: String, ready: (CentralActivity) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) {
            var done = false; scenario.onActivity { done = ready(it) }
            if (done) return
            Thread.sleep(25)
        }
        fail(label)
    }
    private fun open() = ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "overview"))
        .also { scenario -> waitFor(scenario, "generated central page ready") { it.client != null && !it.isWorking } }

    @Test fun refreshFailureAndWorkNeverJoinAnActiveSettingsWriter() {
        open().use { scenario ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val holder = Thread({ synchronized(Settings::class.java) {
                entered.countDown(); release.await(20, TimeUnit.SECONDS)
            } }, "generated-central-settings-writer").apply { start() }
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val started = SystemClock.elapsedRealtime()
                scenario.onActivity { activity ->
                    val central = content(activity)
                    (CentralContent::class.java.getDeclaredField("refreshLogin").apply { isAccessible = true }.get(central) as Runnable).run()
                    central.requestFailure(IllegalStateException("Generated temporary failure"))
                    central.work("Generated local work", { "generated result" }) { central.notice(it) }
                }
                assertTrue("refresh, failure handling and work submission must stay off Settings.class", SystemClock.elapsedRealtime() - started < 1000)
            } finally { release.countDown(); holder.join(5000); assertFalse(holder.isAlive) }
            waitFor(scenario, "generated work completes after the writer releases") { !it.isWorking }
        }
    }

    @Test fun revokedSessionRejectsLateWorkAndClearsPrivateViews() {
        open().use { scenario ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val published = AtomicInteger()
            try {
                scenario.onActivity { activity -> content(activity).work("Generated held result", {
                    entered.countDown(); check(release.await(20, TimeUnit.SECONDS)); "generated private late result"
                }) { published.incrementAndGet(); content(activity).text(it) } }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                Settings(context).signOut()
            } finally { release.countDown() }
            waitFor(scenario, "fresh revocation returns to native login") { activity ->
                activity.client == null && views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == "登录并继续" }
            }
            assertEquals("late result cannot publish under revoked credentials", 0, published.get())
            scenario.onActivity { activity -> assertFalse(views(activity.window.decorView).filterIsInstance<TextView>()
                .any { it.text.toString().contains("generated private late result") }) }
        }
    }

    @Test fun navigationRejectsAnAlreadyAcceptedLateResult() {
        open().use { scenario ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val published = AtomicInteger()
            try {
                scenario.onActivity { activity -> content(activity).work("Generated held navigation", {
                    entered.countDown(); check(release.await(20, TimeUnit.SECONDS)); "generated old page"
                }) { published.incrementAndGet() } }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                scenario.onActivity { it.navigate("sources") }
            } finally { release.countDown() }
            waitFor(scenario, "new page work completes") { !it.isWorking }
            assertEquals("navigation fences the old completion", 0, published.get())
        }
    }

    @Test fun clockExpiryClearsAccessWithoutAConfigurationWrite() {
        val settings = Settings(context)
        settings.save(settings.read().copy(authExpiresAt = System.currentTimeMillis() + 10_000), confirmCentralEndpoint = true)
        open().use { scenario ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val published = AtomicInteger()
            try {
                scenario.onActivity { activity -> content(activity).work("Generated expiring result", {
                    entered.countDown(); check(release.await(20, TimeUnit.SECONDS)); "generated expired private result"
                }) { published.incrementAndGet() } }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val expiresAt = settings.read().authExpiresAt
                while (System.currentTimeMillis() <= expiresAt) Thread.sleep(25)
                // No saved configuration changes between the worker's two authorization reads.
            } finally { release.countDown() }
            waitFor(scenario, "clock expiry clears native private access") { activity -> activity.client == null }
            assertEquals("expired private result must be rejected without a version change", 0, published.get())
        }
    }
}
