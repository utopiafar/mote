package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ConversationPagingTest {
    private fun turn(id: String = UUID.randomUUID().toString()) = JSONObject().put("id", id).put("question", "Generated question")
    private fun page(id: String = UUID.randomUUID().toString(), revision: Int = 3, next: String? = null, turns: List<JSONObject>) = JSONObject()
        .put("id", id).put("revision", revision).put("nextCursor", next ?: JSONObject.NULL)
        .put("turns", JSONArray(turns))

    @Test fun `older page is prepended without duplicating the current page`() {
        val id = UUID.randomUUID().toString()
        val first = turn(); val second = turn(); val third = turn()
        val current = page(id, turns = listOf(second, third))
        val older = page(id, next = null, turns = listOf(first, second))
        val merged = ConversationPaging.merge(current, older)
        assertEquals(listOf(first.getString("id"), second.getString("id"), third.getString("id")),
            (0 until merged.getJSONArray("turns").length()).map { merged.getJSONArray("turns").getJSONObject(it).getString("id") })
        assertTrue(merged.isNull("nextCursor"))
    }

    @Test fun `older cursor remains until the oldest page is reached`() {
        val id = UUID.randomUUID().toString()
        val current = page(id, next = "5", turns = listOf(turn()))
        val older = page(id, next = "2", turns = listOf(turn()))
        assertEquals("2", ConversationPaging.merge(current, older).getString("nextCursor"))
    }

    @Test fun `a different conversation or revision cannot be merged`() {
        val current = page(turns = listOf(turn()))
        val other = page(id = UUID.randomUUID().toString(), turns = listOf(turn()))
        val changed = page(id = current.getString("id"), revision = 4, turns = listOf(turn()))
        assertThrows(IllegalArgumentException::class.java) { ConversationPaging.merge(current, other) }
        assertThrows(IllegalArgumentException::class.java) { ConversationPaging.merge(current, changed) }
    }
}
