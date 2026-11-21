package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class ImageDedupeDiagnosticsDetailsTest {
    @Test fun recordsActualAlgorithmMeasurementsAndDistinguishesSampleMatchesFromFullImageMatches() {
        val helper = ScreenshotDedupeHelper
        val pixels = IntArray(96 * 96) { 0xffeeeeee.toInt() }
        val reference = helper.buildFeatures(96, 96, pixels)
        val identical = helper.shouldSkip(reference.toSignature(), reference, ScreenshotDedupeHelper.Mode.BALANCED)
        fun metadata(mode: ScreenshotDedupeHelper.Mode, result: ScreenshotDedupeHelper.CompareResult) = ImageDedupeDiagnosticsDetails.metadata(
            mode, result, "reference-id", "2026-09-15T00:00:00Z", "capture-id", "2026-09-15T00:00:30Z", "generated.fixture", 1280, 1280, 96, 96)
        val exactSample = metadata(ScreenshotDedupeHelper.Mode.BALANCED, identical)
        assertEquals(100.0, exactSample.getDouble("hashSimilarityPercent"), 0.0)
        assertEquals(8, exactSample.getJSONObject("thresholds").getInt("maxHashDistance"))
        assertEquals(4, exactSample.getJSONObject("thresholds").getInt("maxChangedRowsCols"))
        val sampleReason = ImageDedupeDiagnosticsDetails.reason(exactSample)
        val fullReason = ImageDedupeDiagnosticsDetails.reason(metadata(ScreenshotDedupeHelper.Mode.EXACT, identical))
        assertTrue(sampleReason.contains("缩略图哈希一致"))
        assertTrue(sampleReason.contains("原图未比较"))
        assertTrue(fullReason.contains("全部像素"))
        pixels[0]++
        val changed = helper.shouldSkip(reference.toSignature(), helper.buildFeatures(96, 96, pixels), ScreenshotDedupeHelper.Mode.CONSERVATIVE)
        assertTrue(changed.duplicate); assertEquals("perceptual_match", changed.reason)
        val measured = metadata(ScreenshotDedupeHelper.Mode.CONSERVATIVE, changed)
        assertEquals(changed.hashDistance, measured.getInt("hashDistance"))
        assertEquals(changed.changedPixelRatio, measured.getDouble("changedPixelRatio"), 0.0)
        assertEquals("reference-id", measured.getString("referenceCaptureId"))
        assertEquals(96, measured.getInt("sampleWidth")); assertEquals(1280, measured.getInt("width"))
        assertEquals(100.0 * (64 - changed.hashDistance) / 64.0, measured.getDouble("hashSimilarityPercent"), 0.0)
    }
}
