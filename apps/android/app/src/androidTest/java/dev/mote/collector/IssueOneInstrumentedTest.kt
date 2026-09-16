package dev.mote.collector

import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Generated fixtures only; never enables screen collection or a model. */
@RunWith(AndroidJUnit4::class)
class IssueOneInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): Sequence<View> = sequence { yield(root); if (root is ViewGroup) repeat(root.childCount) { yieldAll(views(root.getChildAt(it))) } }
    private fun render(activity: android.app.Activity, name: String) {
        if (InstrumentationRegistry.getArguments().getString("renderGeneratedUi") != "true") return
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.contains("emu64a"))
        val view = activity.window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bitmap))
        val directory = java.io.File(context.filesDir, "generated-ui").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    @Test fun settingsArchiveRoundTripsAndNeverReusesTokenOnAnotherHost() {
        val current = Settings(context).read()
        val config = current.copy(server = "https://fixture.example", token = "generated-config-fixture-token-12345678", intervalSeconds = 47,
            uploadedRetentionDays = 30, syncMode = "manual", appCollectionRules = "{\"default\":\"off\",\"apps\":{\"com.miui.home\":\"activity\"}}",
            nsfw = current.nsfw.copy(threads = 3, enabled = false))
        val encoded = ConfigurationArchive.encode(config, true)
        assertEquals(config, ConfigurationArchive.decode(encoded, current))
        val withoutToken = ConfigurationArchive.encode(config)
        assertFalse(withoutToken.contains(config.token))
        assertEquals("", ConfigurationArchive.decode(withoutToken, current.copy(server = "https://other.example", token = "different-generated-token-123456789")).token)
        assertEquals(config, ConfigurationArchive.decode(withoutToken, config))
        val invalid = JSONObject(encoded); invalid.getJSONObject("settings").put("uploadedRetentionDays", 366)
        assertThrows(Exception::class.java) { ConfigurationArchive.decode(invalid.toString(), current) }
        invalid.getJSONObject("settings").put("uploadedRetentionDays", "7")
        assertThrows(Exception::class.java) { ConfigurationArchive.decode(invalid.toString(), current) }
        assertEquals(current, Settings(context).read())
    }
    @Test fun systemHomeAndConfiguredSystemPackagesAreSelectable() {
        val apps = InstalledApps.load(context.packageManager, setOf("com.miui.home"))
        assertTrue(apps.any { it.first == "com.miui.home" })
        @Suppress("DEPRECATION") val homes = context.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
        assertTrue(homes.isNotEmpty()); homes.forEach { home -> assertTrue(apps.any { it.first == home.activityInfo.packageName }) }
        assertEquals(apps.map { it.first }.distinct().size, apps.size)
    }
    @Test fun completedUpdateCannotBeOverwrittenByStaleReconciliationOrCancelledWorker() {
        val wrapper = object : android.content.ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int) = context.getSharedPreferences("generated-issue1-update", mode)
        }
        val store = AppUpdateStore(wrapper)
        try {
            store.beginOperation("first", "download"); store.state("checking", "first"); store.state("ready", "first")
            store.state("scheduler", "first", expectedState = "checking")
            assertEquals("ready", store.prefs.getString("state", ""))
            store.cancelOperation(); store.state("ready", "first")
            assertEquals("cancelled", store.prefs.getString("state", ""))
        } finally { store.prefs.edit().clear().commit() }
    }
    @Test fun saveCompletesWithoutNetworkAndKeepsCollectionStopped() {
        val settings = Settings(context); assertFalse(settings.enabled)
        val current = settings.read(); val next = current.copy(intervalSeconds = if (current.intervalSeconds == 47) 48 else 47)
        val completed = CountDownLatch(1); val result = AtomicReference<Result<RuntimeSettings.Applied>>()
        val previous = HttpJson.onRequest; val requests = java.util.concurrent.atomic.AtomicInteger(); HttpJson.onRequest = { requests.incrementAndGet() }
        try {
            val started = SystemClock.elapsedRealtime()
            instrumentation.runOnMainSync { RuntimeSettings.apply(context, next, expected = current) { result.set(it); completed.countDown() } }
            assertTrue(completed.await(5, TimeUnit.SECONDS)); result.get().getOrThrow()
            assertTrue("Idle settings save should complete promptly", SystemClock.elapsedRealtime() - started < 3000)
            assertEquals(next, settings.read()); assertFalse(settings.enabled); assertEquals(0, requests.get())
        } finally { HttpJson.onRequest = previous; settings.save(current) }
    }
    @Test fun queueBackupAndUpdatePagesShowAvailableActions() {
        val id = UUID.randomUUID().toString(); val queue = context.queue()
        queue.enqueue(JSONObject().put("id", id).put("source", "note").put("capturedAt", "2026-09-16T00:00:00Z")
            .put("ocrText", "generated queue fixture").put("privacy", JSONObject().put("excluded", false)), null, 4_000_000)
        try {
            ActivityScenario.launch(SyncQueueActivity::class.java).awaitUiText("共 ").use { scenario -> scenario.onActivity { activity ->
                assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("等待上传") }); render(activity, "queue")
            } }
            ActivityScenario.launch(BackupActivity::class.java).use { scenario -> scenario.onActivity { activity ->
                val labels = views(activity.window.decorView).filterIsInstance<Button>().map { it.text.toString() }.toList()
                assertTrue(labels.containsAll(listOf("导出配置 JSON", "导入配置 JSON", "导出本机记录 ZIP", "导入本机记录 ZIP"))); render(activity, "backup")
            } }
            ActivityScenario.launch(AppUpdatesActivity::class.java).awaitUiText("检查更新").use { scenario -> scenario.onActivity { activity ->
                val visible = views(activity.window.decorView).filterIsInstance<Button>().filter { it.isShown }.map { it.text.toString() }.toList()
                assertTrue(visible.contains("检查更新")); assertFalse(visible.contains("下载更新")); assertFalse(visible.contains("安装更新")); render(activity, "updates")
            } }
            assertFalse(Settings(context).enabled)
        } finally { queue.acknowledge(id) }
    }
}
