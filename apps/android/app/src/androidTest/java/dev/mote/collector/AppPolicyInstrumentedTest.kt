package dev.mote.collector

import android.app.UiAutomation
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class AppPolicyInstrumentedTest {
    @Test fun generatedProviderReportsActualSizeAndModificationWithoutInventingDates() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val authority = context.packageName + ".source-fixtures"
        val prefs = context.getSharedPreferences("source-fixture", 0); prefs.edit().clear().putString("mode", "full").commit()
        try {
            val source = LocalSource(name = "合成元数据文件", kind = "local-files", uri = "content://$authority/tree/root", tree = true)
            val provider = SourceProviders(context.contentResolver)
            val snapshot = provider.scan(source).items.single()
            assertEquals(100, snapshot.getJSONObject("metadata").getJSONObject("file").getLong("sizeBytes"))
            assertEquals(Instant.ofEpochMilli(1790000000000L).toString(), snapshot.getString("modifiedAt"))
            val reads = prefs.getInt("reads", 0); val reference = provider.scan(source.copy(retention = "reference")).items.single()
            assertEquals(reads, prefs.getInt("reads", 0)); assertEquals("", reference.getString("text"))
            assertEquals(setOf("sizeBytes"), reference.getJSONObject("metadata").getJSONObject("file").keys().asSequence().toSet())
        } finally { prefs.edit().clear().commit() }
    }
    @Test fun activityPipelineDoesNotNeedModelsAndMetadataTogglePreservesQueuedBytes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap(); val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0)
        var pipeline: CapturePipeline? = null
        try {
            val baseline = Operations.ledger(context).read().getJSONObject("counts")
            val config = settings.read().copy(server = "https://127.0.0.1:1", token = "generated-policy-test-token-only-123456789", mode = "projection", nsfw = settings.read().nsfw.copy(enabled = true),
                appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
            settings.save(config); settings.enabled = true; assertEquals("accessibility", config.effectiveMode())
            val windows = WindowSnapshot(setOf("com.example.generated"), "com.example.generated", true)
            pipeline = CapturePipeline(context) { }
            assertFalse(pipeline.canCapture(config, windows)); assertTrue(pipeline.canCollect(config, windows, AppCollectionMode.ACTIVITY))
            pipeline.submitActivity(windows, config); waitUntil { context.queue().depth() == 1 && pipeline?.isBusy() == false }
            val first = context.queue().peek()!!; val preserved = first.toString()
            assertEquals("activity", first.getString("source")); assertFalse(first.has("ocrText")); assertFalse(first.has("imageBase64"))
            assertEquals(setOf("intervalMs"), first.getJSONObject("metadata").getJSONObject("capture").keys().asSequence().toSet())
            settings.enabled = false; pipeline.close(); pipeline = null
            val without = config.copy(metadataEnabled = false); settings.save(without); settings.enabled = true
            pipeline = CapturePipeline(context) { }; pipeline.submitActivity(windows, without)
            waitUntil { context.queue().depth() == 2 && pipeline?.isBusy() == false }
            assertEquals(preserved, context.queue().peek()!!.toString())
            context.queue().acknowledge(first.getString("id"))
            val second = context.queue().peek()!!; assertFalse(second.has("metadata")); assertEquals("activity", second.getString("source"))
            val after = Operations.ledger(context).read().getJSONObject("counts")
            assertEquals(baseline.getLong("CAPTURE_REQUESTED"), after.getLong("CAPTURE_REQUESTED"))
            assertEquals(baseline.getLong("FRAME_RECEIVED"), after.getLong("FRAME_RECEIVED"))
            assertEquals(2, after.getLong("ACTIVITY_QUEUED") - baseline.getLong("ACTIVITY_QUEUED"))
            context.queue().acknowledge(second.getString("id"))
        } finally { settings.enabled = false; pipeline?.close(); restore(prefs, original) }
    }
    @Test fun optionalGeneratedServiceActivityContentAndFileMetadataReachCentral() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val input = File(context.filesDir, "app-policy-fixture.json")
        assumeTrue("Explicit generated-only local central fixture required", input.exists())
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val fixture = JSONObject(input.readText()); require(fixture.getBoolean("generatedOnly"))
        val server = fixture.getString("serverUrl"); require(server.startsWith("http://127.0.0.1:")); val token = fixture.getString("token")
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String) = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        val avd = shell("getprop ro.boot.qemu.avd_name"); require(avd in setOf("mote_fixture_api35", "mote_release_060"))
        val settings = Settings(context); require(!settings.enabled && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val services = shell("settings get secure enabled_accessibility_services"); val accessibility = shell("settings get secure accessibility_enabled")
        require(context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "Host fixture must grant and later restore notification permission outside instrumentation" }
        val baseline = Operations.ledger(context).read().getJSONObject("counts")
        fun count(kind: String) = Operations.ledger(context).read().getJSONObject("counts").getLong(kind) - baseline.getLong(kind)
        fun stop() { settings.enabled = false; CaptureAccessibilityService.instance?.stopCapture(); waitUntil { ConnectionGuard.processing.get() == 0 } }
        fun records(source: String): org.json.JSONArray {
            val (status, result) = HttpJson.get("$server/api/captures?deviceId=${settings.deviceId}&source=$source&limit=50", token)
            assertEquals(200, status); return result!!.getJSONArray("items")
        }
        try {
            shell("settings put secure enabled_accessibility_services ${context.packageName}/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1")
            waitUntil { CaptureAccessibilityService.connected }
            openFixture()
            val config = settings.read().copy(server = server, token = token, deviceName = "合成 Android 分级采集", intervalSeconds = 5, wifiOnly = false, debugHttp = true,
                mode = "projection", nsfw = settings.read().nsfw.copy(enabled = true), appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
            settings.save(config)
            assertEquals("accessibility", config.effectiveMode())
            androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity -> MainActivity::class.java.getDeclaredMethod("startCapture").apply { isAccessible = true }.invoke(activity) }
                assertTrue(settings.enabled); assertFalse(ProjectionService.running)
                openFixture()
                waitUntil { count("ACTIVITY_ACK") >= 2 }; stop()
                assertFalse(ProjectionService.running)
            }
            openFixture()
            assertEquals(0, count("CAPTURE_REQUESTED")); assertEquals(0, count("FRAME_RECEIVED")); assertEquals(0, count("SCREEN_QUEUED"))
            val activity = records("activity"); assertTrue(activity.length() >= 2)
            for (i in 0 until activity.length()) {
                val row = activity.getJSONObject(i); assertEquals("", row.getString("ocrText")); assertEquals("", row.getString("windowTitle")); assertTrue(row.isNull("blobHash"))
                assertEquals("activity", row.getJSONObject("privacy").getString("collection"))
                assertEquals(setOf("intervalMs"), row.getJSONObject("metadata").getJSONObject("capture").keys().asSequence().toSet())
            }
            settings.save(config.copy(excludedPackages = context.packageName)); settings.enabled = true
            val saved = count("ACTIVITY_QUEUED"); Thread.sleep(5500); stop()
            assertEquals(saved, count("ACTIVITY_QUEUED")); assertEquals(0, count("CAPTURE_REQUESTED"))
            // Explicit fixture setting disables image review only for generated screen/OCR transport validation.
            val content = config.copy(mode = "accessibility", appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.OFF, "${context.packageName}=content\ncom.android.systemui=content").json(), nsfw = config.nsfw.copy(enabled = false))
            settings.save(content); settings.enabled = true; waitUntil { count("SCREEN_ACK") >= 1 }; stop(); waitUntil { context.queue().depth() == 0 }
            val screen = records("screen").getJSONObject(0); assertEquals("content", screen.getJSONObject("privacy").getString("collection"))
            assertTrue(screen.getString("ocrText").contains("MOTE")); assertTrue(screen.getJSONObject("metadata").getJSONObject("capture").getInt("width") > 0)
            val authority = context.packageName + ".source-fixtures"
            context.getSharedPreferences("source-fixture", 0).edit().clear().putString("mode", "full").commit()
            val source = LocalSource(name = "Android 合成文件元数据", kind = "local-files", uri = "content://$authority/tree/root", tree = true)
            val temporary = File(context.noBackupFilesDir, "policy-source-fixture")
            try {
                val local = LocalSourceStore(temporary, SecretBox()); local.save(source); local.selectTarget(source.id, "fixture")
                local.scan(source, SourceProviders(context.contentResolver).scan(source))
                assertTrue(HttpJson.post("$server/api/sources", source.registration(settings.deviceId), token).first in 200..299)
                val item = local.next(source.id, "fixture")!!; val reply = HttpJson.request("PUT", "$server/api/sources/${source.id}/items", item, token)
                assertTrue(reply.first in 200..299); assertTrue(SourceRules.validAck(source.id, item, reply.second))
                val (code, response) = HttpJson.get("$server/api/sources/${source.id}/items", token); assertEquals(200, code)
                val metadata = response!!.getJSONArray("items").getJSONObject(0).getJSONObject("metadata").getJSONObject("file")
                assertEquals(setOf("sizeBytes"), metadata.keys().asSequence().toSet()); assertEquals(100, metadata.getLong("sizeBytes"))
            } finally { temporary.deleteRecursively() }
            File(context.filesDir, "app-policy-result.json").writeText(JSONObject().put("deviceId", settings.deviceId).put("generatedOnly", true)
                .put("activityAcknowledged", activity.length()).put("activityScreenshotRequests", 0).put("activityImageReads", 0)
                .put("globalActivityNoProjectionAuthorization", true).put("excludedActivityNotSaved", true).put("contentAcknowledged", true).put("fileMetadataRoundTrip", true).put("actualModel", false).toString())
        } finally {
            stop(); WorkManager.getInstance(context).cancelUniqueWork("mote-upload").result.get(5, TimeUnit.SECONDS)
            WorkManager.getInstance(context).cancelUniqueWork("mote-upload-recovery").result.get(5, TimeUnit.SECONDS)
            shell("settings put secure enabled_accessibility_services ${if (services == "null") "''" else services}")
            shell("settings put secure accessibility_enabled ${if (accessibility == "null") "0" else accessibility}")
            restore(prefs, original); context.getSharedPreferences("source-fixture", 0).edit().clear().commit()
        }
    }
    @Test fun generatedImageProcessingKeepsObservationTimeInsteadOfCompletionTime() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val settings = Settings(context); require(!settings.enabled && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val windows = WindowSnapshot(setOf("com.example.generated"), "com.example.generated", true)
        var pipeline: CapturePipeline? = null
        fun generated() = android.graphics.Bitmap.createBitmap(240, 120, android.graphics.Bitmap.Config.ARGB_8888).apply {
            val canvas = android.graphics.Canvas(this); canvas.drawColor(android.graphics.Color.WHITE)
            canvas.drawText("MOTE 2048", 12f, 65f, android.graphics.Paint().apply { color = android.graphics.Color.BLACK; textSize = 28f })
        }
        try {
            val c = settings.read().copy(server = "https://127.0.0.1:1", token = "generated-timing-fixture-only-123456789", intervalSeconds = 15,
                excludedPackages = "", appCollectionRules = AppCollectionRules.DEFAULT, nsfw = settings.read().nsfw.copy(enabled = false))
            settings.save(c); settings.enabled = true; pipeline = CapturePipeline(context) { }
            pipeline.submit(generated(), windows, c, "2026-09-14T00:00:00Z", 0)
            waitUntil { context.queue().depth() == 1 && pipeline?.isBusy() == false }
            val first = context.queue().peek()!!; assertEquals(0, first.getLong("durationMs")); context.queue().acknowledge(first.getString("id"))
            Thread.sleep(250) // Independent asynchronous processing gap, deliberately not fifteen seconds.
            pipeline.submit(generated(), windows, c, "2026-09-14T00:00:15Z", 15000)
            waitUntil { context.queue().depth() == 1 && pipeline?.isBusy() == false }
            val second = context.queue().peek()!!; assertEquals(15000, second.getLong("durationMs")); assertEquals("2026-09-14T00:00:15Z", second.getString("capturedAt"))
            assertTrue(second.getString("ocrText").contains("MOTE")); context.queue().acknowledge(second.getString("id"))
        } finally { settings.enabled = false; pipeline?.close(); restore(prefs, original) }
    }
    @Test fun optionalGeneratedProjectionReusesDisplayAndNeverAttachesActivitySurface() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val input = File(context.filesDir, "app-policy-fixture.json")
        assumeTrue("Explicit generated-only local central fixture required", input.exists())
        require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val fixture = JSONObject(input.readText()); require(fixture.getBoolean("generatedOnly")); require(fixture.getString("serverUrl").startsWith("http://127.0.0.1:"))
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String) = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        require(shell("getprop ro.boot.qemu.avd_name") in setOf("mote_fixture_api35", "mote_release_060"))
        require(context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
        val settings = Settings(context); require(!settings.enabled && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val services = shell("settings get secure enabled_accessibility_services"); val accessibility = shell("settings get secure accessibility_enabled")
        fun stop() { settings.enabled = false; context.stopService(Intent(context, ProjectionService::class.java)); waitUntil { !ProjectionService.running && ConnectionGuard.processing.get() == 0 } }
        try {
            shell("settings put secure enabled_accessibility_services ${context.packageName}/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1"); waitUntil { CaptureAccessibilityService.connected }
            val base = settings.read().copy(server = fixture.getString("serverUrl"), token = fixture.getString("token"), deviceName = "合成 Android 投屏分级", intervalSeconds = 5,
                wifiOnly = false, debugHttp = true, mode = "projection", excludedPackages = "")
            var activityRequests = -1L; var contentRequests = -1L
            for (mode in listOf(AppCollectionMode.ACTIVITY, AppCollectionMode.CONTENT)) {
                val c = base.copy(appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.OFF, "${context.packageName}=${mode.wire}\ncom.android.systemui=content").json(),
                    nsfw = base.nsfw.copy(enabled = mode == AppCollectionMode.ACTIVITY))
                settings.save(c)
                val before = Operations.ledger(context).read().getJSONObject("counts")
                fun delta(key: String) = Operations.ledger(context).read().getJSONObject("counts").getLong(key) - before.getLong(key)
                androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    scenario.onActivity { activity -> MainActivity::class.java.getDeclaredMethod("startCapture").apply { isAccessible = true }.invoke(activity) }
                    // Only a generated-only task AVD may accept the real Android consent dialog.
                    waitUntil {
                        val root = automation.rootInActiveWindow
                        if (root?.packageName?.toString() != "com.android.systemui") false else {
                            val buttons = root.findAccessibilityNodeInfosByViewId("android:id/button1")
                            buttons.firstOrNull { it.isEnabled && it.isClickable }?.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) == true
                        }
                    }
                    waitUntil { ProjectionService.running }
                    openFixture()
                    waitUntil { delta(if (mode == AppCollectionMode.ACTIVITY) "ACTIVITY_ACK" else "SCREEN_ACK") >= 2 }
                    stop(); waitUntil { context.queue().depth() == 0 }
                    if (mode == AppCollectionMode.ACTIVITY) {
                        activityRequests = delta("CAPTURE_REQUESTED"); assertEquals(0, activityRequests); assertEquals(0, delta("FRAME_RECEIVED")); assertEquals(0, delta("SCREEN_QUEUED"))
                    } else { contentRequests = delta("CAPTURE_REQUESTED"); assertTrue(contentRequests >= 2); assertTrue(delta("FRAME_RECEIVED") >= 2) }
                }
            }
            File(context.filesDir, "app-policy-projection-result.json").writeText(JSONObject().put("generatedOnly", true).put("systemConsent", true)
                .put("activityScreenshotRequests", activityRequests).put("contentScreenshotRequests", contentRequests).put("displayReuseWithTwoAcknowledgements", true).put("actualModel", false).toString())
        } finally {
            stop(); WorkManager.getInstance(context).cancelUniqueWork("mote-upload").result.get(5, TimeUnit.SECONDS)
            WorkManager.getInstance(context).cancelUniqueWork("mote-upload-recovery").result.get(5, TimeUnit.SECONDS)
            shell("settings put secure enabled_accessibility_services ${if (services == "null") "''" else services}")
            shell("settings put secure accessibility_enabled ${if (accessibility == "null") "0" else accessibility}")
            restore(prefs, original)
        }
    }
    private fun openFixture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        instrumentation.runOnMainSync { context.startActivity(Intent(context, FixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)) }
        waitUntil {
            var resumed = false
            instrumentation.runOnMainSync { resumed = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).any { it is FixtureActivity } }
            resumed
        }
    }
    private fun waitUntil(condition: () -> Boolean) { val deadline = android.os.SystemClock.elapsedRealtime() + 45000; while (!condition()) { check(android.os.SystemClock.elapsedRealtime() < deadline) { "Generated fixture deadline" }; Thread.sleep(100) } }
    private fun restore(prefs: android.content.SharedPreferences, original: Map<String, *>) {
        val editor = prefs.edit().clear()
        original.forEach { (key, value) -> when (value) { is String -> editor.putString(key, value); is Boolean -> editor.putBoolean(key, value); is Int -> editor.putInt(key, value); is Long -> editor.putLong(key, value); is Float -> editor.putFloat(key, value) } }; editor.commit()
    }
}
