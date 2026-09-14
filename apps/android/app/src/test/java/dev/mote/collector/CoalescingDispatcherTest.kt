package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque
import java.util.concurrent.Executor

class CoalescingDispatcherTest {
    private class ManualExecutor : Executor {
        val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.addLast(command) }
        fun next() = tasks.removeFirst().run()
    }
    @Test fun slowSchedulingKeepsOnlyOneFollowUpAndPreservesManualIntent() {
        val executor = ManualExecutor(); val handled = mutableListOf<ScheduleIntent>()
        lateinit var dispatcher: CoalescingDispatcher<ScheduleIntent>
        dispatcher = CoalescingDispatcher(executor, ScheduleIntent::merge) { request ->
            handled += request
            if (handled.size == 1) {
                // Simulate repeated service ticks/user requests while the first scan is busy.
                repeat(10_000) { index -> dispatcher.submit(ScheduleIntent("same connection", explicit = index == 2, manualScan = index == 3)) }
                assertTrue("Busy work must not enqueue one executor task per tick", executor.tasks.isEmpty())
            }
        }
        dispatcher.submit(ScheduleIntent("same connection"))
        executor.next()
        assertEquals(1, executor.tasks.size)
        executor.next()
        assertEquals(listOf(ScheduleIntent("same connection"), ScheduleIntent("same connection", explicit = true, manualScan = true)), handled)
        assertTrue(executor.tasks.isEmpty())
    }
    @Test fun changingConnectionOrPolicyDoesNotCarryExplicitUploadIntoNewSettings() {
        val executor = ManualExecutor(); val handled = mutableListOf<ScheduleIntent>()
        val dispatcher = CoalescingDispatcher(executor, ScheduleIntent::merge) { handled += it }
        dispatcher.submit(ScheduleIntent("old node", explicit = true, manualScan = true))
        dispatcher.submit(ScheduleIntent("new node, manual sync"))
        executor.next()
        assertEquals(listOf(ScheduleIntent("new node, manual sync")), handled)
        dispatcher.submit(ScheduleIntent("new node, manual sync", explicit = true))
        dispatcher.submit(ScheduleIntent("new node, manual sync"))
        executor.next()
        assertTrue(handled.last().explicit)
        assertFalse(handled.last().manualScan)
    }
    @Test fun failedWorkDoesNotStrandFollowUpOrFutureRequests() {
        val executor = ManualExecutor(); val handled = mutableListOf<String>()
        lateinit var dispatcher: CoalescingDispatcher<String>
        dispatcher = CoalescingDispatcher(executor, { _, next -> next }) { request ->
            handled += request
            if (request == "first") { dispatcher.submit("follow-up"); throw IllegalStateException("generated failure") }
        }
        dispatcher.submit("first")
        assertThrows(IllegalStateException::class.java) { executor.next() }
        executor.next()
        dispatcher.submit("later"); executor.next()
        assertEquals(listOf("first", "follow-up", "later"), handled)
        assertTrue(executor.tasks.isEmpty())
    }
}
