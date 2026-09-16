package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class BulkDedupePerformanceTest {
    @Test fun twoThousandFastRecordsPublishBoundedProgressIncludingStageAndCompletion() {
        val progress = BulkDedupeProgress()
        assertTrue(progress.shouldPublish("scan", 0, 2000, 0))
        val updates = (1..2000).count { progress.shouldPublish("scan", it, 2000, it.toLong()) }
        assertEquals(8, updates)
        assertTrue(progress.shouldPublish("resolve", 0, 1000, 2001))
        assertFalse(progress.shouldPublish("resolve", 999, 1000, 2002))
        assertTrue(progress.shouldPublish("resolve", 1000, 1000, 2003))
    }

    @Test fun repeatedBlobsReuseFeaturesWhileOldFeaturesAreEvicted() {
        val features = ScreenshotDedupeHelper.buildFeatures(1, 1, intArrayOf(-1))
        val cache = BulkDedupeFeatureCache(2)
        var reads = 0
        fun load(blob: String) = cache.getOrPut(blob) { reads++; BulkDedupeFeatureCache.Entry(features, 42) }
        repeat(2000) { assertEquals(42, load("shared").imageBytes) }
        assertEquals(1, reads)
        load("second"); load("shared"); load("third")
        assertEquals(3, reads)
        load("shared")
        assertEquals(3, reads)
        load("second")
        assertEquals(4, reads)
    }
}
