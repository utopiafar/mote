package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReviewResponseTest {
    @Test fun `allow requires explicit reviewed regions even when empty`() {
        assertTrue(ReviewResponse.masks(JSONObject("""{"allow":true,"rectangles":[]}""")).isEmpty())
        assertThrows(IllegalArgumentException::class.java) { ReviewResponse.masks(JSONObject("""{"allow":true}""")) }
        assertThrows(Exception::class.java) { ReviewResponse.masks(JSONObject("""{"allow":true,"rectangles":"none"}""")) }
    }
    @Test fun `normalized rectangle becomes mask`() {
        assertEquals(listOf(Mask(.1f, .2f, .5f, .7f)), ReviewResponse.masks(JSONObject("""{"allow":true,"rectangles":[{"x":0.1,"y":0.2,"width":0.4,"height":0.5}]}""")))
    }
    @Test fun `out of bounds model result fails closed`() {
        assertThrows(IllegalArgumentException::class.java) { ReviewResponse.masks(JSONObject("""{"allow":true,"rectangles":[{"x":0.8,"y":0.2,"width":0.4,"height":0.5}]}""")) }
    }
}
