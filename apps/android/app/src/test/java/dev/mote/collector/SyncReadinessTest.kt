package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SyncReadinessTest {
    @get:Rule val folder = TemporaryFolder()
    private val connected = CollectorConfig(deviceName = "Generated fixture", server = "http://127.0.0.1:47843",
        token = "generated-android-node-token-1234567890", debugHttp = true, wifiOnly = false, syncMode = "batch")
    private val disconnected = connected.copy(server = "", token = "")
    private val old = StoredSyncStatus("unconfigured", SyncReadiness.NOT_CONFIGURED)
    private val empty = QueueInventory(0, 0, 0, 0, 0, 0, 0, 0)
    private val translations = listOf("en", "de", "es", "fr", "ja", "ru").map { language ->
        JSONObject(File("src/main/assets/i18n-$language.json").readText())
    }
    private fun matches(source: String, text: String) = source == text || translations.any { it.optString(source) == text }
    private fun visible(config: CollectorConfig, status: StoredSyncStatus, inventory: QueueInventory? = empty, waiting: String? = null, sourceIssues: Int? = 0, totalPending: Int? = inventory?.pending) =
        SyncReadiness.visible(config, status, waiting, inventory, sourceIssues, totalPending, matches = ::matches)
    private fun heartbeat(config: CollectorConfig, status: StoredSyncStatus, blocked: Int = 0, pending: PendingSync = PendingSync(0, null), sourceIssues: Int? = 0) =
        SyncReadiness.heartbeatState(config, status, blocked, pending, sourceIssues, ::matches)

    @Test fun pairingWithEmptyQueueProjectsANeutralStatusWithoutChangingTheStoredValue() {
        assertEquals(VisibleSyncStatus.Disconnected, visible(disconnected, old))
        assertNull(connected.syncPolicy().delayMillis(1000, 0, null, 0))
        assertEquals(VisibleSyncStatus.SendAsConfigured, visible(connected, old))
        assertEquals("idle", heartbeat(connected, old))
        assertEquals("unconfigured", old.state)
        // A fresh reader after restart sees the same stored status and projects it again.
        assertEquals(VisibleSyncStatus.SendAsConfigured, visible(connected, old.copy()))
        assertFalse(SyncReadiness.text(VisibleSyncStatus.SendAsConfigured).contains("确认"))
    }

    @Test fun logoutAndExpiredCredentialsDoNotLookLikeAConfiguredConnection() {
        for (config in listOf(disconnected, connected.copy(authSignedOut = true), connected.copy(authExpiresAt = 1))) {
            assertEquals(VisibleSyncStatus.Disconnected, visible(config, old))
            assertEquals("unconfigured", heartbeat(config, old))
        }
    }

    @Test fun logoutShowsCurrentDisconnectionWithoutDiscardingPriorErrorsOrReceipts() {
        for (state in listOf("idle", "uploading", "manual", "error")) {
            val oldResult = StoredSyncStatus(state, "Generated previous $state receipt or error")
            assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Disconnected, VisibleSyncStatus.Message(oldResult.message))), visible(connected.copy(authSignedOut = true), oldResult))
            assertEquals(oldResult.state, heartbeat(connected.copy(authSignedOut = true), oldResult))
        }
        val error = StoredSyncStatus("error", "Generated retained transport error")
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message("等待非计费 Wi-Fi"), VisibleSyncStatus.Message(error.message))), visible(connected, error, waiting = "等待非计费 Wi-Fi"))
    }

    @Test fun actualErrorsUnknownMessagesAndPauseOrWifiRestrictionsArePreserved() {
        val error = StoredSyncStatus("error", "Generated transport error; records retained")
        val custom = StoredSyncStatus("unconfigured", "Generated scheduling error; retry")
        val acknowledgement = StoredSyncStatus("uploading", "已收到上传确认")
        for (status in listOf(error, custom, acknowledgement, StoredSyncStatus("paused", "Generated pause error; retry"))) {
            assertEquals(VisibleSyncStatus.Message(status.message), visible(connected, status))
            assertEquals(status.state, heartbeat(connected, status))
        }
        val wait = SyncConditions(false, false, true).waitingReason(false, null, false)
        assertEquals(VisibleSyncStatus.Message("等待非计费 Wi-Fi"), visible(connected, old, waiting = wait))
        assertEquals(VisibleSyncStatus.Message("已暂停全部发送 · 本机继续保存"),
            visible(connected.copy(syncPaused = true), old, waiting = "已暂停全部发送 · 本机继续保存"))
        assertEquals("unconfigured", heartbeat(connected.copy(syncPaused = true), old))
    }

    @Test fun resumingARecognisedPauseUsesCurrentConnectionAndPreservesBlockedRecords() {
        val paused = StoredSyncStatus("paused", SyncReadiness.PAUSED)
        assertEquals(VisibleSyncStatus.Message(paused.message), visible(connected.copy(syncPaused = true), paused))
        assertEquals("paused", heartbeat(connected.copy(syncPaused = true), paused))
        assertEquals(VisibleSyncStatus.SendAsConfigured, visible(connected, paused))
        assertEquals("idle", heartbeat(connected, paused))
        assertEquals(VisibleSyncStatus.NeedsAttention(1, 0), visible(connected, paused, empty.copy(blocked = 1)))
        assertEquals("error", heartbeat(connected, paused, blocked = 1))
        assertEquals(VisibleSyncStatus.Disconnected, visible(connected.copy(authSignedOut = true), paused))
        assertEquals("unconfigured", heartbeat(connected.copy(authSignedOut = true), paused))
        assertEquals("paused", paused.state)
    }

    @Test fun blockedRecordsAndPendingWorkAreNotPresentedAsCompleted() {
        assertEquals(VisibleSyncStatus.Loading, visible(connected, old, inventory = null))
        assertEquals(VisibleSyncStatus.Unavailable, SyncReadiness.visible(connected, old, null, empty, 0, 0, inventoryUnavailable = true, matches = ::matches))
        assertEquals(VisibleSyncStatus.NeedsAttention(2, 3), visible(connected, old, empty.copy(blocked = 2, pending = 3)))
        assertEquals("error", heartbeat(connected, old, blocked = 2))
        assertEquals("waiting", heartbeat(connected, old, pending = PendingSync(1, 100)))
        assertEquals("waiting", heartbeat(connected, old, pending = PendingSync(0, 100, pendingUpdates = 1)))
    }

    @Test fun sourceErrorsAndUnreadableSourceStateCannotBecomeIdle() {
        val cipher = object : ByteCipher {
            override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
            override fun open(bytes: ByteArray) = seal(bytes)
        }
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val source = LocalSource(name = "Generated source", kind = "local-files", uri = "content://fixture/document/root", retention = "snapshot")
        store.save(source)
        val paused = StoredSyncStatus("paused", SyncReadiness.PAUSED)
        val count = SyncHealth.sourceAttentionCount(store) { 0 }
        assertEquals(1, count) // No central processing consent, even with no pending versions.
        assertEquals(VisibleSyncStatus.NeedsSourceAttention(1, 0), visible(connected, paused, sourceIssues = count))
        assertEquals(VisibleSyncStatus.NeedsSourceAttention(1, 1), visible(connected, paused, sourceIssues = count, totalPending = 1))
        assertEquals("error", heartbeat(connected, paused, sourceIssues = count))
        val custom = StoredSyncStatus("unconfigured", "Generated retained scheduling error")
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.NeedsSourceAttention(1, 0), VisibleSyncStatus.Message(custom.message))), visible(connected, custom, sourceIssues = count))
        assertEquals("error", heartbeat(connected, custom, sourceIssues = count))
        store.save(source.copy(centralProcessingConsent = true))
        for (failure in listOf("permission", "offline", "ack")) {
            store.status(source.id, failure)
            assertEquals(failure, 1, SyncHealth.sourceAttentionCount(store) { 0 })
            // The scheduler may have replaced paused with waiting after resume.
            val waiting = StoredSyncStatus("waiting", "等待约定同步时间")
            val pending = empty.copy(pending = 1)
            assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message(waiting.message), VisibleSyncStatus.NeedsSourceAttention(1, 1))),
                visible(connected, waiting, pending, waiting = waiting.message, sourceIssues = SyncHealth.sourceAttentionCount(store) { 1 }))
            assertEquals("error", heartbeat(connected, waiting, pending = PendingSync(1, 100), sourceIssues = SyncHealth.sourceAttentionCount(store) { 1 }))
        }
        store.status(source.id, "synced")
        assertEquals(0, SyncHealth.sourceAttentionCount(store) { 0 })
        assertTrue(runCatching { SyncHealth.sourceAttentionCount(store) { throw IllegalStateException("generated unreadable source") } }.isFailure)
        assertEquals("error", heartbeat(connected, paused, sourceIssues = null))
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Unavailable, VisibleSyncStatus.Loading)), SyncReadiness.visible(connected, paused, null, empty, null, null, inventoryUnavailable = true, matches = ::matches))
    }

    @Test fun waitingAndKnownProblemsRemainVisibleTogether() {
        val waiting = StoredSyncStatus("waiting", "等待充电")
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message("等待充电"), VisibleSyncStatus.NeedsAttention(2, 3), VisibleSyncStatus.NeedsSourceAttention(1, 3))),
            visible(connected, waiting, empty.copy(blocked = 2, pending = 3), waiting = "等待充电", sourceIssues = 1))
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message("等待充电"), VisibleSyncStatus.Unavailable, VisibleSyncStatus.SourceUnavailable)),
            SyncReadiness.visible(connected, waiting, "等待充电", empty, null, null, inventoryUnavailable = true, sourceUnavailable = true, matches = ::matches))
    }

    @Test fun onePendingCalendarVersionIsCountedWhileItsHttpFailureSurvivesWaiting() {
        val cipher = object : ByteCipher {
            override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
            override fun open(bytes: ByteArray) = seal(bytes)
        }
        val store = LocalSourceStore(folder.newFolder(), cipher)
        val calendar = LocalSource(name = "Generated calendar", kind = "local-calendar", calendarId = 17)
        store.save(calendar); store.selectTarget(calendar.id, "generated-target")
        val at = "2026-10-30T00:00:00Z"
        val event = JSONObject().put("externalId", "calendar:17:1").put("observedAt", at).put("title", "Generated event")
            .put("text", "Generated evidence").put("kind", "calendar").put("layer", "snapshot")
        store.scan(calendar, SourceScan(listOf(event), true, at)); store.status(calendar.id, "http")
        val state = LocalStateSnapshot(active = empty, quarantine = empty).withSources {
            store.pendingSync().count to SyncHealth.sourceAttentionCount(store) { 0 }
        }
        assertEquals(1, state.pending); assertEquals(1, state.sourceIssues)
        val waiting = StoredSyncStatus("waiting", "等待约定同步时间")
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message(waiting.message), VisibleSyncStatus.NeedsSourceAttention(1, 1))),
            visible(connected, waiting, state.active, waiting.message, state.sourceIssues, state.pending))
        assertEquals("error", heartbeat(connected, waiting, pending = store.pendingSync(), sourceIssues = state.sourceIssues))
        assertEquals(1, store.pendingSync().count)
    }

    @Test fun disabledCorruptSourceDoesNotRequireAHealthReadButEnabledCorruptionIsReported() {
        val cipher = object : ByteCipher {
            override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
            override fun open(bytes: ByteArray) = seal(bytes)
        }
        val source = LocalSource(name = "Generated disabled source", kind = "local-files", uri = "content://fixture/document/root", enabled = false)
        fun corruptStore(enabled: Boolean): LocalSourceStore {
            val dir = folder.newFolder()
            val store = LocalSourceStore(dir, cipher)
            store.save(source.copy(enabled = enabled))
            File(dir, "source-${source.id}.enc").writeBytes(byteArrayOf(0))
            return store
        }
        val disabled = corruptStore(enabled = false)
        assertEquals(0, SyncHealth.sourceAttentionCount(disabled) { error("disabled source must not read pending files") })
        val enabled = corruptStore(enabled = true)
        val health = runCatching { SyncHealth.sourceAttentionCount(enabled) { 0 } }
        assertTrue(health.exceptionOrNull() is org.json.JSONException)
        val status = StoredSyncStatus("waiting", "等待充电")
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Message("等待充电"), VisibleSyncStatus.SourceUnavailable)),
            SyncReadiness.visible(connected, status, "等待充电", empty, health.getOrNull(), null, sourceUnavailable = health.isFailure, matches = ::matches))
    }

    @Test fun languageCatalogLoadingAndFailureDoNotShowAnUnverifiedOldStatus() {
        assertEquals(VisibleSyncStatus.Loading, SyncReadiness.visible(connected, old, null, empty, 0, 0, labelsReady = false, matches = ::matches))
        assertEquals(VisibleSyncStatus.Many(listOf(VisibleSyncStatus.Unavailable, VisibleSyncStatus.Message(old.message))), SyncReadiness.visible(connected, old, null, empty, 0, 0, labelsReady = false, labelsFailed = true, matches = ::matches))
    }

    @Test fun persistedLabelsFromAnySupportedLanguageAreProjectedWithoutRewritingThem() {
        for (key in SyncReadiness.obsoleteMessages) for (catalog in translations) {
            val status = StoredSyncStatus(if (key == SyncReadiness.PAUSED) "paused" else "unconfigured", catalog.getString(key))
            assertEquals(VisibleSyncStatus.SendAsConfigured, visible(connected, status))
            assertEquals("idle", heartbeat(connected, status))
            assertEquals(catalog.getString(key), status.message)
        }
        // The output is an authored key resolved at display time, not a persisted translation.
        assertEquals("Send according to settings", translations.first().getString("按设置发送"))
    }
}
