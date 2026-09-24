package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.UUID

class MediaObservationTest {
    private fun session(id: String = "fixture-session", state: String = "playing", app: String = "com.example.player") = JSONObject()
        .put("sessionId", id).put("appId", app).put("appName", "Fixture Player").put("playbackState", state)
        .put("appVisibility", "background").put("playbackType", "local").put("title", "Generated chapter")
        .put("artist", "Fixture author").put("album", "Fixture album").put("displaySubtitle", "Chapter 2").put("mediaId", "fixture-only")
    private fun config() = CollectorConfig(deviceName = "Fixture phone", nsfw = NsfwConfig(), mediaCollectionEnabled = true)
    private fun event(sessions: List<JSONObject>, duration: Long = 0, collection: String = "content", status: String = "available") = JSONObject()
        .put("id", UUID.randomUUID().toString()).put("deviceId", "fixture-device").put("capturedAt", "2026-09-15T00:00:30Z")
        .put("source", "media").put("durationMs", duration)
        .put("privacy", JSONObject().put("excluded", false).put("collection", collection))
        .put("metadata", JSONObject().put("media", MediaPrivacy.snapshot(status, sessions)))
        .apply { sessions.singleOrNull()?.let { put("appId", it.getString("appId")); put("appName", it.getString("appName")) } }

    @Test fun mediaUsesExactPlayerIdentityAndActivityStripsAllTextOnEveryAttachment() {
        val c = config().copy(appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT,
            "com.example.player=activity\ncom.example.private=off").json(), excludedPackages = "com.example.excluded")
        val original = session()
        val sanitized = MediaPrivacy.session(original, c)!!
        assertTrue(MediaPrivacy.contentKeys.none(sanitized::has))
        assertTrue(MediaPrivacy.contentKeys.all(original::has))
        assertEquals("playing", sanitized.getString("playbackState"))
        assertNull(MediaPrivacy.session(session(app = "com.example.private"), c))
        assertNull(MediaPrivacy.session(session(app = "com.example.excluded"), c))
        assertNull(MediaPrivacy.session(session(app = ""), c))
        val content = session(app = "com.example.other")
        assertEquals("Generated chapter", MediaPrivacy.session(content, c)!!.getString("title"))
        assertTrue(MediaPrivacy.contentKeys.none(MediaPrivacy.session(content, c, activityOnly = true)!!::has))
        assertFalse(MediaPrivacy.powerAllowed(c.copy(chargingOnly = true), 80 to false))
        assertFalse(MediaPrivacy.powerAllowed(c.copy(batteryPauseBelowPct = 20), -1 to true))
        assertTrue(MediaPrivacy.powerAllowed(c.copy(batteryPauseBelowPct = 20), 20 to true))
        assertTrue(config().screenCollectionEnabled)
        assertFalse(CollectorConfig(deviceName = "Fixture").mediaCollectionEnabled)
    }
    @Test fun measuredPlayingIntervalsEndAtPauseAndNeverIncludePausedTime() {
        val timeline = MediaTimeline()
        fun observe(at: Long, state: String) = timeline.observe(at, at, 1_000_000 + at, listOf(session(state = state)))
        assertEquals(0L, observe(0, "playing").single().durationMs)
        assertEquals(30_000L, observe(30_000, "playing").single().durationMs)
        val paused = observe(38_000, "paused")
        assertEquals(listOf(8_000L, 0L), paused.map { it.durationMs })
        assertEquals(listOf("playing", "paused"), paused.map { it.sessions.single().getString("playbackState") })
        assertTrue(observe(60_000, "paused").isEmpty())
        assertEquals(0L, observe(65_000, "playing").single().durationMs)
        assertEquals(10_000L, observe(75_000, "playing").single().durationMs)
    }
    @Test fun sleepClockDiscontinuitiesScreenChangesAndDisconnectDoNotFillGaps() {
        for (next in listOf(Triple(61_000L, 61_000L, 61_000L), Triple(30_000L, 100L, 30_000L),
            Triple(30_000L, 30_000L, 50_000L), Triple(-1L, -1L, -1L))) {
            val timeline = MediaTimeline(); timeline.observe(0, 0, 1_000_000, listOf(session()))
            assertEquals(0L, timeline.observe(next.first, next.second, 1_000_000 + next.third, listOf(session())).sumOf { it.durationMs })
        }
        val timeline = MediaTimeline()
        timeline.observe(0, 0, 1_000_000, listOf(session()), "unlocked")
        assertEquals(0L, timeline.observe(30_000, 30_000, 1_030_000, listOf(session()), "locked").sumOf { it.durationMs })
        timeline.reset()
        assertEquals(0L, timeline.observe(40_000, 40_000, 1_040_000, listOf(session()), "locked").single().durationMs)
        assertEquals(0L, timeline.observe(50_000, 50_000, 1_050_000, listOf(session().put("appVisibility", "foreground")), "locked").sumOf { it.durationMs })
    }
    @Test fun metadataSwitchesPreserveOldItemDurationAndConcurrentSessionsAreSeparate() {
        val timeline = MediaTimeline()
        timeline.observe(0, 0, 1_000_000, listOf(session(), session("second")))
        val changed = timeline.observe(30_000, 30_000, 1_030_000, listOf(session().put("title", "Next fixture"), session("second")))
        assertEquals(60_000L, changed.sumOf { it.durationMs })
        assertEquals("Generated chapter", changed.first().sessions.single().getString("title"))
        assertEquals("Next fixture", changed[1].sessions.single().getString("title"))
        assertTrue(changed.filter { it.durationMs > 0 }.all { it.sessions.size == 1 })
        val removed = timeline.observe(40_000, 40_000, 1_040_000, listOf(session("second")))
        assertEquals(listOf(10_000L, 0L), removed.map { it.durationMs })
        assertEquals("second", removed.last().sessions.single().getString("sessionId"))
        assertTrue(timeline.observe(50_000, 50_000, 1_050_000, emptyList()).single().sessions.isEmpty())
    }
    @Test fun mediaQueueSurvivesRestartRetryAndAcknowledgementWithoutImagesOrOcr() {
        val directory = Files.createTempDirectory("mote-media-fixtures").toFile()
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes.reversedArray(); override fun open(bytes: ByteArray) = bytes.reversedArray() }
        try {
            val changes = mutableListOf<OperationKind>()
            val queue = DurableQueue(directory, cipher) { kind, _, _ -> changes += kind }
            val first = event(listOf(session()), 30_000)
            queue.enqueue(first, null, 100_000); queue.enqueue(first, null, 100_000)
            val restored = DurableQueue(directory, cipher)
            assertEquals(first.toString(), restored.peek()!!.toString())
            assertEquals(1, restored.summary().getInt("media"))
            assertEquals(0, directory.listFiles()!!.count { it.extension == "blob" })
            restored.verifyIntegrity(); restored.recoverOrphans()
            assertNull(restored.pendingOcr())
            assertThrows(IllegalArgumentException::class.java) { queue.enqueue(first, byteArrayOf(1), 100_000) }
            for (key in listOf("imageBase64", "imageMime", "ocrText", "windowTitle", "mood", "provenance", "ocr")) {
                assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event(listOf(session())).put(key, "fixture"), null, 100_000) }
            }
            assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event(listOf(session()), collection = "activity"), null, 100_000) }
            for (invalid in listOf(event(emptyList(), 30_000), event(listOf(session(), session("second")), 30_000),
                event(listOf(session(state = "paused")), 30_000), event(listOf(session()), 60_001), event(listOf(session()), 30_000).put("appName", "Other"))) {
                assertThrows(IllegalArgumentException::class.java) { queue.enqueue(invalid, null, 100_000) }
            }
            queue.acknowledge(first.getString("id"), 123); queue.acknowledge(first.getString("id"), 123)
            assertEquals(listOf(OperationKind.MEDIA_QUEUED, OperationKind.MEDIA_ACK), changes)
            assertEquals(0, queue.depth())
            queue.enqueue(event(emptyList(), status = "permission_required"), null, 100_000)
            assertEquals(0, queue.peek()!!.getJSONObject("metadata").getJSONObject("media").getJSONArray("sessions").length())
        } finally { directory.deleteRecursively() }
    }
    @Test fun activityOnlyMediaCanCommitAndReplayAnOldBlockedInbox() {
        val dir = Files.createTempDirectory("mote-activity-media").toFile()
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        try {
            val media = event(listOf(session().apply { MediaPrivacy.contentKeys.forEach(::remove) }), collection = "activity")
            // Same inbox shape persisted by 0.0.63–0.0.65 before the erroneous floor check.
            dir.resolve(".capture-stages.inbox").writeText(JSONObject().put("operation", UUID.randomUUID().toString())
                .put("input", JSONObject().put("event", media).put("image", JSONObject.NULL))
                .put("maxBytes", 1_000_000).put("reviewHeld", false).put("flush", false).toString())
            val restored = DurableQueue(dir, cipher)
            assertNull(restored.pendingStageFailure)
            assertFalse(dir.resolve(".capture-stages.inbox").exists())
            assertEquals("activity", restored.peek()!!.getJSONObject("privacy").getString("collection"))
            assertEquals("media", restored.peek()!!.getString("source"))
            restored.enqueue(event(listOf(session())), null, 1_000_000)
            assertEquals(2, DurableQueue(dir, cipher).depth())
        } finally { dir.deleteRecursively() }
    }

    @Test fun availabilitySnapshotsClearSessionsAndOldOperationLedgersKeepTheirEpoch() {
        for (status in listOf("disabled", "permission_required", "unavailable"))
            assertEquals(0, MediaPrivacy.snapshot(status, listOf(session())).getJSONArray("sessions").length())
        val directory = Files.createTempDirectory("mote-media-ledger").toFile()
        try {
            val file = directory.resolve("operations.json"); val ledger = OperationLedger(file)
            ledger.record(OperationKind.SCREEN_ACK, bytes = 20)
            val old = ledger.read(); val epoch = old.getString("epochId")
            listOf("MEDIA_ACK", "MEDIA_QUEUED", "MEDIA_FAILED").forEach { old.getJSONObject("counts").remove(it) }
            file.writeText(old.toString())
            ledger.record(OperationKind.MEDIA_ACK, bytes = 40)
            assertEquals(epoch, ledger.read().getString("epochId"))
            assertEquals(60, ledger.read().getLong("confirmedUploadBytes"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun phoneBrowserPagesMediaAndLabelsFactsWithoutRequestingAnImage() {
        val directory = Files.createTempDirectory("mote-media-browser").toFile()
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        try {
            val queue = DurableQueue(directory, cipher)
            val media = event(listOf(session()), 30_000).put("ocrText", "").put("windowTitle", "")
            queue.enqueue(media, null, 100_000)
            val after = "2026-09-15T00:00:00Z"; val before = "2026-09-16T00:00:00Z"
            assertEquals(0, queue.screenPage(after, before).getInt("totalCount"))
            val page = queue.capturePage(after, before, source = "media")
            val row = page.getJSONArray("items").getJSONObject(0)
            assertEquals(1, page.getInt("totalCount")); assertFalse(row.getBoolean("hasImage"))
            assertNull(queue.image(row.getString("id")))
            assertTrue(CapturePreview.mediaLabel(row).contains("播放中 · 后台 · 本机播放"))
            assertTrue(CapturePreview.mediaLabel(row).contains("Generated chapter"))
            assertEquals("媒体等待授权", CapturePreview.mediaLabel(event(emptyList(), status = "permission_required")))
            val remote = event(emptyList()).put("imageMime", JSONObject.NULL).put("imagePath", JSONObject.NULL)
            assertFalse(CapturePreview.hasImage(remote))
            assertFalse(CapturePreview.hasImage(remote.put("hasImage", true)))
            assertFalse(CapturePreview.hasImage(JSONObject().put("source", "screen").put("imageMime", JSONObject.NULL)))
            assertTrue(CapturePreview.hasImage(JSONObject().put("source", "screen").put("imageMime", "image/jpeg")))
        } finally { directory.deleteRecursively() }
    }
}
