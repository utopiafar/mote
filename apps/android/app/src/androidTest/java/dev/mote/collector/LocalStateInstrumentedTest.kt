package dev.mote.collector

import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Dedicated emulator only; all records and images below are generated. */
@RunWith(AndroidJUnit4::class)
class LocalStateInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use { ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { r -> r.readText() } }
    private fun views(view: View): List<View> = buildList { add(view); if (view is ViewGroup) repeat(view.childCount) { addAll(views(view.getChildAt(it))) } }
    private fun waitFor(label: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 30000
        while (!condition()) { check(System.currentTimeMillis() < until) { "Timed out: $label" }; Thread.sleep(80) }
    }
    private fun <A : android.app.Activity> textAppears(scenario: ActivityScenario<A>, text: String) {
        waitFor("UI $text") { var found = false; scenario.onActivity { a -> found = views(a.window.decorView).filterIsInstance<TextView>().any { it.text.contains(text) } }; found }
    }
    @Test fun stockUpdatesAllConsumersAndSurvivesBackgroundWithoutCounterDeltas() {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        require(shell("getprop ro.boot.qemu.avd_name").trim() == "mote_fixture_api35")
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running)
        waitFor("recovery") { !QueueStorage.recovering }
        val repository = LocalStateRepository.get(context); val queue = context.queue(); val pending = BulkDedupeStore(context).quarantine()
        require(queue.depth() == 0 && pending.depth() == 0)
        val settings = Settings(context); val original = settings.read(); val originalState = settings.state(); val originalMessage = settings.message()
        val ids = mutableListOf<String>(); val notifications = context.getSystemService(NotificationManager::class.java)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default); val emissions = AtomicInteger()
        val observer = scope.launch { repository.state.collect { emissions.incrementAndGet() } }
        val bitmap = Bitmap.createBitmap(96, 160, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.WHITE) }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray(); bitmap.recycle()
        val at = Instant.now().toString()
        fun add(image: Boolean = true): String {
            val id = UUID.randomUUID().toString(); ids += id
            val row = JSONObject().put("id", id).put("source", if (image) "screen" else "note").put("appId", "fixture.state")
                .put("capturedAt", at).put("privacy", JSONObject().put("excluded", false)).put("ocr", JSONObject().put("status", if (image) "pending" else "disabled"))
            queue.enqueue(row, if (image) bytes else null, 100000000)
            return id
        }
        fun stock(active: Int, held: Int) {
            val revision = LocalStateChanges.revisions.value.value
            waitFor("stock $active / $held") { repository.state.value.let { it.revision.value >= revision && it.error == null && it.active?.images == active && it.quarantine?.images == held } }
        }
        fun move(id: String, reference: String) { val hash = queue.dedupeRow(id)!!.getString("blob"); assertTrue(queue.resolveDedupe(id, hash, reference, hash, pending)) }
        fun restore(id: String) { assertTrue(pending.resolveDedupe(id, pending.dedupeRow(id)!!.getString("blob"), null, null, queue)) }
        try {
            WorkManager.getInstance(context).cancelAllWork().result.get()
            settings.save(original.copy(server = "", token = "", syncMode = "manual", ocrChargingOnly = true))
            shell("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
            val a = add(); val b = add(); add(false)
            stock(2, 0)
            assertEquals(3, repository.state.value.active!!.records); assertEquals(1, repository.state.value.active!!.imageFiles)
            val cumulative = Operations.ledger(context).read().getJSONObject("counts").getLong("SCREEN_QUEUED")
            settings.status("capturing", "generated state")
            instrumentation.runOnMainSync { Notifications.show(context, "generated old count 999") }
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                textAppears(scenario, "当前图片 2 张")
                move(b, a); stock(1, 1); textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
                waitFor("notification stock") { notifications.activeNotifications.any { it.id == Notifications.ID && it.notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.contains("采集区 1 张 · 待决定区 1 张") == true } }
                assertFalse(notifications.activeNotifications.first { it.id == Notifications.ID }.notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().contains("999"))
                assertEquals(cumulative, Operations.ledger(context).read().getJSONObject("counts").getLong("SCREEN_QUEUED"))
                scenario.moveToState(Lifecycle.State.CREATED); restore(b); stock(2, 0)
                scenario.moveToState(Lifecycle.State.RESUMED); textAppears(scenario, "采集区 2 张 · 待决定区 0 张")
                scenario.recreate(); textAppears(scenario, "当前图片 2 张")
            }
            ActivityScenario.launch(StorageActivity::class.java).use { scenario ->
                textAppears(scenario, "采集区 2 张"); move(b, a); stock(1, 1); textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
            }
            ActivityScenario.launch(ActivityStatsActivity::class.java).use { scenario ->
                textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
                textAppears(scenario, "目录大小为最近测量值")
                scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<Button>().first { it.text == "刷新实际存储与统计" }.performClick() }
                restore(b); stock(2, 0); textAppears(scenario, "采集区 2 张 · 待决定区 0 张")
                move(b, a); stock(1, 1); textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
            }
            ActivityScenario.launch(SyncRecoveryActivity::class.java).use { scenario ->
                textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
                restore(b); stock(2, 0); textAppears(scenario, "采集区 2 张 · 待决定区 0 张")
                move(b, a); stock(1, 1); textAppears(scenario, "采集区 1 张 · 待决定区 1 张")
            }
            ActivityScenario.launch(BulkDedupeActivity::class.java).use { scenario ->
                scenario.onActivity { a -> views(a.window.decorView).filterIsInstance<Button>().first { it.text == "切换：扫描结果 / 待决定区" }.performClick() }
                textAppears(scenario, "待决定区 · 1 条"); restore(b); stock(2, 0); textAppears(scenario, "待决定区 · 0 条")
            }
            ActivityScenario.launch(CaptureRecordsActivity::class.java).use { scenario ->
                textAppears(scenario, "2 张截图")
                scenario.onActivity { a -> views(a.window.decorView).first { it.tag?.toString()?.startsWith("album:") == true }.performClick() }
                waitFor("candidate initially visible") { var found = false; scenario.onActivity { a -> found = views(a.window.decorView).any { it.tag == "capture:$b" } }; found }
                move(b, a); stock(1, 1)
                waitFor("deleted row leaves current page") { var found = true; scenario.onActivity { a -> found = views(a.window.decorView).any { it.tag == "capture:$b" } }; !found }
                textAppears(scenario, "1 条")
            }
            // Missing storage retains a clearly marked last good value; explicit calibration recovers.
            val blob = File(QueueStorage(context).current().path, queue.dedupeRow(a)!!.getString("blob") + ".blob")
            val saved = File(blob.parentFile, "generated-fixture-held")
            try {
                assertTrue(blob.renameTo(saved)); repository.refresh()
                waitFor("stale inventory") { repository.state.value.error != null }
                assertEquals(1, repository.state.value.active!!.images); assertTrue(repository.state.value.imageLabel().contains("上次结果"))
            } finally { if (saved.exists()) check(saved.renameTo(blob)); repository.refresh() }
            stock(1, 1)
            queue.acknowledge(a); waitFor("uploaded OCR retained") { repository.state.value.active?.pending == 1 }
            queue.completeOcr(a, "generated", "completed", 100000000); waitFor("OCR pending sync") { repository.state.value.active?.pending == 2 }
            queue.acknowledgeOcr(a); stock(0, 1)
            pending.resolveDedupe(b, pending.dedupeRow(b)!!.getString("blob"), null, null, null); stock(0, 0)
            val countBefore = emissions.get()
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                val writer = java.util.concurrent.Executors.newSingleThreadExecutor()
                try {
                    val task = writer.submit { repeat(40) { add(false) } }
                    repeat(8) {
                        val start = System.currentTimeMillis()
                        scenario.onActivity { assertFalse(it.isDestroyed) }
                        assertTrue("UI must respond during committed mutations", System.currentTimeMillis() - start < 1500)
                        Thread.sleep(20)
                    }
                    task.get(30, java.util.concurrent.TimeUnit.SECONDS)
                } finally { writer.shutdownNow() }
            }
            waitFor("burst final state") { repository.state.value.active?.records == 41 }
            assertTrue("Batch invalidations must be conflated", emissions.get() - countBefore < 40)
        } finally {
            WorkManager.getInstance(context).cancelAllWork().result.get()
            ids.forEach { id -> listOf(queue, pending).forEach { q -> q.dedupeRow(id)?.let { q.resolveDedupe(id, it.optString("blob"), null, null, null) } } }
            settings.save(original); settings.status(originalState, originalMessage); Notifications.clear(context)
            observer.cancel(); scope.cancel(); repository.refresh()
        }
    }
}
