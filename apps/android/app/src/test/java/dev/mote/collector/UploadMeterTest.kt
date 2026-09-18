package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class UploadMeterTest {
    @Test fun includesTransportBytesAndFallsToZeroWhenIdle() {
        UploadMeter.rate(10000)
        UploadMeter.add(2048, 10001)
        UploadMeter.add(1024, 11000)
        assertEquals(1536.0, UploadMeter.rate(11001), 0.0)
        assertEquals(512.0, UploadMeter.rate(12001), 0.0)
        assertEquals(0.0, UploadMeter.rate(13001), 0.0)
    }
}
