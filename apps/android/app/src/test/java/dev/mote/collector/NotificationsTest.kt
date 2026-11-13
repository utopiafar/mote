package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/** The ongoing title is the shared status row; the local count belongs to
 * 采集与存储详情, and only an interruption reaches the 需要处理 channel. */
class NotificationsTest {
    private val cases by lazy { JSONArray(javaClass.classLoader!!.getResource("capture-status-cases.json")!!.readText()) }
    private fun row(id: CaptureStatusId) = CaptureStatusMapping.row(id)

    @Test fun theOngoingTitleIsTheCurrentStatusAndNeverTheLocalCount() {
        assertEquals("采集中", ongoingCaptureTitle(row(CaptureStatusId.CAPTURING)))
        assertEquals("采集中", ongoingCaptureTitle(row(CaptureStatusId.PENDING_SYNC)))
        assertEquals("屏幕采集已暂停", ongoingCaptureTitle(row(CaptureStatusId.SCREEN_PAUSED)))
        assertEquals("采集已暂停", ongoingCaptureTitle(row(CaptureStatusId.PAUSED)))
        assertEquals("需要重新连接", ongoingCaptureTitle(row(CaptureStatusId.RECONNECT)))
        assertEquals("本机空间已满", ongoingCaptureTitle(row(CaptureStatusId.STORAGE_FULL)))
        assertEquals("部分来源等待权限", ongoingCaptureTitle(row(CaptureStatusId.PERMISSION)))
        assertEquals("采集中 · 发送需要处理", ongoingCaptureTitle(row(CaptureStatusId.SEND_ATTENTION)))
        assertNull("A stopped service has no ongoing title", ongoingCaptureTitle(row(CaptureStatusId.INTERRUPTED)))
    }

    /** Zero and many pending records keep the same status title; the count stays in 采集与存储详情. */
    @Test fun pendingSyncKeepsTheStatusTitleAtAnyCount() {
        fun status(pending: Int?) = CaptureStatusMapping.status(CaptureStatusFacts(
            connection = CaptureConnection.CONNECTED, captureEnabled = true, captureLive = true,
            syncState = CaptureSyncState.WAITING, pending = pending))
        assertEquals(CaptureStatusId.CAPTURING, status(0).id)
        assertEquals(CaptureStatusId.PENDING_SYNC, status(3).id)
        assertEquals("采集中", ongoingCaptureTitle(status(0)))
        assertEquals("采集中", ongoingCaptureTitle(status(3)))
        assertEquals("采集中", ongoingCaptureTitle(status(1200)))
    }

    @Test fun onlyInterruptionsPostAndOnlyOncePerIncident() {
        val dedup = CaptureAttentionDedup()
        assertFalse("Normal capture never notifies", dedup.update(row(CaptureStatusId.CAPTURING)))
        assertFalse("A partial problem only changes the ongoing title", dedup.update(row(CaptureStatusId.PERMISSION)))
        assertFalse(dedup.update(row(CaptureStatusId.SEND_ATTENTION)))

        assertTrue("The first interruption posts", dedup.update(row(CaptureStatusId.INTERRUPTED)))
        assertFalse("The same incident does not post twice", dedup.update(row(CaptureStatusId.INTERRUPTED)))
        assertFalse(dedup.update(row(CaptureStatusId.PERMISSION)))
        assertFalse(dedup.update(row(CaptureStatusId.INTERRUPTED)))

        assertFalse("Recovery clears the incident", dedup.update(row(CaptureStatusId.CAPTURING)))
        assertTrue("A later interruption posts again", dedup.update(row(CaptureStatusId.INTERRUPTED)))

        assertFalse("An intentional pause is a recovery", dedup.update(row(CaptureStatusId.PAUSED)))
        assertTrue("A new incident after the pause posts again", dedup.update(row(CaptureStatusId.INTERRUPTED)))
    }

    @Test fun theAttentionTitleComesFromTheSharedNotificationRow() {
        assertEquals("采集已中断", captureAttentionTitle(row(CaptureStatusId.INTERRUPTED)))
        assertEquals("本机空间已满", captureAttentionTitle(row(CaptureStatusId.STORAGE_FULL)))
        assertNull(captureAttentionTitle(row(CaptureStatusId.CAPTURING)))
    }

    @Test fun everySharedCaseRendersTheOngoingAndNotificationColumns() {
        assertEquals(20, cases.length())
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val expected = case.getJSONObject("expected")
            val name = case.getString("name")
            val id = CaptureStatusId.entries.first { it.wire == expected.getString("id") }
            val status = row(id)
            val ongoing = if (expected.isNull("androidOngoing")) null else expected.getString("androidOngoing")
            assertEquals("$name: ongoing", ongoing, ongoingCaptureTitle(status))
            val notification = expected.optJSONObject("notification")
            assertEquals("$name: notification", notification?.getString("titleKey"), captureAttentionTitle(status))
        }
    }

    private val origin = "https://generated.invalid"
    private val id = "10000000-0000-4000-8000-000000000001"
    private val at = "2026-11-13T10:00:00.000Z"
    private val until = "2026-11-13T11:00:00.000Z"
    private fun event(revision: Int = 1, eligibleAt: String = at) = JSONObject().put("id", id).put("revision", revision)
        .put("title", "Generated useful card").put("reason", "Generated current reminder").put("eligibleAt", eligibleAt).put("expiresAt", until)
    private fun snapshot(value: JSONObject = event()) = JSONObject().put("items", JSONArray().put(value))
    private fun card() = event().put("state", "open").put("body", "Generated current result").put("readAt", JSONObject.NULL).put("evidence", JSONArray())

    @Test fun oneOccurrenceSurvivesDuplicatePollsAndRecreationWithoutRepeatingTheAlert() {
        var cursor: AssistantNoticeCursor? = null
        var now = java.time.Instant.parse(at).toEpochMilli()
        val shown = mutableListOf<AssistantNotice>(); var visible: AssistantNotice? = null
        fun presenter() = AssistantNoticePresenter({ cursor }, { cursor = it }, { shown += it; visible = it }, { visible = null }, { now })
        val first = presenter()
        first.update(origin, snapshot(), true); first.update(origin, snapshot(), true)
        assertEquals(1, shown.size); assertEquals(AssistantNoticeCursor(origin, id, at), cursor)
        first.clear()
        val restored = presenter(); restored.update(origin, snapshot(), true)
        assertEquals(1, shown.size); assertNull(visible)
        now += 30 * 60_000
        restored.update(origin, snapshot(event(2, "2026-11-13T10:30:00.000Z")), true)
        assertEquals("A server later-until occurrence can remind again", 2, shown.size)
        restored.update(origin, snapshot(), true)
        assertEquals("A preference change cannot replay an older slot", 2, shown.size)
    }

    @Test fun permissionDenialAndAdapterFailureKeepTheOccurrenceRecoverable() {
        var cursor: AssistantNoticeCursor? = null; var posts = 0; var fail = true
        val presenter = AssistantNoticePresenter({ cursor }, { cursor = it }, { if (fail) throw SecurityException("Generated OS denial") else posts++ }, {}, { java.time.Instant.parse(at).toEpochMilli() })
        presenter.update(origin, snapshot(), false)
        assertNull(cursor); assertEquals(0, posts)
        assertThrows(SecurityException::class.java) { presenter.update(origin, snapshot(), true) }
        assertNull(cursor)
        fail = false; presenter.update(origin, snapshot(), true)
        assertEquals(1, posts); assertEquals(id, cursor?.id)
    }

    @Test fun correctionsWithdrawalAndExpiryRemoveTheOldSystemSummary() {
        var cursor: AssistantNoticeCursor? = null; var posts = 0; var visible = false
        var now = java.time.Instant.parse(at).toEpochMilli()
        val presenter = AssistantNoticePresenter({ cursor }, { cursor = it }, { posts++; visible = true }, { visible = false }, { now })
        presenter.update(origin, snapshot(), true); assertTrue(visible)
        presenter.update(origin, snapshot(event(2)), true)
        assertFalse(visible); assertEquals("A content revision never re-alerts", 1, posts)
        presenter.update(origin, JSONObject().put("items", JSONArray()), true)
        presenter.update(origin, snapshot(), true); assertEquals(1, posts)
        now += 30 * 60_000
        presenter.update(origin, snapshot(event(3, "2026-11-13T10:30:00.000Z")), true); assertTrue(visible)
        now = java.time.Instant.parse(until).toEpochMilli(); presenter.expire(); assertFalse(visible)
        presenter.update(origin, snapshot(), true); assertEquals("Offline expired events never replay", 2, posts)
    }

    @Test fun inboxReadsAllCurrentCardsEvenWhenTheNotificationProjectionIsEmpty() {
        val requests = mutableListOf<String>(); var feedback: JSONObject? = null
        val client = CentralClient(origin, "generated-owner", transport = { method, url, body, _, _ ->
            val uri = java.net.URI(url); requests += uri.path
            assertTrue(java.net.URLDecoder.decode(uri.rawQuery, "UTF-8").contains("scope={\"kind\":\"all\"}"))
            val result = when {
                uri.path == "/api/assistant-notifications" -> JSONObject().put("items", JSONArray())
                uri.path == "/api/assistant-cards" -> JSONObject().put("items", JSONArray().put(card())).put("nextCursor", JSONObject.NULL)
                method == "POST" -> {
                    feedback = JSONObject(String(body!!)); card().put("revision", 2).put("readAt", at)
                }
                else -> card()
            }
            200 to result
        })
        val reader = AssistantNotificationReader(client)
        assertEquals(0, AssistantNotice.snapshot(reader.snapshot()).size)
        assertEquals("Generated current result", reader.page().items.single().body)
        assertEquals(at, reader.card(id, true).readAt)
        assertEquals("read", feedback!!.getString("action")); assertEquals(1, feedback!!.getInt("expectedRevision"))
        val count = requests.size
        assertThrows(IllegalArgumentException::class.java) { reader.card("https://foreign.invalid/result") }
        assertEquals(count, requests.size)
        assertThrows(IllegalStateException::class.java) { AssistantCardPreview.read(card().put("state", "stale")) }
        assertThrows(IllegalStateException::class.java) { AssistantCardPreview.read(card().put("evidenceStale", true)) }
    }

    @Test fun concurrentReadFeedbackReloadsTheCurrentCardWithoutRepeatingTheWrite() {
        var reads = 0; var posts = 0
        val reader = AssistantNotificationReader(CentralClient(origin, "generated-owner", transport = { method, _, _, _, _ ->
            if (method == "POST") { posts++; 409 to JSONObject().put("code", "invalid_data") }
            else {
                reads++
                200 to card().put("revision", reads).put("body", if (reads == 1) "Generated prior result" else "Generated revised result")
                    .put("readAt", if (reads == 1) JSONObject.NULL else at)
            }
        }))
        val current = reader.card(id, true)
        assertEquals("Generated revised result", current.body); assertEquals(at, current.readAt)
        assertEquals(2, reads); assertEquals(1, posts)
    }
}
