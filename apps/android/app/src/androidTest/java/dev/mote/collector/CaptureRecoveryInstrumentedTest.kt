package dev.mote.collector

import android.app.UiAutomation
import android.content.ComponentName
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Dedicated emulator; only the generated ExternalFixtureActivity is captured. */
@RunWith(AndroidJUnit4::class)
class CaptureRecoveryInstrumentedTest {
    @Test fun configuredPrivacyRulesAndActivityMediaDoNotBlockGeneratedScreenshots() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String) = automation.executeShellCommand(command).use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
        require(shell("getprop ro.boot.qemu.avd_name") == "mote_fixture_api35")
        require(context.packageName == "dev.mote.collector.dev")
        val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0)
        val before = settings.read()
        val previousServices = shell("settings get secure enabled_accessibility_services")
        val fixture = context.packageName + ".test"
        fun waitFor(check: () -> Boolean) {
            val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
            while (android.os.SystemClock.elapsedRealtime() < deadline) {
                if (check()) return
                Thread.sleep(100)
            }
            fail("Generated capture did not reach the expected state")
        }
        try {
            shell("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
            shell("settings put secure enabled_accessibility_services ${context.packageName}/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1")
            shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard")
            waitFor { CaptureAccessibilityService.connected }
            val config = before.copy(server = "", token = "", syncMode = "manual", mode = "accessibility", intervalSeconds = 5,
                screenCollectionEnabled = true, mediaCollectionEnabled = false, notificationCollectionEnabled = false, deviceEventCollectionEnabled = false,
                excludedPackages = "", appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "fixture.private=activity").json(),
                chargingOnly = false, batteryPauseBelowPct = 0, uiPageMode = "screen_only", imageDedupeMode = "off", uploadGate = UploadGateConfig(false, "", "hold"))
            settings.save(config)
            // This legal media record poisoned the shared queue in 0.0.63–0.0.65.
            val media = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-09-24T00:00:00Z")
                .put("source", "media").put("durationMs", 0).put("privacy", JSONObject().put("excluded", false).put("collection", "activity"))
                .put("metadata", JSONObject().put("media", MediaPrivacy.snapshot("disabled", emptyList())))
            context.queue().enqueue(media, null, 1_000_000)
            context.startActivity(Intent().setComponent(ComponentName(fixture, ExternalFixtureActivity::class.java.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitFor { CaptureAccessibilityService.instance?.windowSnapshot()?.foreground == fixture && MoteApplication.visibleActivities == 0 }
            settings.enabled = true
            waitFor { context.queue().inventory().images > 0 }
            settings.enabled = false
            val queue = context.queue()
            assertNull(queue.pendingStageFailure)
            assertTrue(queue.inventory().images >= 1)
            assertNotNull(queue.capture(media.getString("id")))
            val counts = Operations.ledger(context).read().getJSONObject("counts")
            assertTrue(counts.getLong("CAPTURE_REQUESTED") > 0)
            assertTrue(counts.getLong("SCREEN_QUEUED") > 0)
        } finally {
            settings.enabled = false
            CaptureAccessibilityService.instance?.stopCapture()
            settings.save(before)
            if (previousServices == "null") shell("settings delete secure enabled_accessibility_services")
            else shell("settings put secure enabled_accessibility_services $previousServices")
        }
    }
}
