package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class SyncConditionsTest {
    @Test fun unpluggingPausesAndReconnectingOnlyResumesWhenEveryConditionIsMet() {
        val conditions = SyncConditions(true, true, true)
        assertNull(conditions.waitingReason(true, false, true))
        assertEquals("等待充电", conditions.waitingReason(false, false, true))
        assertEquals("等待非计费 Wi-Fi", conditions.waitingReason(true, false, false))
        assertEquals("等待电量恢复", conditions.waitingReason(true, true, true))
        assertNull(conditions.waitingReason(true, false, true))
    }
    @Test fun unknownBatteryWaitsOnlyWhenRestrictedAndDisabledConditionsAllowBatteryAndMobileData() {
        assertEquals("等待电量恢复", SyncConditions(false, true, false).waitingReason(false, null, false))
        assertNull(SyncConditions(false, false, false).waitingReason(false, null, false))
    }
    @Test fun explicitDispatchSkipsTimeButStillWaitsForCharging() {
        for (mode in listOf("manual", "realtime", "interval", "batch")) {
            assertEquals(0L, SyncPolicy(mode).delayMillis(2000000, 1, 1999999, 1999999, explicit = true))
            assertEquals("等待充电", SyncConditions(true, false, false).waitingReason(false, false, true))
        }
    }
}
