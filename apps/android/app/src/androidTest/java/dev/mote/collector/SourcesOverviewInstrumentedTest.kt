package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

/** UA17 screenshot fixture: the normal, reconnect, dark and add-source states from generated data. */
@RunWith(AndroidJUnit4::class)
class SourcesOverviewInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val server = "https://mote.example.net"
    private val token = "generated-ua17-overview-token-0123456789abcdef"
    private val zone get() = ZoneId.systemDefault()
    private val today get() = LocalDate.now(zone)

    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun until(label: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(50) }
        fail(label)
    }
    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
    private fun at(time: LocalTime, day: LocalDate = today): Instant = day.atTime(time).atZone(zone).toInstant()
    private fun setScreenConnected(value: Boolean) {
        CaptureAccessibilityService::class.java.getDeclaredField("connected").apply { isAccessible = true }.setBoolean(null, value)
    }
    private fun screenshot(name: String) {
        val windows = WindowInspector.getGlobalWindowViews().filter { it.isShown }
        val decor = windows.firstOrNull { root -> views(root).any { it.tag == "sources-add" || it.tag == "detail-title" } }
            ?: windows.maxByOrNull { it.width.toLong() * it.height } ?: error("No visible window for $name")
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); decor.draw(canvas)
        if (windows.any { it !== decor }) canvas.drawColor(android.graphics.Color.argb(92, 45, 42, 38))
        windows.filter { it !== decor }.forEach { window ->
            val position = IntArray(2); window.getLocationOnScreen(position)
            canvas.save(); canvas.translate(position[0].toFloat(), position[1].toFloat()); window.draw(canvas); canvas.restore()
        }
        val directory = File(context.filesDir, "ua17-sources").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun frames(scenario: ActivityScenario<out Activity>) {
        val frame = java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { a -> a.window.decorView.postOnAnimation { a.window.decorView.postOnAnimation { frame.countDown() } } }
        assertTrue(frame.await(5, java.util.concurrent.TimeUnit.SECONDS))
    }
    private fun waitForOverview(scenario: ActivityScenario<SourcesActivity>, label: String) {
        until("$label rows") {
            var ready = false
            scenario.onActivity { activity ->
                val texts = views(activity.window.decorView).filter { it.isShown }.filterIsInstance<TextView>().map { it.text.toString() }
                ready = texts.contains("采集与同步") && texts.contains("屏幕与应用活动") && texts.contains("通知与设备事件") &&
                    texts.contains("媒体") && texts.contains("同步文件夹") && texts.contains("本机日历") &&
                    texts.contains("添加来源") && texts.any { it == "mote.example.net" } && !texts.any { it.startsWith("正在读取") }
            }
            ready
        }
        instrumentation.waitForIdleSync()
    }

    @Test fun sourcesOverviewMatchesTheDesignFixture() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("secondaryUiFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        val previousConfig = settings.read()
        val prefs = context.getSharedPreferences("mote", 0)
        val previousPrefs = prefs.all.toMap()
        val store = context.localSources()
        val previousSources = store.sources()
        val previousLanguage = MoteI18n.preference()
        val previousAppearance = MoteAppearance.preference()
        val queue = context.queue()
        require(queue.inventory().records == 0) { "Overview screenshots need an empty generated queue" }
        require(MediaCollection.permissionAllowed(context)) { "Grant the generated notification-listener fixture first" }
        require(context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()) { "Grant the generated notification fixture first" }
        require(context.checkSelfPermission(android.Manifest.permission.READ_CALENDAR) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "Grant the generated calendar fixture first" }
        val storageDirectory = File(QueueStorage(context).current().path)
        val beforeFiles = storageDirectory.listFiles().orEmpty().map { it.name }.toSet()
        val storageFixture = File(storageDirectory, "generated-ua17-storage.bin")
        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(context.packageName + ".file-fixtures", "root")
        val created = mutableListOf<LocalSource>()
        try {
            MoteI18n.select(context, "zh-CN"); MoteAppearance.select(context, AppearancePreference.LIGHT)
            setScreenConnected(true)

            fun enqueue(event: JSONObject, image: ByteArray? = null) {
                val id = queue.enqueue(event, image, 64L * 1024 * 1024)
                queue.acknowledge(id, retentionDays = 7)
            }
            val pixels = java.io.ByteArrayOutputStream().use { out ->
                Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.WHITE) }
                    .compress(Bitmap.CompressFormat.PNG, 100, out); out.toByteArray()
            }
            enqueue(JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen").put("deviceId", settings.deviceId)
                .put("capturedAt", at(LocalTime.of(21, 40)).toString()).put("privacy", JSONObject().put("excluded", false))
                .put("imageMime", "image/png").put("ocr", JSONObject().put("status", "completed")).put("ocrText", "Generated UA17 screen"), pixels)
            enqueue(JSONObject().put("id", UUID.randomUUID().toString()).put("source", "device_event").put("deviceId", settings.deviceId)
                .put("capturedAt", at(LocalTime.of(21, 38)).toString()).put("durationMs", 0L).put("platform", "android")
                .put("privacy", JSONObject().put("collection", "system").put("excluded", false))
                .put("metadata", JSONObject().put("version", 1)
                    .put("collector", JSONObject().put("method", "notification_listener"))
                    .put("observedAt", at(LocalTime.of(21, 38)).toString())
                    .put("observation", JSONObject().put("sessionId", UUID.randomUUID().toString()).put("elapsedRealtimeMs", 0L))
                    .put("deviceEvent", JSONObject().put("action", "screen_on").put("keyguardLocked", false).put("screenInteractive", true))))
            enqueue(JSONObject().put("id", UUID.randomUUID().toString()).put("source", "media").put("deviceId", settings.deviceId)
                .put("capturedAt", at(LocalTime.of(21, 0), today.minusDays(1)).toString()).put("durationMs", 0L)
                .put("privacy", JSONObject().put("collection", "content").put("excluded", false))
                .put("metadata", JSONObject().put("media", JSONObject().put("status", "disabled")
                    .put("observedAt", at(LocalTime.of(21, 0), today.minusDays(1)).toString()).put("sessions", org.json.JSONArray()))))

            val tree = treeUri
            context.grantUriPermission(context.packageName, tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            LocalSource(name = "Generated 文档", kind = "local-files", tree = true, uri = tree.toString()).let { store.save(it); created.add(it) }
            LocalSource(name = "Generated 图片", kind = "local-files", tree = true, uri = tree.toString()).let { store.save(it); created.add(it) }
            LocalSource(name = "Generated 日历", kind = "local-calendar", calendarId = 991991).also { created.add(it) }.let { calendar ->
                store.save(calendar)
                store.scan(calendar, SourceScan(emptyList(), true, at(LocalTime.of(2, 0)).toString()))
            }

            fun configure(connected: Boolean) {
                settings.save(previousConfig.copy(server = server, token = token, authExpiresAt = if (connected) 0L else 1L, syncPaused = false,
                    syncMode = "manual", wifiOnly = true, screenCollectionEnabled = true, notificationCollectionEnabled = true,
                    deviceEventCollectionEnabled = true, mediaCollectionEnabled = true, metadataEnabled = true),
                    confirmCentralEndpoint = true)
                prefs.edit().putBoolean("enabled", true).putString("lastUploadAt", at(LocalTime.of(21, 42)).toString())
                    .putString("lastUploadOrigin", server).putString("syncState", "idle").commit()
            }
            configure(connected = true)
            val expectedStorage = 1_288_490_189L
            RandomAccessFile(storageFixture, "rw").use { it.setLength((expectedStorage - queue.diskBytes()).coerceAtLeast(0)) }
            LocalStatusProducer.get(context).refresh()
            until("storage fixture visible") { (LocalStatusProducer.get(context).state.value.active?.diskBytes ?: 0L) >= expectedStorage }

            ActivityScenario.launch(SourcesActivity::class.java).use { scenario ->
                waitForOverview(scenario, "normal")
                frames(scenario)
                screenshot("impl-overview-light")
                for (theme in listOf(AppearancePreference.DARK)) {
                    main { MoteAppearance.select(context, theme) }; instrumentation.waitForIdleSync()
                    frames(scenario)
                    screenshot("impl-overview-dark")
                }
                main { MoteAppearance.select(context, AppearancePreference.LIGHT) }; instrumentation.waitForIdleSync(); frames(scenario)
                until("add row") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).any { it.isShown && it.tag == "sources-add" } }; ready }
                scenario.onActivity { a -> views(a.window.decorView).single { it.isShown && it.tag == "sources-add" }.performClick() }
                until("add sheet") { var ready = false; main { ready = WindowInspector.getGlobalWindowViews().any { root -> root.isShown && views(root).any { it.isShown && it.tag == "add-source:CLOUD" } } }; ready }
                instrumentation.waitForIdleSync()
                screenshot("impl-adding-light")
            }
            ActivityScenario.launch(SourcesActivity::class.java).use { scenario ->
                configure(connected = false)
                scenario.recreate(); instrumentation.waitForIdleSync()
                waitForOverview(scenario, "reconnect")
                until("reconnect copy") { var ready = false; scenario.onActivity { a -> ready = views(a.window.decorView).any { it.isShown && it is TextView && it.text.toString() == "需要重新连接" } }; ready }
                frames(scenario)
                screenshot("impl-reconnect-light")
            }
        } finally {
            runCatching { setScreenConnected(false) }
            runCatching { storageFixture.delete() }
            runCatching { storageDirectory.listFiles().orEmpty().filterNot { it.name in beforeFiles }.forEach { it.delete() } }
            runCatching { context.contentResolver.releasePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            runCatching { created.forEach { store.remove(it.id) } }
            runCatching { prefs.edit().clear().apply { previousPrefs.forEach { (key, value) -> when (value) { is String -> putString(key, value); is Boolean -> putBoolean(key, value); is Int -> putInt(key, value); is Long -> putLong(key, value); is Float -> putFloat(key, value); is Set<*> -> putStringSet(key, value.filterIsInstance<String>().toSet()) } } }.commit() }
            MoteI18n.select(context, previousLanguage); main { MoteAppearance.select(context, previousAppearance) }
        }
    }
}
