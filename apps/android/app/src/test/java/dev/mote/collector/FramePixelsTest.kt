package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class FramePixelsTest {
    @Test fun stripsRowPaddingWithoutRequiringPaddingAfterLastRow() {
        val input = byteArrayOf(1,2,3,4,5,6,7,8,99,99,99,99,9,10,11,12,13,14,15,16)
        assertArrayEquals((1..16).map { it.toByte() }.toByteArray(), FramePixels.copyRgba(ByteBuffer.wrap(input),12,4,0,0,2,2))
    }
    @Test fun honorsCropAndBufferPosition() {
        val input = ByteBuffer.wrap(ByteArray(4 + 3 * 16) { it.toByte() }).apply { position(4) }
        val copy = FramePixels.copyRgba(input,16,4,1,1,2,2)
        assertArrayEquals(((24..31) + (40..47)).map { it.toByte() }.toByteArray(), copy)
        assertEquals(4,input.position())
    }
    @Test fun preservesPortraitAndLandscapeEdges() {
        for ((width,height) in listOf(3 to 8,8 to 3)) {
            val source = ByteArray(width*height*4) { it.toByte() }
            assertArrayEquals(source,FramePixels.copyRgba(ByteBuffer.wrap(source),width*4,4,0,0,width,height))
        }
    }
    @Test(expected = IllegalArgumentException::class) fun refusesTruncatedFrame() {
        FramePixels.copyRgba(ByteBuffer.allocate(15),8,4,0,0,2,2)
    }
}
