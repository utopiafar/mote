package dev.mote.collector

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
}
