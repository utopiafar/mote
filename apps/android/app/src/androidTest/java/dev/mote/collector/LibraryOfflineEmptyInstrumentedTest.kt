package dev.mote.collector

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * Generated offline Library journey: an empty local queue plus no Central login
 * must publish one status and a local empty state, not two login prompts and a
 * false "the whole library is empty" claim. Local records and filtered empty
 * states survive the same page.
 */
@RunWith(AndroidJUnit4::class)
class LibraryOfflineEmptyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun waitFor(label: String, timeout: Long = 30_000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (!condition()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(60) }
    }

    private fun waitForPage(scenario: ActivityScenario<MainActivity>, label: String, condition: () -> Boolean) {
        try { waitFor(label, condition = condition) } catch (error: Throwable) {
            var dump = ""
            scenario.onActivity { activity ->
                dump = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }
                    .joinToString(" | ") { it.text.toString() }
            }
            throw AssertionError("$label: $dump", error)
        }
    }

    private inner class GeneratedProfile : AutoCloseable {
        private var armed = false
        private val pointer get() = File(context.noBackupFilesDir, "queue-location.json")
        private var pointerBytes: ByteArray? = null
        private var pointerChanged = false
        private var prefs: Map<String, Any?> = emptyMap()
        private var language = "system"
        private var appearance = AppearancePreference.AUTO
        private var directory: File? = null
        private var settings: Settings? = null
        private var config: CollectorConfig? = null
        private var state = ""
        private var message = ""

        fun open(server: String = "", token: String = "", signedOut: Boolean = true) {
            val startup = SystemClock.elapsedRealtime() + 30_000
            while (QueueStorage.recovering || QueueStorage.maintaining) {
                check(SystemClock.elapsedRealtime() < startup) { "Local storage recovery did not settle" }
                Thread.sleep(40)
            }
            prefs = context.getSharedPreferences("mote", Context.MODE_PRIVATE).all.toMap()
            pointerBytes = pointer.takeIf { it.exists() }?.readBytes()
            language = MoteI18n.preference(); appearance = MoteAppearance.preference()
            val id = UUID.randomUUID().toString()
            val privateQueue = File(context.noBackupFilesDir, "mote-queue-$id")
            check(privateQueue.mkdir()); directory = privateQueue; armed = true
            LocalDataFormat.requireCurrent(privateQueue)
            File(privateQueue, ".mote-storage-id").writeText(id)
            DurableQueue.exclusive {
                val temp = File.createTempFile("generated-library-pointer-", ".tmp", context.noBackupFilesDir)
                try {
                    java.io.FileOutputStream(temp).use { it.write(QueueLocation(id, "internal", privateQueue.absolutePath).json().toString().toByteArray()); it.fd.sync() }
                    check(temp.renameTo(pointer))
                } finally { check(!temp.exists() || temp.delete()) }
                pointerChanged = true
            }
            MoteI18n.select(context, "zh-CN")
            MoteAppearance.select(context, AppearancePreference.LIGHT)
            val store = Settings(context)
            settings = store; config = store.read(); state = store.state(); message = store.message()
            store.save(config!!.copy(server = server, token = token, authSignedOut = signedOut, authExpiresAt = 0, authProcess = "", debugHttp = server.startsWith("http://"), syncMode = "manual"), confirmCentralEndpoint = true)
            LocalStateChanges.changed(records = true, immediate = true)
        }

        fun note(id: String, at: Instant) = JSONObject()
            .put("id", id).put("deviceId", Settings(context).deviceId).put("deviceName", "Generated offline phone").put("platform", "android")
            .put("source", "note").put("windowTitle", "Generated local library note").put("capturedAt", at.toString())
            .put("durationMs", 0).put("ocrText", "Generated local library note")
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none").put("collection", "content"))

        override fun close() {
            if (!armed) return
            armed = false
            DurableQueue.exclusive {
                if (pointerChanged) {
                    val bytes = pointerBytes
                    if (bytes == null) check(!pointer.exists() || pointer.delete())
                    else {
                        val temp = File.createTempFile("generated-library-pointer-", ".tmp", context.noBackupFilesDir)
                        try {
                            java.io.FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }
                            check(temp.renameTo(pointer))
                        } finally { check(!temp.exists() || temp.delete()) }
                    }
                }
                directory?.let { check(it.deleteRecursively()) }
            }
            val store = settings ?: return
            store.save(requireNotNull(config)); store.status(state, message)
            val original = context.getSharedPreferences("mote", Context.MODE_PRIVATE)
            val edit = original.edit()
            original.all.keys.filter { it !in prefs }.forEach(edit::remove)
            prefs.forEach { (key, value) -> when (value) {
                is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value)
                is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") edit.putStringSet(key, value as Set<String>)
            } }
            check(edit.commit()); MoteI18n.select(context, language); MoteAppearance.select(context, appearance)
            LocalStateChanges.changed(records = true, immediate = true)
        }
    }

    private fun textShown(scenario: ActivityScenario<MainActivity>, value: String): Boolean {
        var found = false
        scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == value } }
        return found
    }

    private fun loginCount(scenario: ActivityScenario<MainActivity>): Int {
        var count = 0
        scenario.onActivity { activity -> count = views(activity.window.decorView).filterIsInstance<TextView>().count { it.isShown && it.text.toString() == MoteI18n.text("先登录中央，各页面会共用这次登录") } }
        return count
    }

    private fun hasAllEmptyClaim(scenario: ActivityScenario<MainActivity>): Boolean {
        var found = false
        scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString().startsWith("这里还没有内容") } }
        return found
    }

    private fun moreVisible(scenario: ActivityScenario<MainActivity>): Boolean {
        var found = false
        scenario.onActivity { activity -> found = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("加载更多") } }
        return found
    }

    private fun statusCount(scenario: ActivityScenario<MainActivity>, text: String): Int {
        var count = 0
        scenario.onActivity { activity -> count = views(activity.window.decorView).filterIsInstance<TextView>().count { it.isShown && it.text.toString() == text } }
        return count
    }

    private fun screenshot(scenario: ActivityScenario<MainActivity>, name: String) {
        var bytes: ByteArray? = null
        scenario.onActivity { activity ->
            val root = activity.window.decorView
            val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            try {
                root.draw(android.graphics.Canvas(bitmap))
                val output = java.io.ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                bytes = output.toByteArray()
            } finally { bitmap.recycle() }
        }
        File(context.getExternalFilesDir(null), "library-offline-empty").apply { mkdirs() }.resolve("$name.png").writeBytes(requireNotNull(bytes))
    }

    @Test fun oneOfflineStatusAndRealLocalEmptyStateAcrossThemes() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        val generated = GeneratedProfile()
        try {
            generated.open()
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
                waitForPage(scenario, "one login prompt and a confirmed local empty state") {
                    loginCount(scenario) == 1 && textShown(scenario, "本机没有资料。") && !moreVisible(scenario)
                }
                assertEquals("Only one status may repeat the login requirement", 1, loginCount(scenario))
                assertFalse("Central was not read, so the whole library is not proven empty", hasAllEmptyClaim(scenario))
                screenshot(scenario, "impl-library-offline-empty-light")

                MoteAppearance.select(context, AppearancePreference.DARK)
                scenario.recreate()
                waitFor("one login prompt in dark") { loginCount(scenario) == 1 && textShown(scenario, "本机没有资料。") && !moreVisible(scenario) }
                assertFalse(hasAllEmptyClaim(scenario))
                screenshot(scenario, "impl-library-offline-empty-dark")

                val id = UUID.randomUUID().toString()
                val queue = context.queue()
                queue.enqueue(generated.note(id, Instant.now().minusSeconds(2)), null, 16_000_000)
                LocalStateChanges.changed(records = true, immediate = true)
                waitFor("local record survives signed-out Central") {
                    var found = false
                    scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.tag == "library-record:$id" } }
                    found && loginCount(scenario) == 1 && !moreVisible(scenario)
                }
                assertFalse("A local record must not coexist with an empty state", textShown(scenario, "本机没有资料。"))
                screenshot(scenario, "impl-library-local-record-dark")

                MoteAppearance.select(context, AppearancePreference.LIGHT)
                scenario.recreate()
                waitFor("local record survives in light") {
                    var found = false
                    scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.tag == "library-record:$id" } }
                    found && loginCount(scenario) == 1 && !moreVisible(scenario)
                }
                screenshot(scenario, "impl-library-local-record-light")

                scenario.chooseLibraryCategory("images")
                waitFor("a filtered local empty state is still real") {
                    textShown(scenario, "当前筛选下暂无本机资料。") && loginCount(scenario) == 1 && !moreVisible(scenario)
                }
                assertEquals(1, loginCount(scenario))
                screenshot(scenario, "impl-library-filter-empty-light")

                MoteAppearance.select(context, AppearancePreference.DARK)
                scenario.recreate()
                waitForPage(scenario, "the filtered local empty state is real in dark") {
                    textShown(scenario, "当前筛选下暂无本机资料。") && loginCount(scenario) == 1 && !moreVisible(scenario)
                }
                screenshot(scenario, "impl-library-filter-empty-dark")

                scenario.chooseLibraryCategory("all")
                waitFor("returning to all categories restores the local record") {
                    var found = false
                    scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.tag == "library-record:$id" } }
                    found
                }
            }
        } finally { generated.close() }
    }

    @Test fun configuredButUnreachableCentralKeepsOneStatusAndLocalRecords() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        require(!Settings(context).enabled && CaptureAccessibilityService.instance == null && !ProjectionService.running)
        val generated = GeneratedProfile()
        try {
            generated.open("http://127.0.0.1:59999", "generated-offline-token-0123456789abcdef", signedOut = false)
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("page", "LIBRARY")).awaitMainUi().use { scenario ->
                val offline = MoteI18n.text("中央暂不可用 · 保留本机状态，恢复连接后重试")
                waitForPage(scenario, "one offline status and a confirmed local empty state") {
                    statusCount(scenario, offline) == 1 && textShown(scenario, "本机没有资料。") && !moreVisible(scenario)
                }
                assertEquals("Both readers must share the same offline status", 1, statusCount(scenario, offline))
                assertFalse(hasAllEmptyClaim(scenario))
                screenshot(scenario, "impl-library-offline-central-light")

                MoteAppearance.select(context, AppearancePreference.DARK)
                scenario.recreate()
                waitForPage(scenario, "one offline status and a confirmed local empty state in dark") {
                    statusCount(scenario, offline) == 1 && textShown(scenario, "本机没有资料。") && !moreVisible(scenario)
                }
                screenshot(scenario, "impl-library-offline-central-dark")

                val id = UUID.randomUUID().toString()
                context.queue().enqueue(generated.note(id, Instant.now().minusSeconds(2)), null, 16_000_000)
                LocalStateChanges.changed(records = true, immediate = true)
                waitFor("local record remains visible while Central is unreachable") {
                    var found = false
                    scenario.onActivity { activity -> found = views(activity.window.decorView).any { it.isShown && it.tag == "library-record:$id" } }
                    found && statusCount(scenario, offline) == 1 && !moreVisible(scenario)
                }
                assertFalse(textShown(scenario, "本机没有资料。"))
            }
        } finally { generated.close() }
    }
}
