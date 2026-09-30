package dev.mote.collector

import androidx.work.NetworkType
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
    @Test fun loopbackTransportDoesNotRequireValidatedInternet() {
        for (server in listOf("http://127.0.0.1:58161", "https://127.0.0.1/", "http://localhost:47842", "https://LOCALHOST", "http://[::1]:47842/")) {
            for (wifiOnly in listOf(false, true)) {
                assertEquals(server, NetworkType.NOT_REQUIRED, SyncNetworkPolicy.requiredNetworkType(server, wifiOnly))
            }
        }
    }
    @Test fun automaticRemoteAndInvalidLocalUrlsRetainConnectedConstraint() {
        for (server in listOf("https://central.example", "http://10.0.2.2:47842", "http://127.0.0.2", "http://localhost.example", "http://127.0.0.1.example", "http://127.0.0.1@central.example", "http://central.example@127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1/path", "http://127.0.0.1?query", "http://127.0.0.1#fragment", "file://localhost", "not a URL")) {
            assertEquals(server, NetworkType.CONNECTED, SyncNetworkPolicy.requiredNetworkType(server, wifiOnly = false))
        }
    }
    @Test fun explicitRemoteHttpAttemptPreservesWifiChargingAndBatteryRestrictions() {
        for (wifiOnly in listOf(false, true)) {
            assertEquals(NetworkType.NOT_REQUIRED, SyncNetworkPolicy.requiredNetworkType("https://central.example", wifiOnly, explicit = true))
        }
        for (server in listOf("https://central.example", "http://127.0.0.1:58161")) {
            for (explicit in listOf(false, true)) {
                val conditions = SyncConditions(true, true, true)
                assertEquals("等待充电", conditions.waitingReason(false, false, true))
                assertEquals("等待电量恢复", conditions.waitingReason(true, true, true))
                assertEquals("等待非计费 Wi-Fi", conditions.waitingReason(true, false, false))
                assertNull(conditions.waitingReason(true, false, true))
            }
        }
        assertEquals(NetworkType.UNMETERED, SyncNetworkPolicy.requiredNetworkType("https://central.example", wifiOnly = true))
    }
    @Test fun runnableLocalAndManualRequestsStillPauseWhenWifiDisappears() {
        val conditions = SyncConditions(false, false, true)
        for ((server, explicit) in listOf("http://127.0.0.1:58161" to false, "https://central.example" to true)) {
            assertEquals(NetworkType.NOT_REQUIRED, SyncNetworkPolicy.requiredNetworkType(server, wifiOnly = true, explicit = explicit))
            assertNull(conditions.waitingReason(charging = false, batteryLow = null, unmeteredWifi = true))
            assertEquals("等待非计费 Wi-Fi", conditions.waitingReason(charging = false, batteryLow = null, unmeteredWifi = false))
            assertNull(conditions.waitingReason(charging = false, batteryLow = null, unmeteredWifi = true))
        }
    }
    @Test fun workRequestConstraintsPreservePowerFlagsForLocalAndManualSync() {
        for ((server, explicit) in listOf("http://127.0.0.1:58161" to false, "https://central.example" to true)) {
            for (chargingOnly in listOf(false, true)) for (batteryNotLow in listOf(false, true)) {
                val config = CollectorConfig(deviceName = "Generated fixture", server = server, wifiOnly = true,
                    syncChargingOnly = chargingOnly, syncBatteryNotLow = batteryNotLow)
                val constraints = SyncSchedule.constraints(config, explicit)
                assertEquals(NetworkType.NOT_REQUIRED, constraints.requiredNetworkType)
                assertEquals(chargingOnly, constraints.requiresCharging())
                assertEquals(batteryNotLow, constraints.requiresBatteryNotLow())
            }
        }
    }
}
