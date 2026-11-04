package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Clearing every capture status must cancel the ongoing status notification
 * even though the local image count stays readable and annotates an active
 * status. */
class NotificationsTest {
    private val imageLabel = LocalStateSnapshot().imageLabel()

    @Test fun theLocalImageCountAloneNeverPublishesTheStatusNotification() {
        assertNull(captureStatusText(null, null, null, imageLabel))
        assertNull(captureStatusText(null, null, null, null))
    }

    @Test fun aScreenStatusKeepsTheLocalImageCountAsAnAnnotation() {
        assertEquals(
            MoteI18n.text("屏幕：{0}", "正在采集") + "\n" + imageLabel,
            captureStatusText("正在采集", null, null, imageLabel),
        )
    }

    @Test fun aMediaStatusKeepsTheLocalImageCountAsAnAnnotation() {
        assertEquals(
            MoteI18n.text("媒体：{0}", "正在整理") + "\n" + imageLabel,
            captureStatusText(null, "正在整理", null, imageLabel),
        )
    }

    @Test fun anEventStatusKeepsTheLocalImageCountAsAnAnnotation() {
        assertEquals("采集已暂停\n$imageLabel", captureStatusText(null, null, "采集已暂停", imageLabel))
    }

    @Test fun anActiveStatusPublishesWithoutALocalImageCount() {
        assertEquals(MoteI18n.text("屏幕：{0}", "正在采集"), captureStatusText("正在采集", null, null, null))
    }
}
