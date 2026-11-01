package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

/**
 * Drives the gate through the same call sequence the three home views perform:
 * `adopt` on each refresh, `due`/`begin` to claim a read, `current` before a late result applies,
 * `success`/`failure` for the outcome, `wake` when the home is hidden.
 */
class HomeReadGateTest {

    /** Mirrors the four lines every home view runs around its read task. */
    private class Section(val gate: HomeReadGate = HomeReadGate()) {
        var busy = false
        var reads = 0
        fun refresh(now: Long): Long? {
            val stamp = if (busy || !gate.due(now)) return null else gate.begin(now)
            busy = true; reads++
            return stamp
        }
        fun finish(stamp: Long?, now: Long, failureStatus: Int? = null) {
            busy = false
            if (stamp == null || !gate.current(stamp)) return
            if (failureStatus == null) gate.success(now) else gate.failure(now, failureStatus)
        }
    }

    @Test fun twoSecondHeartbeatsReadAtMostEverySixtySeconds() {
        val section = Section()
        assertTrue(section.gate.adopt(1, "https://central"))
        var claims = 0
        for (tick in 0L..60_000L step 2_000L) section.refresh(tick)?.let { claims++; section.finish(it, tick) }
        assertEquals("Reads claim at t=0 and t=60s only", 2, claims)
        assertFalse(section.gate.due(119_999))
        assertTrue(section.gate.due(120_000))
    }

    @Test fun returningToTheHomeReadsImmediately() {
        val section = Section()
        section.gate.adopt(1, "https://central")
        section.finish(section.refresh(0), 0)
        assertFalse("a steady read is not yet due", section.gate.due(1_000))
        section.gate.wake()
        assertTrue("the first refresh after returning reads at once", section.gate.due(1_000))
        section.finish(section.refresh(1_000), 1_000)
        assertEquals("The return read keeps the steady cadence", 2, section.reads)
        assertFalse(section.gate.due(60_999))
        assertTrue(section.gate.due(61_000))
    }

    @Test fun failuresBackOffUntilASuccessRestoresTheCadence() {
        val section = Section()
        section.gate.adopt(1, "https://central")
        var now = 0L
        for (expected in listOf(120_000L, 240_000L, 300_000L, 300_000L)) {
            val stamp = section.refresh(now) ?: error("expected a due read at $now")
            section.finish(stamp, now, 500)
            assertFalse("backoff $expected not reached", section.gate.due(now + expected - 1))
            assertTrue("backoff $expected reached", section.gate.due(now + expected))
            now += expected
        }
        section.finish(section.refresh(now), now)
        assertTrue("a success returns to the steady interval", section.gate.due(now + 60_000))
        assertFalse(section.gate.due(now + 59_999))
    }

    @Test fun a403StopsUntilRetryOrAnAuthorizationChange() {
        val section = Section()
        section.gate.adopt(1, "https://central")
        section.finish(section.refresh(0), 0, 403)
        assertFalse(section.gate.due(60_000))
        assertFalse(section.gate.due(600_000))
        section.gate.wake()
        assertFalse("leaving and returning must not revive a 403 stop", section.gate.due(600_000))
        section.gate.invalidate()
        assertFalse("an unresolved connection must not revive a 403 stop", section.gate.due(600_000))
        assertFalse("the same generation keeps the stop", section.gate.adopt(1, "https://central"))
        assertFalse(section.gate.due(600_000))
        assertTrue("a new session or authorization generation resumes reading", section.gate.adopt(2, "https://central"))
        assertTrue(section.gate.due(600_000))
        section.finish(section.refresh(600_000), 600_000)
    }

    @Test fun anExplicitRetryRecoversA403WithTheSameSession() {
        // Same session, server-side permission repaired: only the explicit retry entry re-arms the block.
        val section = Section()
        section.gate.adopt(1, "https://central")
        section.finish(section.refresh(0), 0, 403)
        assertFalse("a repaired permission alone does not resume the stopped block", section.gate.due(600_000))
        section.gate.retry()
        assertTrue("the owner retry re-reads at once", section.gate.due(600_000))
        section.finish(section.refresh(600_000), 600_000)
        assertEquals(2, section.reads)
        assertFalse("a recovered read returns to the steady cadence", section.gate.due(659_999))
        assertTrue(section.gate.due(660_000))
        section.finish(section.refresh(660_000), 660_000, 403)
        assertFalse("a still-denied retry stops again", section.gate.due(1_000_000))
    }

    @Test fun lateResultsDoNotCrossGenerations() {
        val section = Section()
        section.gate.adopt(1, "https://central")
        val stale = section.refresh(0)
        section.gate.adopt(2, "https://central")
        assertFalse("a read started before the generation change is stale", section.gate.current(stale!!))
        section.finish(stale, 500)
        assertTrue("a dropped late result never reschedules", section.gate.due(500))
        val paused = section.refresh(500)!!
        section.gate.wake()
        assertFalse("a read in flight while the home hid is stale", section.gate.current(paused))
        section.finish(paused, 600, 403)
        assertTrue("a dropped late failure cannot stop the block", section.gate.due(600))
    }

    @Test fun emptyArchiveProbeRunsOnceUntilItFindsData() {
        val gate = HomeReadGate()
        gate.adopt(1, "https://central")
        val stamp = gate.begin(0)
        var probes = 0
        val probe = { probes++; true }
        assertTrue(gate.archiveEmpty(true, stamp, 0, probe))
        assertEquals(1, probes)
        repeat(10) { assertTrue("the empty answer is reused between probes", gate.archiveEmpty(true, stamp, 299_999, probe)) }
        assertEquals("an empty archive is rechecked at most every five minutes", 1, probes)
        assertTrue(gate.archiveEmpty(true, stamp, 300_000, probe))
        assertEquals(2, probes)
        probes = 0
        val populated = { probes++; false }
        assertFalse("a populated archive is not empty", gate.archiveEmpty(true, stamp, 600_000, populated))
        assertEquals(1, probes)
        repeat(10) { assertFalse(gate.archiveEmpty(true, stamp, 700_000 + it * 300_000L, populated)) }
        assertEquals("once data exists the probe never runs again this generation", 1, probes)
        probes = 0
        gate.adopt(2, "https://central")
        assertTrue(gate.archiveEmpty(true, gate.begin(800_000), 800_000, probe))
        assertEquals("a generation change probes again", 1, probes)
    }

    @Test fun anInFlightProbeCannotCommitIntoTheNextGeneration() {
        // Mirrors a worker thread running the archive probe while the UI thread adopts a new
        // connection: the old probe's answer must not mark the new generation done.
        val gate = HomeReadGate()
        gate.adopt(1, "https://central")
        var probes = 0
        assertFalse(gate.archiveEmpty(true, gate.begin(0), 0) {
            probes++
            gate.adopt(2, "https://central")
            false
        })
        assertEquals(1, probes)
        probes = 0
        assertTrue("the populated answer must not mark the new generation done", gate.archiveEmpty(true, gate.begin(1_000), 1_000) { probes++; true })
        assertEquals("the new generation runs its own probe", 1, probes)
    }

    @Test fun anInconclusiveProbeRetriesOnTheNextRead() {
        val gate = HomeReadGate()
        gate.adopt(1, "https://central")
        val stamp = gate.begin(0)
        var probes = 0
        val failing = { probes++; error("offline") }
        assertFalse(gate.archiveEmpty(true, stamp, 0, failing))
        assertFalse("an inconclusive probe does not claim an empty archive", gate.archiveEmpty(true, stamp, 59_999, failing))
        gate.archiveEmpty(true, stamp, 60_000, failing)
        assertEquals("the probe retries on the next steady read", 2, probes)
        assertFalse("non-empty rows never probe", gate.archiveEmpty(false, stamp, 60_000) { error("must not run") })
    }

    @Test fun anInconclusiveProbeRecheckClearsTheEmptyConfirmation() {
        // A confirmed-empty archive whose recheck fails is unknown, not empty.
        val gate = HomeReadGate()
        gate.adopt(1, "https://central")
        val stamp = gate.begin(0)
        assertTrue(gate.archiveEmpty(true, stamp, 0) { true })
        assertTrue("the confirmed answer is reused until the recheck", gate.archiveEmpty(true, stamp, 299_999) { error("must not run") })
        var probes = 0
        val failing = { probes++; error("offline") }
        assertFalse("a failed recheck withdraws the empty confirmation", gate.archiveEmpty(true, stamp, 300_000, failing))
        assertEquals(1, probes)
        assertFalse("the inventory stays unknown while the failure repeats", gate.archiveEmpty(true, stamp, 360_000, failing))
        assertTrue("a recovered probe can confirm the archive empty again", gate.archiveEmpty(true, stamp, 420_000) { true })
    }

    @Test fun aDeniedProbeFailsTheReadWithoutCommittingTheStop() {
        // The probe rethrows on the worker thread; a pause before the UI callback drops the
        // outcome and must not strand a stop — the UI failure path applies it instead.
        val gate = HomeReadGate()
        gate.adopt(1, "https://central")
        val stamp = gate.begin(0)
        val thrown = assertThrows(CentralFailure::class.java) { gate.archiveEmpty(true, stamp, 0) { throw CentralFailure(403) } }
        assertEquals(403, thrown.status)
        gate.wake()
        assertTrue("a denied probe dropped by a pause leaves the gate unstopped", gate.due(1))
        gate.begin(1)
        gate.failure(60_000, 403)
        assertFalse("the UI failure path applies the stop", gate.due(60_000))
        assertFalse("the stop survives leaving and returning", run { gate.wake(); gate.due(600_000) })
        assertTrue("the explicit retry re-arms reads and the probe", gate.retry().let { gate.due(600_000) })
        assertTrue(gate.archiveEmpty(true, gate.begin(600_000), 600_000) { true })
    }

    @Test fun logicalReadsAreNotTotalHttpRequests() {
        // Conversation: 1 page + up to 3 probe calls. Calendar: up to 5 pages. Discovery: 1 call.
        val conversations = Section(); val discovery = Section(); val calendar = Section()
        var http = 0
        for (tick in 0L..60_000L step 2_000L) {
            conversations.refresh(tick)?.let { stamp ->
                http += 1
                if (conversations.gate.archiveEmpty(true, stamp, tick) { http += 3; true }) Unit
                conversations.finish(stamp, tick)
            }
            discovery.refresh(tick)?.let { stamp -> http += 1; discovery.finish(stamp, tick) }
            calendar.refresh(tick)?.let { stamp -> http += 5; calendar.finish(stamp, tick) }
        }
        assertEquals("each block claims at most two logical reads per minute", 2, maxOf(conversations.reads, discovery.reads, calendar.reads))
        assertTrue("the five-page scan and the archive probe keep their full fan-out beyond six requests", http > 6)
        assertEquals("t=0: 1+3 probe + 1 + 5 pages; t=60s: 1 + 1 + 5 pages", 10 + 7, http)
    }

    @Test fun aBusyBlockDoesNotDoubleRead() {
        val section = Section()
        section.gate.adopt(1, "https://central")
        val stamp = section.refresh(0)!!
        assertNull("an in-flight read blocks the next claim", section.refresh(1_000))
        section.finish(stamp, 1_000)
        assertFalse(section.gate.due(60_999))
        assertTrue(section.gate.due(61_000))
    }
}
