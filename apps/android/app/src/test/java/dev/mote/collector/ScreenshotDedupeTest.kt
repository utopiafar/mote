package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class ScreenshotDedupeTest {
    @Test fun modesAndDimensions() {
        val h = ScreenshotDedupeHelper
        val pixels = IntArray(96 * 96) { 0xff303030.toInt() }
        val first = h.buildFeatures(96, 96, pixels)
        for (mode in ScreenshotDedupeHelper.Mode.entries) {
            assertFalse(h.shouldSkip(null, first, mode).duplicate)
            assertTrue(h.shouldSkip(first.toSignature(), first, mode).duplicate)
            assertFalse(h.shouldSkip(first.toSignature(), h.buildFeatures(96, 96, IntArray(96 * 96) { -1 }), mode).duplicate)
        }
        pixels[0]++
        val changed = h.buildFeatures(96, 96, pixels)
        assertFalse(h.shouldSkip(first.toSignature(), changed, ScreenshotDedupeHelper.Mode.EXACT).duplicate)
        assertTrue(h.shouldSkip(first.toSignature(), changed, ScreenshotDedupeHelper.Mode.CONSERVATIVE).duplicate)
        val tiny = h.buildFeatures(1, 1, intArrayOf(0))
        assertEquals(1024, tiny.thumb.size)
        assertFalse(h.shouldSkip("invalid", tiny, ScreenshotDedupeHelper.Mode.BALANCED).duplicate)
        assertFalse(h.shouldSkip(first.toSignature(), tiny, ScreenshotDedupeHelper.Mode.AGGRESSIVE).duplicate)
        assertEquals(1000, h.sampleSizeForMode(1000, 500, ScreenshotDedupeHelper.Mode.EXACT).width)
        assertEquals(96, h.sampleSizeForMode(1000, 500, ScreenshotDedupeHelper.Mode.BALANCED).width)
    }
}
