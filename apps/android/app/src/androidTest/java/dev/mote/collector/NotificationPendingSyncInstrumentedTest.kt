package dev.mote.collector

import android.app.Notification
import android.app.NotificationManager
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Temporary fixture: leaves generated pending records and live capture on the dedicated emulator for adb screenshots. */
@RunWith(AndroidJUnit4::class)
class NotificationPendingSyncInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation

    private fun until(label: String, timeoutMs: Long = 30_000, check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < end) { if (check()) return; Thread.sleep(60) }
        fail(label)
    }

    private fun shell(command: String) = automation.executeShellCommand(command).use {
        String(java.io.FileInputStream(it.fileDescriptor).readBytes()).trim()
    }

    @Test fun pendingSyncTitleIsStatusOnlyAndCountStaysInDetails() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("notificationPendingFixture") == "true")
        assumeTrue(Build.FINGERPRINT.contains("emu64a"))
        assumeTrue(context.packageName.endsWith(".test") || context.packageName.endsWith(".filefixture"))
        automation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        until("Local storage finished its startup recovery") { !QueueStorage.recovering }
        val settings = Settings(context)
        settings.save(settings.read().copy(
            screenCollectionEnabled = false, notificationCollectionEnabled = true,
            server = "http://127.0.0.1:47999", token = "generated-notification-owner-token-1234567890",
            debugHttp = true, syncMode = "manual", syncPaused = false))
        settings.capturePreviewAccepted()
        val listener = "${context.packageName}/${MediaCollectionService::class.java.name}"
        val existing = shell("settings get secure enabled_notification_listeners")
        if (!existing.split(':').contains(listener))
            shell("settings put secure enabled_notification_listeners ${if (existing.isBlank() || existing == "null") listener else "$existing:$listener"}")
        until("The notification listener binds under instrumentation", 60_000) { MediaCollectionService.connected }
        settings.enabled = true
        settings.status("capturing", "生成的采集状态")
        ActivityScenario.launch(MainActivity::class.java).use {
            repeat(2) { i ->
                context.queue().enqueue(JSONObject()
                    .put("id", UUID.randomUUID().toString())
                    .put("source", "note")
                    .put("capturedAt", "2026-11-06T00:00:0${i}Z")
                    .put("ocrText", "生成的待同步记录 $i")
                    .put("privacy", JSONObject().put("excluded", false)), null, 4_000_000)
            }
            until("Pending records reach the queue") { context.queue().inventory().records >= 2 }
            until("The ongoing notification carries the status-only title") {
                val notification = manager.activeNotifications.firstOrNull { it.id == Notifications.ID }?.notification ?: return@until false
                val title = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
                title == "采集中" && !title.contains("待同步")
            }
            Thread.sleep(3_000)
            ActivityScenario.launch(ActivityStatsActivity::class.java).use { stats ->
                stats.awaitUiText("待同步")
            }
            assertTrue("Pending records stay queued for manual sync", context.queue().inventory().records >= 2)
        }
    }
}
