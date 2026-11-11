package dev.mote.collector

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.mote.collector.plugins.PluginControlClient
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/** Explicit, task-owned emulator acceptance against a real private Central.
 * The companion Web/Mac controller observes Android's off selection and then
 * turns it on through the actual Web switch. No personal profile is permitted.
 * Pass pluginControlsOrigin/token and pluginControlsGeneratedProfile=true.
 */
@RunWith(AndroidJUnit4::class)
class PluginControlsJourneyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(work: () -> T): T {
        val value = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { value.set(runCatching(work)) }
        return value.get().getOrThrow()
    }
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun until(label: String, read: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 30_000
        while (SystemClock.elapsedRealtime() < end) {
            if (read()) return
            Thread.sleep(50)
        }
        fail(label)
    }
    private fun screenshot(name: String, activity: CentralActivity) {
        main { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        instrumentation.waitForIdleSync()
        val output = File(context.getExternalFilesDir(null), "plugin-controls").apply { mkdirs() }
        File(output, "$name.png").outputStream().use {
            assertTrue(instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }
    @Test fun androidToggleConvergesWithWebAndSurvivesActivityRecreation() {
        val args = InstrumentationRegistry.getArguments()
        val origin = args.getString("pluginControlsOrigin").orEmpty()
        assumeTrue("Run the explicit real-Central multi-client controller", origin.isNotEmpty())
        require(args.getString("pluginControlsGeneratedProfile") == "true")
        require(URL(origin).host == "127.0.0.1")
        val token = requireNotNull(args.getString("pluginControlsToken"))
        val settings = Settings(context)
        val before = settings.read()
        require(before.token.isBlank() && before.server in setOf("", BuildConfig.DEFAULT_SERVER))
        require(!settings.enabled && settings.lastCapture() == null && !settings.hasPendingData())
        require(context.queue().inventory().records == 0 && context.localSources().sources().isEmpty())
        require(!CaptureAccessibilityService.connected && !ProjectionService.running)
        val stateDirectory = File(context.noBackupFilesDir, "central-native")
        require(!stateDirectory.exists())
        val language = MoteI18n.preference()
        MoteI18n.select(context, "zh-CN")
        settings.save(before.copy(server = origin, token = token, debugHttp = true,
            syncMode = "manual", syncPaused = true, wifiOnly = false,
            authSignedOut = false, authExpiresAt = 0, authProcess = ""), confirmCentralEndpoint = true)
        try {
            ActivityScenario.launch<CentralActivity>(Intent(context, CentralActivity::class.java).putExtra("page", "plugins")).use { scenario ->
                var activity: CentralActivity? = null
                scenario.onActivity { activity = it }
                fun all() = views(requireNotNull(activity).window.decorView)
                fun installed() {
                    until("The official directory has loaded") { main { all().filterIsInstance<Spinner>().any { it.contentDescription == "插件页面" } } }
                    main { all().filterIsInstance<Spinner>().single { it.contentDescription == "插件页面" }.setSelection(1) }
                    until("Bundled Gmail is present in the installed list") { main { all().any { it.tag == "plugin-toggle:bundled:gmail" } } }
                }
                fun toggle() = all().filterIsInstance<Button>().single { it.tag == "plugin-toggle:bundled:gmail" }
                until("Only the official catalog is shown") { main { all().filterIsInstance<TextView>().any { it.text.toString() == "官方目录" } } }
                assertFalse(main { all().filterIsInstance<TextView>().any { it.text.toString() == "Mem0 CRUD" } })
                screenshot("android-official-directory", requireNotNull(activity))
                installed()
                assertEquals("停用", main { toggle().text.toString() })
                main { toggle().performClick() }
                val api = PluginControlClient(CentralClient(origin, token))
                until("Android's off selection actually stops the Central connector") { api.inventory().builds.single { it.id == "bundled:gmail" }.observed == "stopped" }
                until("Android renders stopped") { main { toggle().text.toString() == "启用" } }
                screenshot("android-gmail-stopped", requireNotNull(activity))
                // The external controller uses a real Web switch after seeing off.
                until("The idle Android list observes Web enabling Gmail") { main { toggle().text.toString() == "停用" } }
                assertEquals("active", api.inventory().builds.single { it.id == "bundled:gmail" }.observed)
                screenshot("android-cross-client-enabled", requireNotNull(activity))
                // Web stops a sibling only after its Mac client has also observed Gmail active.
                until("Web independently stops Google Calendar") { api.inventory().builds.single { it.id == "bundled:google-calendar" }.observed == "stopped" }
                assertEquals("Stopping a sibling leaves Gmail active", "active", api.inventory().builds.single { it.id == "bundled:gmail" }.observed)
                scenario.recreate(); scenario.onActivity { activity = it }
                installed()
                until("Activity recreation reads the durable active selection") { main { toggle().text.toString() == "停用" } }
                val calendar = main { all().filterIsInstance<Button>().single { it.tag == "plugin-toggle:bundled:google-calendar" } }
                assertEquals("启用", main { calendar.text.toString() })
                main { calendar.performClick() }
                until("Android can restore the sibling stopped by Web") { api.inventory().builds.single { it.id == "bundled:google-calendar" }.observed == "active" }
                main { toggle().performClick() }
                until("The recreated Android client can stop the same connector") { api.inventory().builds.single { it.id == "bundled:gmail" }.observed == "stopped" }
                assertFalse(main { all().any { it.tag == "plugin-toggle:bundled:mcp" } })
                assertEquals("No capture starts during plugin administration", false, settings.enabled)
                assertEquals(0, context.queue().inventory().records)
            }
        } finally {
            settings.save(before, confirmCentralEndpoint = true)
            MoteI18n.select(context, language)
            stateDirectory.deleteRecursively()
        }
    }
}
