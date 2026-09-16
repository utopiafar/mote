package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class SyncPolicyTest {
    private val now = 2_000_000L
    @Test fun manualNeverAutomaticallyDispatchesEvenAFullOldQueue() {
        assertNull(SyncPolicy("manual").delayMillis(now, 500, 1, 0))
        assertEquals(0L, SyncPolicy("manual").delayMillis(now, 500, 1, 0, explicit = true))
    }
    @Test fun realtimeDispatchesDataButNeverAnEmptySession() {
        assertEquals(0L, SyncPolicy().delayMillis(now, 1, now, 0))
        assertNull(SyncPolicy().delayMillis(now, 0, null, now))
        assertNull(SyncPolicy("interval").delayMillis(now, 0, null, 1))
        assertEquals(0L, SyncPolicy().delayMillis(now, 0, null, now, pendingUpdates = 1))
    }
    @Test fun intervalWaitsFromLastDispatchAndExplicitFlushOverridesIt() {
        val policy = SyncPolicy("interval", 30)
        assertEquals(1_799_000L, policy.delayMillis(now, 30, now - 5_000, now - 1_000))
        assertEquals(0L, policy.delayMillis(now, 1, now, now - 1_800_000))
        assertEquals(0L, policy.delayMillis(now, 1, now, now, explicit = true))
    }
    @Test fun batchThresholdAndAgeEachReleasePendingData() {
        val policy = SyncPolicy("batch", 15, 20)
        assertEquals(0L, policy.delayMillis(now, 20, now, now))
        assertEquals(899_000L, policy.delayMillis(now, 19, now - 1_000, 0))
        assertEquals(0L, policy.delayMillis(now, 1, now - 900_000, now))
        assertNull(policy.delayMillis(now, 0, null, 0))
    }
    @Test fun firstIntervalUsesOldestPendingInsteadOfDelayingAgainOnEveryNewRecord() {
        val policy = SyncPolicy("interval", 15)
        assertEquals(898_000L, policy.delayMillis(now, 1, now - 2_000, 0))
        assertEquals(897_000L, policy.delayMillis(now + 1_000, 2, now - 2_000, 0))
        assertEquals(0L, policy.delayMillis(now + 900_000, 3, now - 2_000, 0))
    }
    @Test fun invalidSchedulingPreferencesFailBeforeScheduling() {
        listOf(SyncPolicy("unknown"), SyncPolicy(intervalMinutes = 14), SyncPolicy(intervalMinutes = 1441), SyncPolicy(batchSize = 0), SyncPolicy(batchSize = 501))
            .forEach { assertThrows(IllegalArgumentException::class.java) { it.validate() } }
    }
    @Test fun metadataOnlySourceChangesHaveADeadlineButDoNotInflateRecordThresholds() {
        val policy = SyncPolicy("batch", 15, 20)
        assertEquals(899_000L, policy.delayMillis(now, 0, now - 1_000, 0, pendingUpdates = 50))
        assertEquals(0L, policy.delayMillis(now, 0, now - 900_000, 0, pendingUpdates = 1))
    }
}
