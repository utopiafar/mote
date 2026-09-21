package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test

class UploadNegotiationTest {
    @Test fun sizeLimitShrinksWithoutAcknowledgingTheUnsentTail() {
        val attempts=mutableListOf<Int>()
        val result=UploadNegotiation.sendShrinking((0 until 500).toList()) { batch -> attempts.add(batch.size);(if(batch.size>20)413 else 200) to "receipt" }
        assertEquals(listOf(500,250,125,63,32,16),attempts)
        assertEquals((0 until 16).toList(),result.first)
        assertEquals(200,result.second.first)
    }
    @Test fun rejectionDoesNotNegotiateAndSingleOversizeIsRetained() {
        for(status in listOf(401,403,429,500)) {
            var calls=0
            val result=UploadNegotiation.sendShrinking(listOf(1,2,3)) { calls++;status to "rejected" }
            assertEquals(1,calls);assertEquals(3,result.first.size);assertFalse(UploadNegotiation.unsupported(status))
        }
        var attempts=0
        val result=UploadNegotiation.sendShrinking(listOf(1)) { attempts++;413 to "oversize" }
        assertEquals(1,attempts);assertEquals(413,result.second.first);assertFalse(UploadNegotiation.unsupported(413))
        assertTrue(UploadNegotiation.unsupported(404));assertTrue(UploadNegotiation.unsupported(405))
    }
}
