package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The ongoing title is the shared status row; the local count belongs to
 * 采集与存储详情, and only an interruption reaches the 需要处理 channel. */
class NotificationsTest {
    private fun row(id: CaptureStatusId) = CaptureStatusMapping.row(id)

    @Test fun theOngoingTitleIsTheCurrentStatusAndNeverTheLocalCount() {
        assertEquals("采集中", ongoingCaptureTitle(row(CaptureStatusId.CAPTURING), 0))
        assertEquals("采集中 · 待同步 12 条", ongoingCaptureTitle(row(CaptureStatusId.PENDING_SYNC), 12))
        assertEquals("屏幕采集已暂停", ongoingCaptureTitle(row(CaptureStatusId.SCREEN_PAUSED), 12))
        assertEquals("采集已暂停", ongoingCaptureTitle(row(CaptureStatusId.PAUSED), 12))
        assertEquals("需要重新连接", ongoingCaptureTitle(row(CaptureStatusId.RECONNECT), 12))
        assertEquals("本机空间已满", ongoingCaptureTitle(row(CaptureStatusId.STORAGE_FULL), 12))
        assertEquals("部分来源等待权限", ongoingCaptureTitle(row(CaptureStatusId.PERMISSION), 12))
        assertEquals("采集中 · 发送需要处理", ongoingCaptureTitle(row(CaptureStatusId.SEND_ATTENTION), 12))
        assertNull("A stopped service has no ongoing title", ongoingCaptureTitle(row(CaptureStatusId.INTERRUPTED), 12))
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
}
