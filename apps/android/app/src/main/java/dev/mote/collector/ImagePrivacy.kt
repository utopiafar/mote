package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import kotlin.math.ceil
import kotlin.math.floor

object ImagePrivacy {
    fun applyMasks(bitmap: Bitmap, masks: List<Mask>) {
        val canvas = Canvas(bitmap)
        val paint = Paint().apply { color = Color.BLACK; isAntiAlias = false }
        masks.forEach { canvas.drawRect(floor(it.left * bitmap.width), floor(it.top * bitmap.height), ceil(it.right * bitmap.width), ceil(it.bottom * bitmap.height), paint) }
    }
}
