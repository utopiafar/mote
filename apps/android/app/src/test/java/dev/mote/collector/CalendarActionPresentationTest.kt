package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class CalendarActionPresentationTest {
    @Test fun receivedSuccessDescribesItsActualOperationRatherThanAlwaysAnAddition() {
        assertEquals("已写入日历",CalendarActionPresentation.stateKey("calendar.create","succeeded"))
        assertEquals("已更新日历",CalendarActionPresentation.stateKey("calendar.update","succeeded"))
        assertEquals("已取消日程",CalendarActionPresentation.stateKey("calendar.cancel","succeeded"))
        assertEquals("已标记完成",CalendarActionPresentation.stateKey("calendar.complete","succeeded"))
    }
    @Test fun laterResolutionAndPendingCancellationDoNotRevertToTheOriginalSuccess() {
        assertEquals("已取消",CalendarActionPresentation.stateKey("calendar.create","succeeded",resolution="cancelled"))
        assertEquals("已标记完成",CalendarActionPresentation.stateKey("calendar.create","succeeded",resolution="completed"))
        assertEquals("已请求取消，写入结果仍待核实",CalendarActionPresentation.stateKey("calendar.cancel","executing",managedState="cancel_requested"))
        assertEquals("已取消等待执行",CalendarActionPresentation.stateKey("calendar.create","approved",managedState="cancelled"))
    }
    @Test fun pendingAndUncertainStatesNeverClaimASuccessfulCalendarWrite() {
        for(kind in listOf("calendar.create","calendar.update","calendar.cancel","calendar.complete")) {
            assertEquals("等待客户端写入",CalendarActionPresentation.stateKey(kind,"approved"))
            assertEquals("等待保存回执",CalendarActionPresentation.stateKey(kind,"executing"))
            assertEquals("保存结果待核实",CalendarActionPresentation.stateKey(kind,"uncertain"))
        }
        assertEquals("等待已授权设备",CalendarActionPresentation.stateKey("calendar.create","approved",managedState="waiting_device"))
        assertEquals("已写入日历",CalendarActionPresentation.stateKey("calendar.create","succeeded",managedState="waiting_device"))
        assertNull(CalendarActionPresentation.stateKey("calendar.create","unrecognized"))
    }
    @Test fun aMessageProposalOnlyClaimsSuccessFromARealReceipt() {
        assertEquals("待确认",CalendarActionPresentation.stateKey("message.send","proposed"))
        assertEquals("等待客户端写入",CalendarActionPresentation.stateKey("message.send","approved"))
        assertEquals("等待保存回执",CalendarActionPresentation.stateKey("message.send","executing"))
        assertEquals("保存结果待核实",CalendarActionPresentation.stateKey("message.send","uncertain"))
        assertEquals("已完成",CalendarActionPresentation.stateKey("message.send","succeeded"))
        assertEquals("原文已更新或删除",CalendarActionPresentation.stateKey("message.send","stale"))
        assertNull(CalendarActionPresentation.stateKey("message.send","unrecognized"))
    }
}
