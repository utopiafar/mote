package dev.mote.collector

import android.graphics.Bitmap
import android.media.Image

/** Copy only image pixels: row padding (including a missing final padded row) is not image content. */
internal object CapturedFrame {
    fun copy(image: Image): Bitmap {
        val plane = image.planes.single()
        val crop = image.cropRect
        require(crop.width() > 0 && crop.height() > 0)
        val rgba = FramePixels.copyRgba(plane.buffer, plane.rowStride, plane.pixelStride,
            crop.left, crop.top, crop.width(), crop.height())
        return Bitmap.createBitmap(crop.width(), crop.height(), Bitmap.Config.ARGB_8888).also {
            try { it.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(rgba)) } catch (error: Exception) { it.recycle(); throw error }
        }
    }
    fun isBlank(bitmap: Bitmap): Boolean {
        val row = IntArray(bitmap.width)
        for (y in 0 until bitmap.height) {
            bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
            if (row.any { (it ushr 24) != 0 && (it and 0x00ffffff) != 0 }) return false
        }
        return true
    }
}
