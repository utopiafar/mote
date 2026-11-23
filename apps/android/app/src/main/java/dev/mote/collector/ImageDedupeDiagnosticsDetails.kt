package dev.mote.collector

import org.json.JSONObject

/** Measurements describe this pixel algorithm, never model confidence or semantic similarity. */
object ImageDedupeDiagnosticsDetails {
    fun metadata(mode: ScreenshotDedupeHelper.Mode, result: ScreenshotDedupeHelper.CompareResult,
        referenceId: String, referenceAt: String, captureId: String, capturedAt: String, appId: String?,
        width: Int, height: Int, sampleWidth: Int, sampleHeight: Int): JSONObject {
        require(result.duplicate && result.hashDistance in 0..64)
        return JSONObject().put("version", 1).put("algorithm", "mote-screenshot-v2").put("mode", mode.rawValue)
            .put("reason", result.reason).put("referenceCaptureId", referenceId).put("referenceCapturedAt", referenceAt)
            .put("captureId", captureId).put("capturedAt", capturedAt).put("appId", appId)
            .put("width", width).put("height", height).put("sampleWidth", sampleWidth).put("sampleHeight", sampleHeight)
            .put("hashDistance", result.hashDistance).put("hashBits", 64).put("hashSimilarityPercent", 100.0 * (64 - result.hashDistance) / 64.0)
            .put("changedPixelRatio", result.changedPixelRatio).put("changedBlocks", result.changedBlocks)
            .put("changedRows", result.changedRows).put("changedCols", result.changedCols)
            .put("thresholds", JSONObject().put("maxHashDistance", mode.maxHashDistance)
                .put("maxChangedPixelRatio", mode.maxChangedPixelRatio).put("maxChangedBlocks", mode.maxChangedBlocks)
                .put("maxChangedRowsCols", mode.maxChangedRowsCols))
    }
    fun modeName(value: String) = when (value) { "exact" -> MoteI18n.text("精确"); "conservative" -> MoteI18n.text("保守"); "aggressive" -> MoteI18n.text("激进"); else -> MoteI18n.text("均衡") }
    fun reason(value: JSONObject): String = when (value.optString("reason")) {
        "exact_match" -> if (value.optString("mode") == "exact") MoteI18n.text("处理后图像的全部像素哈希完全一致") else MoteI18n.text("缩略采样像素哈希相同；原尺寸像素仍可能不同。")
        "perceptual_match" -> MoteI18n.text("感知哈希距离、缩略图像素及区块行列变化均未超阈值。")
        else -> MoteI18n.text("图片去重判断命中")
    }
}
