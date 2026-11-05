package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryBrowseCriteriaTest {
    @Test fun `filters use the existing model assigned personal and episodic dimensions`() {
        val nav = MemoryTopicNavigation()
        assertEquals("/api/memories?limit=30&level=detail", MemoryBrowseCriteria.path(nav, "", false))
        nav.next("old page")
        MemoryBrowseCriteria.select(nav, "personal")
        assertEquals("/api/context-trees/topics/nodes/personal?limit=30&query=%E6%8A%BC%E9%87%91&includeHistory=true", MemoryBrowseCriteria.path(nav, " 押金 ", true))
        assertFalse(nav.canGoBack)
        nav.next("cursor+/=")
        assertTrue(MemoryBrowseCriteria.path(nav, "押金", true).contains("cursor=cursor%2B%2F%3D"))
        MemoryBrowseCriteria.select(nav, "event")
        assertEquals("/api/context-trees/knowledge/nodes/episodic?limit=30", MemoryBrowseCriteria.path(nav, "", false))
        MemoryBrowseCriteria.select(nav, "all")
        assertEquals("/api/memories?limit=30&level=detail", MemoryBrowseCriteria.path(nav, "", false))
    }
}
