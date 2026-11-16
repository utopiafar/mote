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
    /** Accept only the local generated format preview, before exercising system consent. */
    private fun acceptGeneratedStartPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        require(instrumentation.targetContext.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.contains("emu64a"))
        fun views(root: android.view.View): List<android.view.View> = buildList {
            add(root); if (root is android.view.ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
        }
        instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
            android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).filterIsInstance<android.widget.TextView>()
                .firstOrNull { it.isShown && it.isClickable && it.text.toString() == MoteI18n.text("按此范围开始") }?.performClick()
        }
    }
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
            val config = settings.read().copy(server = "https://127.0.0.1:1", token = "generated-policy-test-token-only-123456789", mode = "projection", uiPageMode = "screen_only",
                appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
            settings.save(config); settings.enabled = true; assertEquals("accessibility", config.effectiveMode())
            val windows = WindowSnapshot(setOf("com.example.generated"), "com.example.generated", true)
            pipeline = CapturePipeline(context) { }
            assertFalse(pipeline.canCapture(config, windows)); assertTrue(pipeline.canCollect(config, windows, AppCollectionMode.ACTIVITY))
            pipeline.submitActivity(windows, config); waitUntil { context.queue().pendingSync().count == 1 && pipeline?.isBusy() == false }
            val first = context.queue().peek()!!; val preserved = first.toString()
            assertEquals("activity", first.getString("source")); assertFalse(first.has("ocrText")); assertFalse(first.has("imageBase64"))
            assertEquals(setOf("intervalMs"), first.getJSONObject("metadata").getJSONObject("capture").keys().asSequence().toSet())
            settings.enabled = false; pipeline.close(); pipeline = null
            val without = config.copy(metadataEnabled = false); settings.save(without); settings.enabled = true
            pipeline = CapturePipeline(context) { }; pipeline.submitActivity(windows, without)
            waitUntil { context.queue().pendingSync().count == 2 && pipeline?.isBusy() == false }
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
    @Test fun expiredNodeSampleSkipsEphemeralOcrWhileCaptureAuthorizationRemainsCurrent() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName=="dev.mote.collector.dev"&&android.os.Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);require(!settings.enabled&&context.queue().depth()==0&&!CaptureAccessibilityService.connected&&!ProjectionService.running)
        val prefs=context.getSharedPreferences("mote",0);val original=prefs.all.toMap()
        val numeric=context.getSharedPreferences("numeric_diagnostics",0);val originalNumeric=numeric.all.toMap()
        var pipeline:CapturePipeline?=null
        val bitmap=android.graphics.Bitmap.createBitmap(240,120,android.graphics.Bitmap.Config.ARGB_8888).apply {
            eraseColor(android.graphics.Color.WHITE)
            android.graphics.Canvas(this).drawRect(0f,0f,120f,120f,android.graphics.Paint().apply {color=android.graphics.Color.BLACK})
        }
        try {
            val config=settings.read().copy(server="",token="",syncMode="manual",mode="accessibility",screenCollectionEnabled=true,localContentOcr=true,
                appCollectionRules=AppCollectionRules.fromLines(AppCollectionMode.STRUCTURED,"").json(),excludedPackages="",masks="",diagnosticsEnabled=true,chargingOnly=false,batteryPauseBelowPct=0,uploadGate=UploadGateConfig(false))
            settings.save(config);settings.enabled=true
            val windows=WindowSnapshot(setOf("generated.context"),"generated.context",true)
            val current=java.util.concurrent.atomic.AtomicBoolean(true)
            val sample=CaptureObservation(nodes=JSONObject().put("ocrSafe",true).put("ocrViewport",JSONObject().put("x",0).put("y",0).put("width",240).put("height",120)),contentCurrent=current::get)
            val before=JSONObject(Diagnostics(context).export()).getJSONObject("totals").getLong("ocrCalls")
            pipeline=CapturePipeline(context){}
            pipeline.submit(bitmap,windows,config,sample=sample,isCurrent={current.set(false);true})
            waitUntil {pipeline?.isBusy()==false&&ConnectionGuard.processing.get()==0}
            assertFalse(current.get());assertEquals(before,JSONObject(Diagnostics(context).export()).getJSONObject("totals").getLong("ocrCalls"))
            assertEquals(0,context.queue().depth());assertEquals(0,context.queue().inventory().images)
            assertTrue(bitmap.isRecycled)
        } finally {
            settings.enabled=false;pipeline?.close();if(!bitmap.isRecycled)bitmap.recycle()
            restore(prefs,original);restore(numeric,originalNumeric)
        }
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
        val avd = shell("getprop ro.boot.qemu.avd_name"); require(avd in setOf("mote_fixture_api35", "mote_fixture_api37", "mote_release_060"))
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
            val config = settings.read().copy(server = server, token = token, deviceName = "合成 Android 分级采集", intervalSeconds = 5, wifiOnly = false, debugHttp = true, syncMode = "realtime",
                mode = "projection", uiPageMode = "screen_only", appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
            settings.save(config)
            assertEquals("accessibility", config.effectiveMode())
            androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity -> MainActivity::class.java.getDeclaredMethod("startCapture").apply { isAccessible = true }.invoke(activity) }
                acceptGeneratedStartPreview()
                waitUntil { settings.enabled }; assertFalse(ProjectionService.running)
                openFixture()
                waitUntil { count("ACTIVITY_ACK") >= 2 }; stop()
                assertFalse(ProjectionService.running)
            }
            openFixture()
            assertEquals(0, count("CAPTURE_REQUESTED")); assertEquals(0, count("FRAME_RECEIVED")); assertEquals(0, count("SCREEN_QUEUED"))
            val activity = records("activity"); assertTrue(activity.length() >= 1)
            assertTrue((0 until activity.length()).sumOf { activity.getJSONObject(it).optJSONObject("stateSeries")?.optJSONArray("samples")?.length() ?: 1 } >= 2)
            for (i in 0 until activity.length()) {
                val row = activity.getJSONObject(i); assertEquals("", row.getString("ocrText")); assertEquals("", row.getString("windowTitle")); assertTrue(row.isNull("blobHash"))
                assertEquals("activity", row.getJSONObject("privacy").getString("collection"))
                assertTrue(row.getJSONObject("metadata").getJSONObject("captureObservation").getJSONObject("selected").getBoolean("duration"))
            }
            settings.save(config.copy(excludedPackages = context.packageName + ".test")); settings.enabled = true
            val saved = count("ACTIVITY_QUEUED"); Thread.sleep(5500); stop()
            assertEquals(saved, count("ACTIVITY_QUEUED")); assertEquals(0, count("CAPTURE_REQUESTED"))
            // Explicit fixture setting disables image review only for generated screen/OCR transport validation.
            val content = config.copy(mode = "accessibility", appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.OFF, "${context.packageName}.test=content\ncom.android.systemui=content").json())
            settings.save(content); settings.enabled = true; waitUntil { count("SCREEN_ACK") >= 1 }; stop(); waitUntil { context.queue().pendingSync().count == 0 }
            val screen = records("screen").getJSONObject(0); assertEquals("content", screen.getJSONObject("privacy").getString("collection"))
            assertEquals("", screen.getString("ocrText")); assertTrue(screen.getJSONObject("metadata").getJSONObject("capture").getInt("width") > 0)
            val authority = context.packageName + ".source-fixtures"
            context.getSharedPreferences("source-fixture", 0).edit().clear().putString("mode", "full").commit()
            val source = LocalSource(name = "Android 合成文件元数据", kind = "local-files", uri = "content://$authority/tree/root", tree = true)
            val temporary = File(context.noBackupFilesDir, "policy-source-fixture")
            try {
                val local = LocalSourceStore(temporary, context.secretBox()); local.save(source); local.selectTarget(source.id, "fixture")
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
                excludedPackages = "", appCollectionRules = AppCollectionRules.CONTENT_DEFAULT)
            settings.save(c); settings.enabled = true; pipeline = CapturePipeline(context) { }
            val firstSample=CaptureObservation(at="2026-09-14T00:00:00Z",elapsed=0)
            pipeline.recordDuration(windows,c,firstSample)
            pipeline.submit(generated(),windows,c,firstSample.at,firstSample.elapsed,firstSample)
            waitUntil {context.queue().pendingSync().count==2&&pipeline?.isBusy()==false}
            val first=context.queue().syncIds(limit=10).mapNotNull {context.queue().capture(it)}
            assertTrue(first.all {it.getLong("durationMs")==0L})
            first.forEach {context.queue().acknowledge(it.getString("id"))}
            Thread.sleep(250) // Processing completion is deliberately independent from the fifteen-second observation interval.
            val nextSample=CaptureObservation(at="2026-09-14T00:00:15Z",elapsed=15000)
            pipeline.recordDuration(windows,c,nextSample)
            pipeline.submit(generated(),windows,c,nextSample.at,nextSample.elapsed,nextSample)
            waitUntil {context.queue().pendingSync().count==2&&pipeline?.isBusy()==false}
            val next=context.queue().syncIds(limit=10).mapNotNull {context.queue().capture(it)}
            val activity=next.single {it.getString("source")=="activity"};val screen=next.single {it.getString("source")=="screen"}
            assertEquals(15000,activity.getLong("durationMs"));assertEquals(0,screen.getLong("durationMs"))
            assertEquals("2026-09-14T00:00:15Z",screen.getString("capturedAt"))
            assertEquals(activity.getJSONObject("metadata").getJSONObject("captureObservation").getString("id"),screen.getJSONObject("metadata").getJSONObject("captureObservation").getString("id"))
            assertEquals("",screen.getString("ocrText"));assertEquals("disabled",screen.getJSONObject("ocr").getString("status"));assertNotNull(context.queue().image(screen.getString("id")))
            next.forEach {context.queue().acknowledge(it.getString("id"))}
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
        require(shell("getprop ro.boot.qemu.avd_name") in setOf("mote_fixture_api35", "mote_fixture_api37", "mote_release_060"))
        require(context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
        val settings = Settings(context); require(!settings.enabled && context.queue().depth() == 0)
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        val services = shell("settings get secure enabled_accessibility_services"); val accessibility = shell("settings get secure accessibility_enabled")
        fun stop() { settings.enabled = false; context.stopService(Intent(context, ProjectionService::class.java)); waitUntil { !ProjectionService.running && ConnectionGuard.processing.get() == 0 } }
        try {
            shell("settings put secure enabled_accessibility_services ${context.packageName}/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1"); waitUntil { CaptureAccessibilityService.connected }
            val base = settings.read().copy(server = fixture.getString("serverUrl"), token = fixture.getString("token"), deviceName = "合成 Android 投屏分级", intervalSeconds = 5,
                wifiOnly = false, debugHttp = true, syncMode = "realtime", mode = "projection", uiPageMode = "screen_only", excludedPackages = "")
            var activityRequests = -1L; var contentRequests = -1L
            for (mode in listOf(AppCollectionMode.ACTIVITY, AppCollectionMode.CONTENT)) {
                val c = base.copy(appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.OFF, "${context.packageName}.test=${mode.wire}\ncom.android.systemui=content").json())
                settings.save(c)
                val before = Operations.ledger(context).read().getJSONObject("counts")
                fun delta(key: String) = Operations.ledger(context).read().getJSONObject("counts").getLong(key) - before.getLong(key)
                androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                    scenario.onActivity { activity -> MainActivity::class.java.getDeclaredMethod("startCapture").apply { isAccessible = true }.invoke(activity) }
                acceptGeneratedStartPreview()
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
                    stop(); waitUntil { context.queue().pendingSync().count == 0 }
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
        instrumentation.runOnMainSync { context.startActivity(Intent().setComponent(android.content.ComponentName(context.packageName + ".test", ExternalFixtureActivity::class.java.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        waitUntil { instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).rootInActiveWindow?.packageName?.toString() == context.packageName + ".test" }

    }
    private fun waitUntil(condition: () -> Boolean) { val deadline = android.os.SystemClock.elapsedRealtime() + 45000; while (!condition()) { check(android.os.SystemClock.elapsedRealtime() < deadline) { "Generated fixture deadline" }; Thread.sleep(100) } }
    private fun restore(prefs: android.content.SharedPreferences, original: Map<String, *>) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.queue().dedupeIds().forEach { context.queue().removeGeneratedRecord(it) }
        val editor = prefs.edit().clear()
        original.forEach { (key, value) -> when (value) { is String -> editor.putString(key, value); is Boolean -> editor.putBoolean(key, value); is Int -> editor.putInt(key, value); is Long -> editor.putLong(key, value); is Float -> editor.putFloat(key, value) } }; editor.commit()
    }
}
