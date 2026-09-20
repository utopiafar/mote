package dev.mote.collector

import java.nio.ByteBuffer

internal object FramePixels {
    fun copyRgba(buffer: ByteBuffer, rowStride: Int, pixelStride: Int, left: Int, top: Int, width: Int, height: Int): ByteArray {
        require(pixelStride == 4 && left >= 0 && top >= 0 && width > 0 && height > 0)
        require(rowStride.toLong() >= (left.toLong() + width) * pixelStride)
        val bytes = Math.multiplyExact(Math.multiplyExact(width, height), 4)
        val source = buffer.duplicate()
        val start = source.position().toLong()
        require(start + (top.toLong() + height - 1) * rowStride + (left.toLong() + width) * 4 <= source.limit())
        return ByteArray(bytes).also { output ->
            for (y in 0 until height) {
                source.position((start + (top.toLong() + y) * rowStride + left.toLong() * 4).toInt())
                source.get(output, y * width * 4, width * 4)
            }
        }
    }
}
