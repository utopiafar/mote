package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LatestWriterTest {
    @Test fun coalescesTypingAndDrainsBeforeTheSubmissionBarrier() {
        val io = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val written = mutableListOf<Int>()
        val writer = LatestWriter<Int>(io) {
            if (it == 0) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            written += it
        }
        try {
            writer.submit(0); assertTrue(entered.await(2, TimeUnit.SECONDS))
            for (i in 1..1000) writer.submit(i)
            val barrier = io.submit<List<Int>> { written.toList() }
            assertFalse(barrier.isDone)
            release.countDown()
            assertEquals(listOf(0, 1000), barrier.get(2, TimeUnit.SECONDS))
            writer.submit(1001)
            assertEquals(listOf(0, 1000, 1001), io.submit<List<Int>> { written.toList() }.get(2, TimeUnit.SECONDS))
        } finally { release.countDown(); io.shutdownNow() }
    }
}
