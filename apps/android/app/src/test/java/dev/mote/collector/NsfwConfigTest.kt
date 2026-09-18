package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class NsfwConfigTest {
    @Test fun `visual review is deferred by default`() {
        val config = NsfwConfig(); assertFalse(config.enabled); assertEquals(256, config.maxTokens)
        assertEquals(2, config.threads); assertEquals(60000, config.timeoutMs); config.validate()
    }
    @Test fun `invalid configuration is rejected`() {
        listOf(NsfwConfig(policy = ""), NsfwConfig(maxTokens = 31), NsfwConfig(reviewMaxSide = 2048),
            NsfwConfig(threads = 0), NsfwConfig(threads = 9), NsfwConfig(timeoutMs = 4999), NsfwConfig(source = "unknown"),
            NsfwConfig(source = "custom", customUrl = "http://example.com/models"),
            NsfwConfig(source = "custom", customUrl = "https://secret@example.com/models")).forEach {
            assertThrows(IllegalArgumentException::class.java) { it.validate() }
        }
    }
    @Test fun `decision accepts only allow boolean and bounded optional metadata`() {
        assertTrue(ReviewDecision.parse("{\"allow\":true}").allow)
        assertFalse(ReviewDecision.parse("{\"allow\":false,\"reason\":\"用户配置的图片政策\",\"labels\":[\"fixture\"]}").allow)
        listOf("{allow:true}", "{'allow':true}", "{\"allow\":true,}", "{\"allow\":true,\"allow\":false}", "{}", "{\"allow\":\"true\"}", "{\"allow\":true,\"other\":[]}", "{\"allow\":true,\"reason\":null}",
            "{\"allow\":true,\"labels\":[1]}", "{\"allow\":true,\"reason\":\"${"x".repeat(241)}\"}", "```json\n{\"allow\":true}\n```").forEach {
            assertThrows(Exception::class.java) { ReviewDecision.parse(it) }
        }
    }
    @Test fun `resume rejects wrong offset size and invalid ranges`() {
        NsfwModelStore.validateRange("bytes 100-199/200", 100, 200)
        listOf("bytes 99-199/200", "bytes 100-200/201", "bytes 100-99/200", "bytes 100-200/200", "bytes 100-199/*", null).forEach {
            assertThrows(Exception::class.java) { NsfwModelStore.validateRange(it, 100, 200) }
        }
    }
}
