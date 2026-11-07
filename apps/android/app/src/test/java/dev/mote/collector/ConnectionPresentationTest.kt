package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionPresentationTest {
    @Test fun invalidInvitationsUseExactExpiredCopyAndReturnToStart() {
        for (category in listOf("invitation", "expired", "invite_rejected")) {
            assertTrue(category, ConnectionPresentation.isInvalidInvitation(category))
            assertEquals(ConnectionPresentation.Surface.START_INVALID, ConnectionPresentation.surface(category))
            assertEquals(MoteI18n.text("邀请已失效"), ConnectionPresentation.message(category))
            assertEquals(MoteI18n.text("邀请已失效"), ConnectionPresentation.visibleNotice(category))
        }
        assertEquals(MoteI18n.text("扫描二维码"), ConnectionPresentation.scanQr)
    }

    @Test fun connectingAndIncompleteMatchIosConnectionView() {
        assertEquals(MoteI18n.text("正在连接…"), ConnectionPresentation.connecting)
        assertEquals(MoteI18n.text("连接未完成"), ConnectionPresentation.incomplete)
        assertEquals(MoteI18n.text("重试"), ConnectionPresentation.retry)
        assertEquals(MoteI18n.text("确认连接"), ConnectionPresentation.confirm)
        assertEquals(MoteI18n.text("连接未完成"), ConnectionPresentation.message("unknown-failure"))
        assertEquals(ConnectionPresentation.Surface.REVIEW_INCOMPLETE, ConnectionPresentation.surface("network"))
        assertEquals(MoteI18n.text("连接未完成"), ConnectionPresentation.visibleNotice("network"))
        assertEquals(MoteI18n.text("连接未完成"), ConnectionPresentation.visibleNotice("response"))
    }

    @Test fun confirmPageListsSelfDeviceAndPendingSendCount() {
        assertEquals(MoteI18n.text("本人设备"), ConnectionPresentation.selfDevice)
        assertEquals(MoteI18n.text("连接后发送"), ConnectionPresentation.pendingSend)
        assertEquals(MoteI18n.text("{0} 条记录", 0), ConnectionPresentation.pendingCountLabel(0))
        assertEquals(MoteI18n.text("{0} 条记录", 3), ConnectionPresentation.pendingCountLabel(3))
        assertEquals(MoteI18n.text("暂时无法读取"), ConnectionPresentation.pendingCountLabel(null))
    }

    @Test fun operationalBlockersKeepAnHonestDetailedMessage() {
        assertEquals(ConnectionPresentation.Surface.REVIEW_DETAIL, ConnectionPresentation.surface("pending"))
        assertEquals(ConnectionPresentation.Surface.REVIEW_DETAIL, ConnectionPresentation.surface("device_conflict"))
        assertEquals(ConnectionPresentation.Surface.REVIEW_DETAIL, ConnectionPresentation.surface("storage"))
        assertFalse(ConnectionPresentation.isInvalidInvitation("network"))
        assertEquals(
            MoteI18n.text("仍有截图/笔记/来源待同步或已准备提交的草稿，不能切换节点。请先同步原节点。"),
            ConnectionPresentation.message("pending"),
        )
        assertEquals(ConnectionActivity.message("pending"), ConnectionPresentation.message("pending"))
        assertEquals(ConnectionActivity.message("expired"), ConnectionPresentation.invalidInvitation)
    }
}
