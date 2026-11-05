package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Test

class MemorySearchHighlightTest {
    @Test fun `all matching terms in a title and conclusion retain their original text positions`() {
        val text = "押金和押金收据 · Mote mote 🐾"
        assertEquals(
            listOf(0 to 2, 3 to 5, 10 to 14, 15 to 19),
            MemorySearchHighlight.matches(text, "押金 mote").map { it.start to it.endExclusive },
        )
    }

    @Test fun `overlapping terms combine and punctuation remains literal`() {
        assertEquals(listOf(0 to 3), MemorySearchHighlight.matches("abc", "ab bc ab").map { it.start to it.endExclusive })
        assertEquals(listOf(0 to 3, 4 to 7), MemorySearchHighlight.matches("a+b a+b", "a+b").map { it.start to it.endExclusive })
        assertEquals(emptyList<MemorySearchHighlight.Match>(), MemorySearchHighlight.matches("测试", "  "))
        assertEquals(emptyList<MemorySearchHighlight.Match>(), MemorySearchHighlight.matches("测试", "不存在"))
    }
}
