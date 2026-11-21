package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CentralMemoryJobPresentationTest {
    @Test fun sourceRevisionMakesTheHistoricalTaskReadableWithoutRetryControls() {
        val job = JSONObject("""{"status":"failed","outcome":"input_invalidated","failedBatches":0,"invalidatedBatches":1,"errorCode":"evidence_changed"}""")
        assertTrue(CentralMemoryJobPresentation.invalidated(job))
        assertEquals("资料已更新，本次结果失效", CentralMemoryJobPresentation.status(job))
        val notice = CentralMemoryJobPresentation.notice(job).orEmpty()
        assertTrue("The history is retained", notice.contains("历史结果保留"))
        assertTrue("The notice points to current material", notice.contains("当前资料"))
        assertTrue(CentralMemoryJobPresentation.controls(job).isEmpty())
        assertEquals("The presentation must not rewrite historical scheduling state", "failed", job.getString("status"))
    }

    @Test fun aMixedTaskKeepsItsActualProcessingFailureAndRetry() {
        val job = JSONObject("""{"status":"failed","outcome":"processing_failed","failedBatches":1,"invalidatedBatches":1,"errorCode":"memory_capacity_saturated"}""")
        assertFalse(CentralMemoryJobPresentation.invalidated(job))
        assertEquals("failed", CentralMemoryJobPresentation.status(job))
        assertNull(CentralMemoryJobPresentation.notice(job))
        assertTrue(CentralMemoryJobPresentation.controls(job).any { it.first == "retry" })
    }

    @Test fun olderCentralReceiptsAreNotReclassifiedFromErrorCodesOrCounts() {
        val job = JSONObject("""{"status":"failed","failedBatches":1,"invalidatedBatches":1,"errorCode":"evidence_changed"}""")
        assertFalse(CentralMemoryJobPresentation.invalidated(job))
        assertEquals("failed", CentralMemoryJobPresentation.status(job))
        assertNull(CentralMemoryJobPresentation.notice(job))
        assertEquals(listOf("pause", "resume", "cancel", "retry"), CentralMemoryJobPresentation.controls(job).map { it.first })
    }
}
