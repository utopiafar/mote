package dev.mote.collector

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class AppUpdateInstrumentedTest {
    @Test fun actualSignedApkRejectsWrongCertificatePackageDowngradeAndCorruption() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "update-verification-${System.nanoTime()}").apply { mkdirs() }
        try {
            val own = File(context.applicationInfo.sourceDir).copyTo(File(directory, "own.apk"))
            val current = AndroidUpdateVerifier.installed(context).longVersionCode
            val asset = AppReleaseAsset("mote.apk", "https://github.com/utopiafar/mote/releases/download/v0.5.0/mote.apk", own.length(), NsfwModelStore.sha256(own), context.packageName, current, AndroidUpdateVerifier.certificates(context).single())
            // Lower baseline only in this verifier test; production installation always reads PackageManager.
            AndroidUpdateVerifier.verify(context, own, asset, current - 1)
            assertEquals("not_newer", assertThrows(UpdateFailure::class.java) { AndroidUpdateVerifier.verify(context, own, asset) }.code)
            assertEquals("certificate", assertThrows(UpdateFailure::class.java) { AndroidUpdateVerifier.verify(context, own, asset.copy(certificateSha256 = "0".repeat(64)), current - 1) }.code)
            val other = File(instrumentation.context.applicationInfo.sourceDir)
            val wrongPackage = asset.copy(size = other.length(), sha256 = NsfwModelStore.sha256(other))
            assertEquals("package", assertThrows(UpdateFailure::class.java) { AndroidUpdateVerifier.verify(context, other, wrongPackage, current - 1) }.code)
            java.io.RandomAccessFile(own, "rw").use { it.seek(128); val value = it.readByte(); it.seek(128); it.writeByte(value.toInt() xor 1) }
            val tampered = asset.copy(sha256 = NsfwModelStore.sha256(own))
            assertEquals("apk_signature", assertThrows(UpdateFailure::class.java) { AndroidUpdateVerifier.verify(context, own, tampered, current - 1) }.code)
        } finally { directory.deleteRecursively() }
    }
    @Test fun nativeUpdatePageDoesNotGrantInstallPermissionOrTriggerNetwork() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val before = context.packageManager.canRequestPackageInstalls(); val store = AppUpdateStore(context); val operation = store.prefs.getString("operation", null)
        ActivityScenario.launch(AppUpdatesActivity::class.java).awaitUiText("检查更新").use { scenario -> scenario.onActivity { activity ->
            val labels = mutableListOf<String>()
            fun walk(view: android.view.View) { if (view is android.widget.TextView) labels += view.text.toString(); if (view is android.view.ViewGroup) repeat(view.childCount) { walk(view.getChildAt(it)) } }
            walk(activity.window.decorView); assertTrue(labels.contains("检查更新")); assertFalse(labels.contains("交给系统安装"))
        } }
        assertEquals(before, context.packageManager.canRequestPackageInstalls()); assertEquals(operation, store.prefs.getString("operation", null))
    }
    @Test fun optionalSyntheticSystemReplacementPreservesPrivateState() {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val phase = InstrumentationRegistry.getArguments().getString("updateFixturePhase")
        assumeTrue("Explicit dedicated-emulator update fixture phases only", phase in setOf("prepare", "cancel", "stage", "verify"))
        require(BuildConfig.MOTE_PROFILE == "dev" && context.packageName == "dev.mote.collector.dev")
        require(android.os.Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:") || android.os.Build.FINGERPRINT.contains("generic"))
        val store = AppUpdateStore(context); val beforeFile = File(context.filesDir, "update-retention-before.json")
        val model = File(context.noBackupFilesDir, "models/update-fixture-sentinel.bin")
        fun snapshot() = JSONObject().put("settings", SourceRules.hash(Settings(context).read().toString())).put("device", SourceRules.hash(Settings(context).deviceId))
            .put("queue", SourceRules.hash(context.queue().peek()!!.toString())).put("draft", SourceRules.hash(QuickNotes.draft(context).read()!!.text)).put("model", NsfwModelStore.sha256(model))
        when (phase) {
            "prepare" -> {
                require(AndroidUpdateVerifier.installed(context).longVersionCode == 6L)
                val settings = Settings(context); require(!settings.enabled && settings.read().token.isEmpty() && context.queue().depth() == 0 && QuickNotes.draft(context).read()?.text.isNullOrEmpty())
                val previous = settings.read(); val restore = JSONObject().put("server", previous.server).put("deviceName", previous.deviceName)
                File(context.filesDir, "update-restore.json").writeText(restore.toString())
                settings.save(previous.copy(server = "https://127.0.0.1:1", token = "synthetic-update-retention-token-only-000000", deviceName = "generated-update-retention"))
                QuickNotes.save(context, "合成待上传笔记 👩🏽‍💻\n正文仅用于升级保留验证", "合成心情") { }
                QuickNotes.draft(context).update("未提交合成草稿 e\u0301", "")
                model.parentFile!!.mkdirs(); model.writeText("Generated model-directory sentinel; not model weights.")
                val raw = File(context.filesDir, "update-fixture-manifest.json").readBytes(); val release = AppReleaseVerifier.verify(raw, store.key(), UpdateConfig()); val asset = release.asset(context.packageName)!!
                require(asset.versionCode == 7L)
                val operation = UUID.randomUUID().toString(); store.save(UpdateConfig()); store.prefs.edit().putString("operation", operation).commit(); store.locked { store.publish(raw, release, asset, operation) }
                File(context.filesDir, "update-fixture.apk").copyTo(store.apk(asset), overwrite = true); AndroidUpdateVerifier.verify(context, store.apk(asset), asset)
                store.state("ready"); beforeFile.writeText(snapshot().toString())
            }
            "cancel" -> {
                require(beforeFile.exists() && context.packageManager.canRequestPackageInstalls())
                AppUpdateInstaller.cancelSession(context)
                repeat(100) { if (context.packageManager.packageInstaller.mySessions.isNotEmpty()) Thread.sleep(20) }
                val sessionsBefore = context.packageManager.packageInstaller.mySessions.map { it.sessionId }.toSet()
                val queuedTicket = AppUpdateInstaller.request(context)
                assertEquals("install_pending", assertThrows(UpdateFailure::class.java) { AppUpdateInstaller.request(context) }.code)
                AppUpdateInstaller.cancelSession(context)
                assertEquals("cancelled", assertThrows(UpdateFailure::class.java) { AppUpdateInstaller.stage(context, queuedTicket) }.code)
                val verifying = CountDownLatch(1); val resume = CountDownLatch(1); val finished = CountDownLatch(1)
                val failure = AtomicReference<Throwable>()
                val ticket = AppUpdateInstaller.request(context)
                val thread = Thread {
                    try { AppUpdateInstaller.stage(context, ticket) { verifying.countDown(); check(resume.await(15, TimeUnit.SECONDS)) } }
                    catch (e: Throwable) { failure.set(e) } finally { finished.countDown() }
                }.apply { start() }
                try {
                    assertTrue("Real APK verification must finish before cancellation barrier", verifying.await(15, TimeUnit.SECONDS))
                    val start = android.os.SystemClock.elapsedRealtime(); AppUpdateInstaller.cancelSession(context)
                    assertTrue("Cancel must not wait for the APK file lock", android.os.SystemClock.elapsedRealtime() - start < 1000)
                } finally { resume.countDown() }
                assertTrue(finished.await(15, TimeUnit.SECONDS)); thread.join(1000)
                assertEquals("cancelled", (failure.get() as? UpdateFailure)?.code)
                assertEquals(sessionsBefore, context.packageManager.packageInstaller.mySessions.map { it.sessionId }.toSet())
                assertEquals("cancelled", store.prefs.getString("state", ""))
                assertFalse(store.prefs.getBoolean("installRequestActive", false))
                File(context.filesDir, "update-cancel-result.json").writeText(JSONObject().put("queuedRequestCancelled", true).put("afterVerificationCancelled", true).put("noSessionCreated", true).toString())
            }
            "stage" -> {
                require(beforeFile.exists() && context.packageManager.canRequestPackageInstalls())
                instrumentation.startActivitySync(Intent(context, AppUpdatesActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                instrumentation.waitForIdleSync(); val id = AppUpdateInstaller.stage(context, AppUpdateInstaller.request(context)); assertTrue(id >= 0)
                repeat(100) { if (store.prefs.getString("state", "") != "awaiting_user") Thread.sleep(50) }
                assertEquals("awaiting_user", store.prefs.getString("state", ""))
                Thread.sleep(1000) // Keep the fixture Activity foreground until the system confirmation launches.
                File(context.filesDir, "update-stage-result.json").writeText(JSONObject().put("sessionId", id).put("systemUserActionRequired", true).toString())
            }
            "verify" -> {
                assertEquals(7L, AndroidUpdateVerifier.installed(context).longVersionCode)
                assertEquals(JSONObject(beforeFile.readText()).toString(), snapshot().toString())
                assertEquals(1, context.queue().depth()); assertFalse(context.queue().peek()!!.has("imageBase64")); AppUpdateInstaller.reconcile(context)
                assertEquals("installed", store.prefs.getString("state", ""))
                File(context.filesDir, "update-retention-result.json").writeText(JSONObject().put("upgradedVersionCode", 7).put("settingsPreserved", true).put("deviceIdPreserved", true).put("queuePreserved", true).put("draftPreserved", true).put("modelDirectoryPreserved", true).toString())
                val restore = JSONObject(File(context.filesDir, "update-restore.json").readText())
                context.queue().acknowledge(context.queue().peek()!!.getString("id")); QuickNotes.draft(context).clear(); model.delete()
                context.getSharedPreferences("mote", 0).edit().putString("server", restore.getString("server")).putString("deviceName", restore.getString("deviceName")).remove("token").commit()
                File(context.filesDir, "update-fixture.apk").delete(); File(context.filesDir, "update-fixture-manifest.json").delete()
            }
        }
    }
}
