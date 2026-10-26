package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MemoryTopicNavigationTest {
    private val memory = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private fun directory() = JSONObject("""{"classification":{"state":"ready"},"items":[{"id":"auto.one","label":"Generated one","nodes":[{"id":"planning","label":"Planning"},{"id":"review","label":"Review","parentId":"planning"}]},{"id":"auto.two","label":"Generated two","nodes":[{"id":"planning","label":"Same label, different tree"}]}]}""")
    @Test fun sameMemoryCanBeOpenedUnderTwoDistinctTreeIdentitiesAndReturnToExactPage() {
        val state = MemoryTopicNavigation(); val catalog = MemoryTopicCatalog.read(directory())
        state.choose("auto.one", "review"); state.next("generated cursor+/="); state.selectMemory(memory); state.scroll = 120
        val restored = MemoryTopicNavigation().apply { restore(state.save()) }
        assertEquals(memory, restored.selectedMemory); assertTrue(restored.valid(catalog)); assertEquals(state.path(), restored.path()); assertEquals(120, restored.scroll)
        restored.returnToList(); assertNull(restored.selectedMemory); assertTrue(restored.canGoBack); assertTrue(restored.path().contains("generated+cursor%2B%2F%3D"))
        restored.choose("auto.two", "planning"); restored.selectMemory(memory)
        assertEquals(memory, restored.selectedMemory); assertFalse(restored.canGoBack); assertTrue(restored.path().contains("auto.two/nodes/planning"))
        assertFalse(restored.save().has("statement")); assertFalse(restored.save().has("token"))
    }
    @Test fun removedDirectoryNeverKeepsOldSelectionValidAndAllMemoryRemainsAvailable() {
        val state = MemoryTopicNavigation(); state.choose("auto.one", "planning")
        assertFalse(state.valid(MemoryTopicCatalog.read(JSONObject().put("items", JSONArray()))))
        state.choose("topics"); assertEquals("/api/memories?limit=30", state.path()); assertTrue(state.valid(MemoryTopicCatalog.read(JSONObject().put("items", JSONArray()))))
    }
    @Test fun untrustedLabelsStayDataAndAmbiguousOrCyclicIdentitiesAreRejected() {
        val input = directory(); input.getJSONArray("items").getJSONObject(0).put("label", "<script>not code</script>")
        assertEquals("<script>not code</script>", MemoryTopicCatalog.read(input).trees[0].label)
        val duplicate = directory(); duplicate.getJSONArray("items").put(duplicate.getJSONArray("items").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { MemoryTopicCatalog.read(duplicate) }
        val cycle = directory(); cycle.getJSONArray("items").getJSONObject(0).getJSONArray("nodes").getJSONObject(0).put("parentId", "review")
        assertThrows(IllegalArgumentException::class.java) { MemoryTopicCatalog.read(cycle) }
        assertThrows(IllegalArgumentException::class.java) { MemoryTopicNavigation().choose("https://foreign.example", "planning") }
    }
    @Test fun malformedSavedInputsCannotBecomeRoutesAndPreviousDoesNotRetainAnOldCursor() {
        val state = MemoryTopicNavigation(); state.restore(JSONObject().put("tree", "../api/private").put("node", "bad/path").put("memory", "bad").put("cursors", JSONArray().put("untrusted-first")))
        assertEquals("/api/memories?limit=30", state.path()); assertNull(state.selectedMemory)
        state.next("one"); state.next("two"); state.previous(); assertTrue(state.path().endsWith("cursor=one")); state.first(); assertFalse(state.path().contains("cursor"))
    }
}
