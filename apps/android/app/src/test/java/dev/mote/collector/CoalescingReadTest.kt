package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class CoalescingReadTest {
    private class ControlledExecutor(private val reject: () -> Boolean = { false }) : Executor {
        val queued = ConcurrentLinkedQueue<Runnable>()
        override fun execute(runnable: Runnable) { if (reject()) throw RejectedExecutionException("generated rejection") else queued.add(runnable) }
        fun runNext() { requireNotNull(queued.poll()).run() }
    }

    @Test fun tenRequestsDuringARealReadMergeIntoOneLatestFollowUp() {
        val executor = ControlledExecutor(); val delivered = mutableListOf<Int>(); val reads = AtomicInteger()
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val state = AtomicInteger(1)
        val reader = CoalescingRead(executor, { delivered += it.getOrThrow() }) {
            if (reads.incrementAndGet() == 1) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            state.get()
        }
        reader.request()
        val worker = Thread { executor.runNext() }.apply { start() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            state.set(2); repeat(10) { reader.request() }
            assertEquals(1, reads.get()); assertTrue(executor.queued.isEmpty())
        } finally { release.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive)
        assertEquals("ten requests reserve only one follow-up", 1, executor.queued.size)
        state.set(3); executor.runNext()
        assertTrue(executor.queued.isEmpty()); assertEquals(2, reads.get()); assertEquals(listOf(2, 3), delivered)
    }

    @Test fun requestsReenteredFromDeliveryShareTheAlreadyPendingFollowUp() {
        val executor = ControlledExecutor(); val values = mutableListOf<Int>(); var reads = 0
        lateinit var reader: CoalescingRead<Int>
        reader = CoalescingRead(executor, { result ->
            values += result.getOrThrow()
            if (values.size == 1) repeat(10) { reader.request() }
        }) { ++reads }
        reader.request(); reader.request(); executor.runNext()
        assertEquals(1, executor.queued.size)
        executor.runNext()
        assertEquals(listOf(1, 2), values); assertTrue("delivery never adds a spurious third read", executor.queued.isEmpty())
    }

    @Test fun executorRejectionDeliversFailureAndDoesNotStickBusy() {
        var rejecting = true; val executor = ControlledExecutor { rejecting }; val delivered = mutableListOf<Result<Int>>()
        val reader = CoalescingRead(executor, { delivered += it }) { 7 }
        reader.request()
        assertEquals(1, delivered.size); assertTrue(delivered.single().isFailure)
        rejecting = false; reader.request(); assertEquals(1, executor.queued.size)
        executor.runNext(); assertEquals(listOf(7), delivered.mapNotNull { it.getOrNull() }); assertTrue(executor.queued.isEmpty())
    }

    @Test fun rejectedFollowUpDropsItsPendingRetryAndAllowsAFutureRequest() {
        var submissions = 0; val executor = ControlledExecutor { ++submissions == 2 }
        val delivered = mutableListOf<Result<Int>>(); var reads = 0
        val reader = CoalescingRead(executor, { delivered += it }) { ++reads }
        reader.request(); repeat(10) { reader.request() }; executor.runNext()
        assertEquals(2, delivered.size); assertTrue(delivered.last().exceptionOrNull() is RejectedExecutionException)
        assertTrue(executor.queued.isEmpty())
        reader.request(); executor.runNext()
        assertEquals(listOf(1, 2), delivered.mapNotNull { it.getOrNull() }); assertTrue(executor.queued.isEmpty())
    }

    @Test fun deliveryFailureStillRunsOnePendingReadAndNeverStaysBusy() {
        val executor = ControlledExecutor(); val delivered = mutableListOf<Int>(); var reads = 0
        val reader = CoalescingRead(executor, { result ->
            if (result.getOrThrow() == 1) throw IllegalStateException("generated delivery failure")
            delivered += result.getOrThrow()
        }) { ++reads }
        reader.request(); reader.request(); executor.runNext()
        assertEquals(1, executor.queued.size); executor.runNext()
        assertEquals(listOf(2), delivered); assertTrue(executor.queued.isEmpty())
        reader.request(); executor.runNext(); assertEquals(listOf(2, 3), delivered)
    }

    @Test fun closeBlocksQueuedWorkAndLaterRequests() {
        val executor = ControlledExecutor(); val delivered = mutableListOf<Result<Int>>(); var reads = 0
        val reader = CoalescingRead(executor, { delivered += it }) { ++reads }
        reader.request(); reader.close(); reader.request(); executor.runNext()
        assertEquals(0, reads); assertTrue(delivered.isEmpty()); assertTrue(executor.queued.isEmpty())
    }

    @Test fun closeWhileReadingDropsTheInFlightResultAndMergedFollowUp() {
        val executor = ControlledExecutor(); val delivered = mutableListOf<Result<Int>>(); val reads = AtomicInteger()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val reader = CoalescingRead(executor, { delivered += it }) {
            reads.incrementAndGet(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); 9
        }
        reader.request(); val worker = Thread { executor.runNext() }.apply { start() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS)); repeat(10) { reader.request() }; reader.close(); reader.request()
        } finally { release.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive); assertEquals(1, reads.get()); assertTrue(delivered.isEmpty()); assertTrue(executor.queued.isEmpty())
    }

    @Test fun closingInsideDeliveryCancelsAnAlreadyRequestedFollowUp() {
        val executor = ControlledExecutor(); var calls = 0; lateinit var reader: CoalescingRead<Int>
        reader = CoalescingRead(executor, { calls++; reader.close() }) { 1 }
        reader.request(); reader.request(); executor.runNext()
        assertEquals(1, calls); assertTrue(executor.queued.isEmpty()); reader.request(); assertTrue(executor.queued.isEmpty())
    }

    @Test fun readFailureIsDeliveredAndAPendingReadCanRecoverTheLastValue() {
        val executor = ControlledExecutor(); val delivered = mutableListOf<Result<Int>>(); var reads = 0
        val reader = CoalescingRead(executor, { delivered += it }) {
            if (++reads == 1) throw java.io.IOException("generated offline read") else 5
        }
        reader.request(); reader.request(); executor.runNext(); executor.runNext()
        assertEquals(2, delivered.size); assertTrue(delivered[0].isFailure); assertEquals(5, delivered[1].getOrThrow()); assertTrue(executor.queued.isEmpty())
    }
}
