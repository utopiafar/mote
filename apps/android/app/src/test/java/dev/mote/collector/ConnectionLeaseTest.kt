package dev.mote.collector

import dev.mote.collector.meeting.MeetingWaveWriter
import dev.mote.collector.meeting.meetingRecordings
import dev.mote.collector.plugins.DurableTransportPlugin
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Instant
import java.util.UUID

/** Real settings, stores and generation fences; only Android's keystore and
 * application startup are replaced in this generated JVM profile. */
@RunWith(RobolectricTestRunner::class)
@Config(application = MoteApplication::class, shadows = [AssistantHostApplicationShadow::class, AssistantHostSecretBoxShadow::class], sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class ConnectionLeaseTest {
    private val app get() = RuntimeEnvironment.getApplication() as MoteApplication
    private lateinit var transport: DurableTransportPlugin
    @Before fun startStores() {
        LocalDataFormat.requireCurrent(app)
        // The production location writer's JDK directory-fsync boundary works
        // on this host; Robolectric's Linux.open cannot open directories.
        QueueLocationStore(app.noBackupFilesDir, File(app.noBackupFilesDir, "queue"), app.localContentCipher()).current()
        transport = DurableTransportPlugin.start(app, app.pluginHost)
    }
    @After fun closeStores() { if (::transport.isInitialized) transport.close(); app.pluginHost.quit() }
    private fun connection(settings: Settings, origin: String) = settings.read().copy(server = origin, token = "generated-${"x".repeat(40)}", wifiOnly = false, syncMode = "manual")

    @Test fun returningToTheSameNodeDoesNotReviveOldCallbacksAndDelayedSummaryKeepsTheActualAckOrigin() {
        val settings = Settings(app); val a = "https://generated-a.invalid"; val b = "https://generated-b.invalid"
        settings.save(connection(settings, a)); val config = settings.read(); val lease = ConnectionLease(app, config)
        assertTrue(lease.current())
        val event = JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId).put("source", "note")
            .put("capturedAt", "2026-11-17T01:00:00Z").put("ocrText", "Generated retained note").put("privacy", JSONObject().put("excluded", false))
        val queue = app.queue(); queue.enqueue(event, null); queue.acknowledge(event.getString("id"))
        settings.save(connection(settings, b))
        settings.syncStatus("idle", "Stale completion", uploaded = true, acknowledgedOrigin = a, ackGeneration = lease.generation)
        val prefs = app.getSharedPreferences("mote", 0)
        assertFalse(prefs.contains("lastUploadAt")); assertFalse(prefs.contains("lastUploadOrigin"))
        assertEquals(a, queue.archiveRecord(event.getString("id"))!!.first.getJSONObject("_archiveAcknowledgment").getString("origin"))
        settings.save(connection(settings, a)); assertFalse(lease.current())
        assertThrows(IllegalStateException::class.java) { lease.commit { fail("A→B→A must not revive an old completion") } }
        val current = ConnectionLease(app, settings.read()); assertTrue(current.current())
        settings.syncStatus("idle", "Current completion", uploaded = true, acknowledgedOrigin = a, ackGeneration = current.generation)
        assertEquals(a, prefs.getString("lastUploadOrigin", ""))
        settings.signOut(); assertFalse(current.current())
    }

    @Test fun meetingRecordingUnconfirmedAudioAndQuarantinePinTheConnection() {
        val settings = Settings(app); val a = "https://generated-a.invalid"; settings.save(connection(settings, a))
        val store = app.meetingRecordings(); val at = Instant.parse("2026-11-17T01:00:00Z")
        val notice = store.acknowledgeNotice(at); val id = UUID.randomUUID().toString(); store.begin(id, at, notice, a)
        assertTrue(settings.hasPendingData())
        val audio = File(app.filesDir, "meeting-recordings/meeting-$id.wav")
        MeetingWaveWriter(audio, 16000, 1).apply { write(ShortArray(160) { 3 }, 160); finish() }
        val completed = store.complete(id, at.plusSeconds(1), 1000, true, false, audio.name, emptyList())
        assertTrue(settings.hasPendingData()); store.quarantine(completed)
        assertTrue(settings.hasPendingData())
        assertThrows(IllegalArgumentException::class.java) { settings.save(connection(settings, "https://generated-b.invalid")) }
        assertEquals(a, settings.read().server); assertTrue(audio.isFile); assertTrue(store.sessions().single().quarantined)
    }

    @Test fun obsoletePreferenceQuotasCannotRestoreAutomaticCollectionPermissions() {
        val settings = Settings(app)
        val explicit = settings.read().copy(mediaCollectionEnabled = false, notificationCollectionEnabled = false, deviceEventCollectionEnabled = false,
            appCollectionRules = "{\"default\":\"off\",\"apps\":{}}", uploadGate = UploadGateConfig(true, "Generated private gate", "hold"))
        settings.save(explicit)
        app.getSharedPreferences("mote", 0).edit().putInt("maxQueue", 8).putInt("uploadedRetentionDays", 0).commit()
        assertEquals(explicit, Settings(app).read())
        val portable = JSONObject(ConfigurationArchive.encode(Settings(app).read())).getJSONObject("settings")
        assertFalse(portable.has("maxQueueMiB")); assertFalse(portable.has("uploadedRetentionDays"))
    }
}
