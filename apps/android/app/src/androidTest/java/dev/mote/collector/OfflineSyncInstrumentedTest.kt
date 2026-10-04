package dev.mote.collector

import android.content.Context
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import androidx.work.WorkInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ExistingWorkPolicy
import androidx.work.BackoffPolicy
import androidx.work.workDataOf
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.ByteArrayInputStream
import java.util.zip.GZIPInputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Own loopback HTTP fixture and generated records only. No screen capture or model is started. */
@RunWith(AndroidJUnit4::class)
class OfflineSyncInstrumentedTest {
    private val token = "generated-android-local-sync-token-1234567890"
    private fun <T> changeWhenIdle(context: Context, server: String, bindLocal: Boolean = false, action: () -> T): T {
        val deadline = android.os.SystemClock.elapsedRealtime() + 45000
        while (true) {
            try { return ConnectionGuard.change(context, server, bindLocal, action) }
            catch (error: ConnectionFailure) {
                // Startup/background readers may briefly hold the lock; authorization failures remain exact.
                if (error.category != "busy" || android.os.SystemClock.elapsedRealtime() >= deadline) throw error
                Thread.sleep(50)
            }
        }
    }
    private fun fixture(test: (Context, Settings) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val settings = Settings(context)
        require(!settings.enabled && context.queue().depth() == 0 && QuickNotes.draft(context).read().text.isEmpty() && context.localSources().sources().isEmpty())
        val prefs = context.getSharedPreferences("mote", 0); val original = prefs.all.toMap()
        fun cancel() { listOf("mote-heartbeat", "mote-heartbeat-now", "mote-upload", "mote-upload-timer", "mote-upload-recovery", "mote-source-upload", "mote-source-scan", "mote-source-periodic").forEach {
            WorkManager.getInstance(context).cancelUniqueWork(it).result.get(5, TimeUnit.SECONDS)
        } }
        try {
            cancel(); settings.save(settings.read().copy(server = "", token = "", deviceName = "Generated Android fixture", syncMode = "manual", uploadedRetentionDays = 0))
            test(context, settings)
        } finally {
            cancel(); waitUntil { !ConnectionGuard.changing() && ConnectionGuard.processing.get() == 0 }
            val pending = context.queue().pendingPage(0, 60).getJSONArray("items")
            for (i in 0 until pending.length()) context.queue().acknowledge(pending.getJSONObject(i).getString("id"))
            context.localSources().sources().forEach { context.localSources().remove(it.id) }
            QuickNotes.draft(context).clear()
            val edit = prefs.edit().clear()
            original.forEach { (key, value) -> when (value) { is String -> edit.putString(key, value); is Boolean -> edit.putBoolean(key, value); is Int -> edit.putInt(key, value); is Long -> edit.putLong(key, value); is Float -> edit.putFloat(key, value) } }; edit.commit()
        }
    }

    @Test fun generatedActivityCaptureIsLocalWithoutEndpointOrModel() = fixture { context, settings ->
        val config = settings.read().copy(metadataEnabled = false, appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "").json())
        settings.save(config); settings.enabled = true
        val pipeline = CapturePipeline(context)
        try {
            val windows = WindowSnapshot(setOf("dev.mote.generated"), "dev.mote.generated", true)
            assertTrue(pipeline.canCollect(config, windows, AppCollectionMode.ACTIVITY))
            pipeline.submitActivity(windows, config)
            waitUntil { context.queue().depth() == 1 && !pipeline.isBusy() }
            val record = context.queue().peek()!!
            assertEquals("activity", record.getString("source")); assertFalse(record.has("imageBase64")); assertFalse(record.has("ocrText"))
            assertEquals("unconfigured", settings.syncState())
        } finally { settings.enabled = false; pipeline.close() }
    }
    @Test fun firstBindingRequiresConfirmationAndDisconnectCannotRedirectBoundRecords() = fixture { context, settings ->
        QuickNotes.save(context, "Generated unbound queue", "")
        val local = settings.read(); val origin = "https://first.generated.invalid"
        QuickNotes.draft(context).update("Generated prepared note", "")
        val prepared = QuickNotes.draft(context).prepare("") { draft -> JSONObject().put("id", UUID.randomUUID().toString()).put("source", "note")
            .put("ocrText", draft.text).put("capturedAt", Instant.now().toString()).put("privacy", JSONObject().put("excluded", false)) }.prepared!!
        val before = context.queue().peek()!!.toString()
        waitUntil { ConnectionGuard.processing.get() == 0 }
        assertEquals("local_confirmation", assertThrows(ConnectionFailure::class.java) { changeWhenIdle(context, origin) { error("No implicit binding") } }.category)
        changeWhenIdle(context, origin, bindLocal = true) { settings.save(local.copy(server = origin, token = token)) }
        assertEquals(origin, settings.dataOrigin()); assertEquals(before, context.queue().peek()!!.toString())
        assertEquals(prepared.getString("id"), QuickNotes.save(context, "Generated prepared note", ""))
        changeWhenIdle(context, "") { settings.save(settings.read().copy(server = "", token = "")) }
        assertEquals(origin, settings.dataOrigin())
        assertEquals("pending", assertThrows(ConnectionFailure::class.java) { changeWhenIdle(context, "https://other.generated.invalid", bindLocal = true) { error("Never redirect") } }.category)
        changeWhenIdle(context, origin) { settings.save(settings.read().copy(server = origin, token = token + "-renewed")) }
        assertEquals(2, context.queue().depth())
    }
    @Test fun unboundSourceRevisionsParticipateInTheSameOriginAndBatchProtection() = fixture { context, settings ->
        val source = LocalSource(name = "Generated offline source", kind = "local-files", uri = "content://generated/source")
        val store = context.localSources(); store.save(source)
        store.scan(source, SourceScan(listOf(JSONObject().put("externalId", "generated.txt").put("title", "Generated").put("text", "Generated source body")
            .put("kind", "file").put("layer", "snapshot").put("observedAt", Instant.now().toString())), true, Instant.now().toString()))
        assertEquals(1, SyncSchedule.pending(context).count); assertEquals(1, SyncSchedule.pending(context).pendingUpdates); assertNotNull(SyncSchedule.pending(context).oldestAt)
        assertEquals("local_confirmation", assertThrows(ConnectionFailure::class.java) { changeWhenIdle(context, "https://first.generated.invalid") { error("No implicit source binding") } }.category)
        changeWhenIdle(context, "https://first.generated.invalid", true) { settings.save(settings.read().copy(server = "https://first.generated.invalid", token = token)) }
        assertEquals("pending", assertThrows(ConnectionFailure::class.java) { changeWhenIdle(context, "https://other.generated.invalid", true) { error("Never redirect source data") } }.category)
        assertEquals(1, store.pendingSync().count)
    }
    @Test fun manualDoesNotSendHeartbeatOrNotesUntilExplicitSync() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config)
            QuickNotes.save(context, "Generated manual note", "")
            UploadWorker.heartbeat(context, config); SourceWork.upload(context); UploadWorker.schedule(context, config)
            Thread.sleep(750)
            assertEquals(0, archive.requests.get()); assertEquals(1, context.queue().depth())
            UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 0 && archive.notes.get() == 1 && settings.syncState() == "idle" }
            waitUntil { archive.lastSync?.optString("state") == "idle" }
            assertEquals(0, archive.lastSync!!.getInt("pendingRecords"))
            assertTrue(archive.heartbeats.get() > 0); assertNotNull(settings.lastUploadAt())
        }
    }
    @Test fun batchFlushesAtThresholdAndOldestAgeWithoutStrandingSmallQueues() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "batch", syncBatchSize = 2)
            settings.save(config)
            QuickNotes.save(context, "Generated batch one", "")
            Thread.sleep(500); assertEquals(0, archive.notes.get())
            QuickNotes.save(context, "Generated batch two", "")
            waitUntil { context.queue().depth() == 0 && archive.notes.get() == 2 && settings.syncState() == "idle" }
            val id = QuickNotes.save(context, "Generated overdue single", "")
            assertTrue(File(QueueStorage(context).current().path, "$id.event").setLastModified(System.currentTimeMillis() - 16 * 60_000))
            UploadWorker.schedule(context, config)
            waitUntil { context.queue().depth() == 0 && archive.notes.get() == 3 && settings.syncState() == "idle" }
        }
    }
    @Test fun intervalHoldsNewRecordsUntilDueAndThenFlushes() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "interval", syncIntervalMinutes = 15)
            settings.save(config); settings.syncDispatched(System.currentTimeMillis())
            QuickNotes.save(context, "Generated timed note", "")
            Thread.sleep(500); assertEquals(0, archive.notes.get())
            settings.syncDispatched(System.currentTimeMillis() - 16 * 60_000)
            UploadWorker.schedule(context, config)
            waitUntil { context.queue().depth() == 0 && archive.notes.get() == 1 && settings.syncState() == "idle" }
        }
    }
    @Test fun manualWrongAckAndDisconnectKeepRecordWithoutAutomaticRetry() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config); val id = QuickNotes.save(context, "Generated manual failure", "")
            for (fault in listOf("wrongNoteAck", "dropNote")) {
                archive.fault = fault; val attempts = archive.notes.get(); UploadWorker.schedule(context, config, true)
                waitUntil { archive.notes.get() > attempts && WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().any { it.state == WorkInfo.State.FAILED } }
                assertEquals(id, context.queue().peek()!!.getString("id")); assertEquals("error", settings.syncState())
                val requests = archive.requests.get()
                UploadWorker.schedule(context, config); SourceWork.upload(context); Thread.sleep(500)
                assertEquals(requests, archive.requests.get())
                assertTrue(WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().all { it.state.isFinished })
            }
            archive.fault = ""; UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 0 && archive.lastSync?.optString("state") == "idle" }
        }
    }
    @Test fun manualSourceAckFailureDoesNotScheduleRetry() = fixture { context, settings ->
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.grantRuntimePermission(context.packageName, android.Manifest.permission.READ_CALENDAR)
        try { LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config)
            val source = LocalSource(name = "Generated source ACK failure", kind = "local-calendar", calendarId = 77)
            val store = context.localSources(); store.save(source)
            store.scan(source, SourceScan(listOf(JSONObject().put("externalId", "generated:77").put("title", "Generated").put("text", "Generated calendar fixture")
                .put("kind", "calendar").put("layer", "snapshot").put("observedAt", Instant.now().toString())), true, Instant.now().toString()))
            archive.fault = "wrongSourceAck"; SourceWork.enqueueUpload(context, config, true)
            waitUntil { WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-source-upload").get().any { it.state == WorkInfo.State.FAILED } }
            assertEquals(1, store.pendingSync().count); val requests = archive.requests.get()
            SourceWork.upload(context); Thread.sleep(500); assertEquals(requests, archive.requests.get())
            assertTrue(WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-source-upload").get().all { it.state.isFinished })
            archive.fault = ""; SourceWork.enqueueUpload(context, config, true)
            waitUntil { store.pendingSync().count == 0 && archive.lastSync?.optString("state") == "idle" }
            assertEquals(0, archive.lastSync!!.getInt("pendingRecords"))
        } } finally { /* Fixture-only calendar permission is discarded with the read-only emulator. No provider is queried. */ }
    }
    @Test fun exactTwentyFiveRecordChunkReportsIdleBeforeFinalHeartbeat() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config)
            repeat(25) { QuickNotes.save(context, "Generated chunk $it", "") }
            UploadWorker.schedule(context, config, true)
            waitUntil { archive.notes.get() == 25 && context.queue().depth() == 0 && archive.lastSync?.optString("state") == "idle" }
            assertEquals(0, archive.lastSync!!.getInt("pendingRecords"))
            assertEquals("25 notes use one transport request", 1, archive.batches.get())
        }
    }
    @Test fun unsupportedV2EndpointKeepsPendingWithoutLegacyFallback() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config); archive.fault = "legacy"
            repeat(2) { QuickNotes.save(context, "Generated legacy $it", "") }
            UploadWorker.schedule(context, config, true)
            val manager = WorkManager.getInstance(context)
            waitUntil { settings.syncState() == "error" && manager.getWorkInfosForUniqueWork("mote-upload").get().lastOrNull()?.state == WorkInfo.State.FAILED }
            assertEquals(2, context.queue().depth()); assertEquals(0, archive.notes.get()); assertEquals(1, archive.batches.get())
            Thread.sleep(300)
            assertEquals("Manual failure must not dispatch a legacy route or retry automatically", 1, archive.requests.get())
            archive.fault = ""
            UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 0 && settings.syncState() == "idle" }
            assertEquals(2, archive.notes.get()); assertEquals(2, archive.batches.get())
        }
    }
    @Test fun partialBatchAcknowledgementKeepsOnlyUnconfirmedRecords() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config); archive.fault = "partial"
            repeat(2) { QuickNotes.save(context, "Generated partial $it", "") }
            UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 1 && settings.syncState() == "error" &&
                WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().any { it.state == WorkInfo.State.FAILED } }
            val retained = context.queue().peek()!!.getString("id")
            assertTrue(WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().any { it.state == WorkInfo.State.FAILED })
            archive.fault = ""; UploadWorker.schedule(context, config, true)
            waitUntil { context.queue().depth() == 0 }
            assertNotNull(retained); assertEquals(2, archive.batches.get())
        }
    }
    @Test fun emptyRealtimeQueueNeverStartsDataUploadSession() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime", diagnosticsEnabled = true)
            settings.save(config)
            val counters = context.getSharedPreferences("numeric_diagnostics", 0)
            val before = counters.getLong("uploadSessions", 0)
            repeat(20) { UploadWorker.heartbeat(context, config); UploadWorker.schedule(context, config) }
            waitUntil { archive.heartbeats.get() >= 1 }
            Thread.sleep(300)
            assertEquals(1, archive.heartbeats.get()); assertEquals(0, archive.notes.get())
            assertEquals(before, counters.getLong("uploadSessions", 0))
        }
    }
    @Test fun realtimeSendsNewNotesWithoutAnExplicitSyncRequest() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime")
            settings.save(config)
            repeat(3) { index ->
                QuickNotes.save(context, "Generated realtime note $index", "")
                waitUntil(detail = { "index=$index pending=${context.queue().depth()} received=${archive.notes.get()} batches=${archive.batches.get()} work=${WorkManager.getInstance(context).getWorkInfosForUniqueWork("mote-upload").get().map { it.state }}" }) { context.queue().depth() == 0 && archive.notes.get() == index + 1 && settings.syncState() == "idle" }
            }
            assertEquals(3, archive.notes.get())
            assertNotNull(settings.lastUploadAt())
        }
    }
    @Test fun realtimeEnqueuesOneSuccessorWhilePreviousUploadIsFinishing() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime")
            settings.save(config)
            UploadWorker.schedule(context, config)
            val manager = WorkManager.getInstance(context)
            // Isolate the one-time chain; periodic recovery must not hide a lost wake.
            for (name in listOf("mote-upload-recovery", "mote-heartbeat")) manager.cancelUniqueWork(name).result.get(5, TimeUnit.SECONDS)
            HeldUploadCompletionWorker.reset()
            manager.enqueueUniqueWork("mote-upload", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<HeldUploadCompletionWorker>().build()).result.get(5, TimeUnit.SECONDS)
            try {
                assertTrue("Generated predecessor must be running", HeldUploadCompletionWorker.entered.await(5, TimeUnit.SECONDS))
                QuickNotes.save(context, "Generated note in upload completion window", "")
                val producers = Executors.newFixedThreadPool(4)
                try {
                    val start = CountDownLatch(1)
                    val tasks = (0 until 12).map { producers.submit { start.await(); UploadWorker.schedule(context, config) } }
                    start.countDown(); tasks.forEach { it.get(5, TimeUnit.SECONDS) }
                    // Actual UI calls still dispatch asynchronously without waiting on WorkManager.
                    InstrumentationRegistry.getInstrumentation().runOnMainSync { UploadWorker.schedule(context, config) }
                } finally { producers.shutdownNow() }
                val unfinished = manager.getWorkInfosForUniqueWork("mote-upload").get().filter { !it.state.isFinished }
                assertEquals("One running predecessor must retain exactly one waiting upload", 2, unfinished.size)
                assertEquals(1, unfinished.count { it.state == WorkInfo.State.BLOCKED })
            } finally { HeldUploadCompletionWorker.release.countDown() }
            waitUntil { context.queue().depth() == 0 && archive.notes.get() == 1 }
        }
    }
    @Test fun failedOrCancelledPredecessorDoesNotSilentlyRunItsDependentUpload() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime")
            settings.save(config); UploadWorker.schedule(context, config)
            val manager = WorkManager.getInstance(context)
            for (name in listOf("mote-upload-recovery", "mote-heartbeat")) manager.cancelUniqueWork(name).result.get(5, TimeUnit.SECONDS)
            for (cancel in listOf(false, true)) {
                HeldUploadCompletionWorker.reset()
                val predecessor = OneTimeWorkRequestBuilder<HeldUploadCompletionWorker>().setInputData(workDataOf("fail" to !cancel)).build()
                manager.enqueueUniqueWork("mote-upload", ExistingWorkPolicy.REPLACE, predecessor).result.get(5, TimeUnit.SECONDS)
                try {
                    assertTrue(HeldUploadCompletionWorker.entered.await(5, TimeUnit.SECONDS))
                    QuickNotes.save(context, "Generated dependent upload cancel=$cancel", "")
                    assertEquals(2, manager.getWorkInfosForUniqueWork("mote-upload").get().count { !it.state.isFinished })
                    if (cancel) manager.cancelWorkById(predecessor.id).result.get(5, TimeUnit.SECONDS)
                } finally { HeldUploadCompletionWorker.release.countDown() }
                waitUntil { manager.getWorkInfosForUniqueWork("mote-upload").get().all { it.state.isFinished } }
                val expected = if (cancel) WorkInfo.State.CANCELLED else WorkInfo.State.FAILED
                assertTrue(manager.getWorkInfosForUniqueWork("mote-upload").get().all { it.state == expected })
                assertEquals(1, context.queue().depth()); val before = archive.notes.get()
                // A new authorized scheduling event can replace a failed/cancelled chain.
                UploadWorker.schedule(context, config)
                waitUntil { context.queue().depth() == 0 && archive.notes.get() == before + 1 }
            }
        }
    }
    @Test fun waitingUploadUsesCurrentManualOrDisconnectedConfiguration() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val manager = WorkManager.getInstance(context)
            for (manual in listOf(true, false)) {
                val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime")
                settings.save(config); UploadWorker.schedule(context, config)
                for (name in listOf("mote-upload-recovery", "mote-heartbeat")) manager.cancelUniqueWork(name).result.get(5, TimeUnit.SECONDS)
                HeldUploadCompletionWorker.reset()
                manager.enqueueUniqueWork("mote-upload", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<HeldUploadCompletionWorker>().build()).result.get(5, TimeUnit.SECONDS)
                try {
                    assertTrue(HeldUploadCompletionWorker.entered.await(5, TimeUnit.SECONDS))
                    QuickNotes.save(context, "Generated configuration fence manual=$manual", "")
                    assertEquals(2, manager.getWorkInfosForUniqueWork("mote-upload").get().count { !it.state.isFinished })
                    assertThrows(ConnectionFailure::class.java) { ConnectionGuard.change(context, "https://another-generated.invalid") { error("Pending records must not move to a different node") } }
                    assertEquals(archive.url, settings.read().server)
                    settings.save(if (manual) config.copy(syncMode = "manual") else config.copy(server = "", token = ""))
                } finally { HeldUploadCompletionWorker.release.countDown() }
                waitUntil { manager.getWorkInfosForUniqueWork("mote-upload").get().all { it.state.isFinished } }
                assertEquals(0, archive.notes.get()); assertEquals(1, context.queue().depth())
                context.queue().acknowledge(context.queue().peek()!!.getString("id"))
            }
        }
    }
    @Test fun repeatedRealtimeSchedulingKeepsAnExistingRetryBackoff() = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "realtime")
            settings.save(config); UploadWorker.schedule(context, config)
            val manager = WorkManager.getInstance(context)
            for (name in listOf("mote-upload-recovery", "mote-heartbeat")) manager.cancelUniqueWork(name).result.get(5, TimeUnit.SECONDS)
            HeldUploadCompletionWorker.reset()
            val predecessor = OneTimeWorkRequestBuilder<HeldUploadCompletionWorker>().setInputData(workDataOf("retry" to true)).build()
            manager.enqueueUniqueWork("mote-upload", ExistingWorkPolicy.REPLACE, predecessor).result.get(5, TimeUnit.SECONDS)
            try {
                assertTrue(HeldUploadCompletionWorker.entered.await(5, TimeUnit.SECONDS))
                QuickNotes.save(context, "Generated note behind retry backoff", "")
            } finally { HeldUploadCompletionWorker.release.countDown() }
            waitUntil { manager.getWorkInfoById(predecessor.id).get().let { it != null && it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount == 1 } }
            val before = requireNotNull(manager.getWorkInfoById(predecessor.id).get())
            repeat(12) { UploadWorker.schedule(context, config) }
            val after = requireNotNull(manager.getWorkInfoById(predecessor.id).get())
            assertEquals(before.nextScheduleTimeMillis, after.nextScheduleTimeMillis)
            assertEquals(1, after.runAttemptCount); assertEquals(WorkInfo.State.ENQUEUED, after.state)
            val chain = manager.getWorkInfosForUniqueWork("mote-upload").get()
            assertEquals(2, chain.size); assertEquals(1, chain.count { it.state == WorkInfo.State.BLOCKED })
            assertEquals(0, archive.notes.get()); assertEquals(1, context.queue().depth())
        }
    }
    @Test fun competingCaptureWorkersRetryWithoutReadingTheSamePendingBatch() = competingCaptureWorkers(cancelWaiting = false)
    @Test fun cancellingACompetingCaptureWorkerDoesNotWaitForTheActiveUpload() = competingCaptureWorkers(cancelWaiting = true)
    private fun competingCaptureWorkers(cancelWaiting: Boolean) = fixture { context, settings ->
        LoopbackArchive().use { archive ->
            val config = settings.read().copy(server = archive.url, token = token, debugHttp = true, wifiOnly = false, syncMode = "manual")
            settings.save(config)
            QuickNotes.save(context, "Generated competing upload record", "")
            val manager = WorkManager.getInstance(context)
            val completed = AtomicInteger(); val received = CountDownLatch(1); val release = CountDownLatch(1)
            val previous = HttpJson.onComplete
            HttpJson.onComplete = { duration ->
                previous?.invoke(duration)
                // The current protocol uploads before pulling derived receipts.
                // Hold the first capture response before its queue acknowledgement.
                if (completed.incrementAndGet() == 1) { received.countDown(); release.await(20, TimeUnit.SECONDS) }
            }
            fun request() = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf("manual" to true, "syncStamp" to SyncSchedule.stamp(config)))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            val first = request(); val competing = request()
            try {
                manager.enqueueUniqueWork("mote-upload", ExistingWorkPolicy.REPLACE, first).result.get(5, TimeUnit.SECONDS)
                assertTrue("First capture response is held before acknowledgement", received.await(5, TimeUnit.SECONDS))
                assertEquals(1, archive.notes.get()); assertEquals(1, context.queue().depth())
                manager.enqueueUniqueWork("mote-upload-recovery", ExistingWorkPolicy.REPLACE, competing).result.get(5, TimeUnit.SECONDS)
                if (cancelWaiting) {
                    val deadline = android.os.SystemClock.elapsedRealtime() + 5_000
                    while (manager.getWorkInfoById(competing.id).get()?.state != WorkInfo.State.RUNNING) {
                        check(android.os.SystemClock.elapsedRealtime() < deadline); Thread.sleep(5)
                    }
                    val started = android.os.SystemClock.elapsedRealtime()
                    manager.cancelWorkById(competing.id).result.get(2, TimeUnit.SECONDS)
                    waitUntil { manager.getWorkInfoById(competing.id).get()?.state == WorkInfo.State.CANCELLED }
                    assertTrue("Cancellation must not wait for the held upload", android.os.SystemClock.elapsedRealtime() - started < 2_000)
                } else {
                    waitUntil { manager.getWorkInfoById(competing.id).get().let { it != null && (it.state.isFinished || (it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount == 1)) } }
                    val retry = requireNotNull(manager.getWorkInfoById(competing.id).get())
                    assertEquals("Contention must retain a scheduled retry", WorkInfo.State.ENQUEUED, retry.state)
                    assertEquals(1, retry.runAttemptCount)
                    assertTrue(retry.nextScheduleTimeMillis > System.currentTimeMillis())
                }
                assertEquals("Only the active worker may issue capture-sync HTTP", 1, archive.requests.get())
                assertEquals(1, archive.notes.get()); assertEquals(1, context.queue().depth())
            } finally {
                release.countDown()
                waitUntil { manager.getWorkInfoById(first.id).get()?.state?.isFinished == true }
                manager.cancelWorkById(competing.id).result.get(5, TimeUnit.SECONDS)
                HttpJson.onComplete = previous
            }
            assertEquals(0, context.queue().depth()); assertEquals(1, archive.notes.get())
        }
    }
    private fun waitUntil(detail: () -> String = { "" }, check: () -> Boolean) { val deadline = System.currentTimeMillis() + 30_000; while (!check()) { require(System.currentTimeMillis() < deadline) { "Generated sync fixture timeout: ${detail()} ${Settings(InstrumentationRegistry.getInstrumentation().targetContext).syncState()} ${InstrumentationRegistry.getInstrumentation().targetContext.getSharedPreferences("mote", 0).getString("uploadStatus", "")}" }; Thread.sleep(50) } }
    @Test fun localNoteWithoutNodeIsReadableAndDoesNotScheduleUploads() = fixture { context, settings ->
        settings.read().validate(); assertFalse(settings.read().hasSyncConnection())
        val text = "Generated local-only note 👩🏽‍💻"
        val id = QuickNotes.save(context, text, "")
        assertEquals(1, context.queue().depth()); assertEquals(text, context.queue().peek()!!.getString("ocrText"))
        assertEquals("", settings.dataOrigin()); assertEquals("unconfigured", settings.syncState())
        assertTrue(String(File(QueueStorage(context).current().path, "$id.event").readBytes()).contains(text))
        assertTrue(QuickNotes.draft(context).read().text.isEmpty())
    }

    private class LoopbackArchive : Closeable {
        private val socket = ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"))
        val url = "http://127.0.0.1:${socket.localPort}"
        val requests = AtomicInteger(); val notes = AtomicInteger(); val heartbeats = AtomicInteger(); val batches = AtomicInteger()
        @Volatile var fault = ""
        @Volatile var lastSync: JSONObject? = null
        @Volatile private var running = true
        private val thread = Thread {
            while (running) try { socket.accept().use { client ->
                client.soTimeout = 5_000
                val input = client.getInputStream()
                fun line(): String { val value = StringBuilder(); while (true) { val byte = input.read(); if (byte < 0 || byte == 10) break; if (byte != 13) value.append(byte.toChar()) }; return value.toString() }
                val request = line().split(' '); val method = request.getOrNull(0); val route = request.getOrNull(1); var length = 0; var contentType = ""; var ingressVersion = ""
                while (true) { val header = line(); if (header.isEmpty()) break; if (header.startsWith("Content-Length:", true)) length = header.substringAfter(':').trim().toInt(); if (header.startsWith("Content-Type:", true)) contentType = header.substringAfter(':').trim(); if (header.startsWith("X-Mote-Ingress-Version:", true)) ingressVersion = header.substringAfter(':').trim() }
                if (method in setOf("POST", "PUT", "PATCH") && route != "/api/devices/heartbeat") require(ingressVersion == "2")
                require(length in 0..(12 * 1024 * 1024)); val data = ByteArray(length); var read = 0
                while (read < length) { val count = input.read(data, read, length - read); require(count > 0); read += count }
                val body = if (contentType.startsWith(CaptureBundle.CONTENT_TYPE)) {
                    val lines = GZIPInputStream(ByteArrayInputStream(data)).bufferedReader().readLines()
                    JSONObject().put("captures", JSONArray(lines.map(::JSONObject)))
                } else if(data.isEmpty()) JSONObject() else JSONObject(String(data, Charsets.UTF_8)); requests.incrementAndGet()
                var responseStatus = 200
                val result = when (route) {
                    "/api/devices/heartbeat" -> { heartbeats.incrementAndGet(); require(body.has("sync")); lastSync = body.getJSONObject("sync"); JSONObject().put("ok", true) }
                    "/api/captures/bundle", "/api/captures/batch" -> {
                        batches.incrementAndGet()
                        if (fault == "legacy") { responseStatus = 404; JSONObject().put("error", "forbidden") }
                        else {
                            val captures = body.getJSONArray("captures"); notes.addAndGet(captures.length())
                            if (fault == "dropNote") return@use
                            JSONObject().put("results", org.json.JSONArray().apply {
                                for (i in 0 until if (fault == "partial") 1 else captures.length()) {
                                    val id = if (fault == "wrongNoteAck") "wrong-id" else captures.getJSONObject(i).getString("id")
                                    put(JSONObject().put("id", id).put("status", 201).put("receipt", JSONObject().put("version", 2)
                                        .put("id", id).put("kind", "capture").put("state", "received").put("duplicate", false)))
                                }
                            })
                        }
                    }
                    "/api/captures" -> { notes.incrementAndGet(); if (fault == "dropNote") return@use
                        val id = if (fault == "wrongNoteAck") "wrong-id" else body.getString("id")
                        JSONObject().put("id", id).put("receipt", JSONObject().put("version", 2).put("id", id)
                            .put("kind", "capture").put("state", "received").put("duplicate", false)) }
                    "/api/sources" -> JSONObject().put("id", body.getString("id")).put("enabled", true)
                    else -> if (route?.endsWith("/items") == true) {
                        val id = UUID.randomUUID().toString(); val sourceId = route.split('/')[3]
                        val revision = if (fault == "wrongSourceAck") "wrong-revision" else body.getString("revision")
                        JSONObject().put("id", id).put("duplicate", false).put("sourceId", sourceId)
                            .put("externalId", body.getString("externalId")).put("revision", revision)
                            .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "source-item")
                                .put("state", "received").put("duplicate", false).put("sourceId", sourceId)
                                .put("externalId", body.getString("externalId")).put("revision", revision))
                    }
                    else if (route?.startsWith("/api/sources/") == true) JSONObject().put("id", route.substringAfterLast('/'))
                    else { responseStatus=404; JSONObject().put("error","fixture_route_missing") }
                }.toString().toByteArray(Charsets.UTF_8)
                client.getOutputStream().write("HTTP/1.1 $responseStatus Fixture\r\nContent-Type: application/json\r\nContent-Length: ${result.size}\r\nConnection: close\r\n\r\n".toByteArray())
                client.getOutputStream().write(result); client.getOutputStream().flush()
            } } catch (error: Exception) { if (running) throw error }
        }.apply { isDaemon = true; start() }
        override fun close() { running = false; socket.close(); thread.join(2_000) }
    }
}

/** A deterministic WorkManager completion window; no capture or network work. */
class HeldUploadCompletionWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        Settings(applicationContext).syncStatus("idle", "Generated predecessor completion window")
        entered.countDown()
        if (!release.await(20, TimeUnit.SECONDS) || inputData.getBoolean("fail", false)) return Result.failure()
        return if (inputData.getBoolean("retry", false)) Result.retry() else Result.success()
    }
    companion object {
        @Volatile var entered = CountDownLatch(1)
        @Volatile var release = CountDownLatch(1)
        fun reset() { entered = CountDownLatch(1); release = CountDownLatch(1) }
    }


}
