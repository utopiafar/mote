package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** U7: people are exact Memory identities supplied by the existing commitment
 * projection; names never group rows and a revoked Memory disappears. */
class MemoryPeoplePresentationTest {
    private val first = "00000000-0000-4000-8000-000000000001"
    private val second = "00000000-0000-4000-8000-000000000002"

    private fun commitment(id: String = "00000000-0000-4000-8000-000000000010", person: String? = first, title: String = "Generated person") = JSONObject()
        .put("id", id).put("revision", 1).put("title", title)
        .put("personMemoryId", person ?: JSONObject.NULL).put("matterId", JSONObject.NULL)

    private fun page(vararg rows: JSONObject) = JSONObject().put("items", JSONArray(rows.toList())).put("nextCursor", JSONObject.NULL)

    @Test fun groupingUsesTheExactMemoryIdentityAndNeverTheTitle() {
        val groups = MemoryPeoplePresentation.groups(page(
            commitment(person = first, title = "Same generated name"),
            commitment(id = "00000000-0000-4000-8000-000000000011", person = first, title = "Same generated name"),
            commitment(id = "00000000-0000-4000-8000-000000000012", person = second, title = "Same generated name"),
            commitment(id = "00000000-0000-4000-8000-000000000013", person = null, title = "Unlinked"),
            commitment(id = "00000000-0000-4000-8000-000000000014", person = "not-a-uuid", title = "Invalid"),
        ))
        assertEquals(2, groups.size)
        assertEquals(first, groups[0].memoryId); assertEquals(2, groups[0].commitmentCount)
        assertEquals(second, groups[1].memoryId); assertEquals(1, groups[1].commitmentCount)
    }

    @Test fun aPersonWithoutAnExplicitMemoryReferenceStaysAbsent() {
        assertTrue(MemoryPeoplePresentation.groups(page(commitment(person = null))).isEmpty())
        assertTrue(MemoryPeoplePresentation.groups(JSONObject()).isEmpty())
    }

    @Test fun scopeIsExplicitAndTheCursorIsBoundedToTheSameProjection() {
        val path = MemoryPeoplePresentation.path("generated-cursor")
        assertTrue(path.startsWith("/api/assistant/commitments?scope="))
        assertTrue(path.contains("limit=50"))
        assertTrue(path.contains("cursor=generated-cursor"))
        assertEquals("all", MemoryPeoplePresentation.scope().getString("kind"))
    }

    @Test fun personBodyMustMatchItsExactIdentityAndRevision() {
        val client = CentralClient("https://central.invalid", "generated-token", transport = { _, url, _, _, _ ->
            val id = url.substringAfter("/api/memories/")
            if (id == first) 200 to JSONObject().put("id", first).put("version", 2).put("title", "Generated person")
            else 200 to JSONObject().put("id", second).put("version", 1).put("title", "Other person")
        })
        assertEquals(first, MemoryPeoplePresentation.person(client, first)!!.getString("id"))
        assertNull(MemoryPeoplePresentation.person(client, "00000000-0000-4000-8000-000000000099"))
    }

    @Test fun aForgottenPersonMemoryIsNotShown() {
        val client = CentralClient("https://central.invalid", "generated-token", transport = { _, _, _, _, _ ->
            404 to JSONObject().put("error", "not_found")
        })
        assertNull(MemoryPeoplePresentation.person(client, first))
        val forbidden = CentralClient("https://central.invalid", "generated-token", transport = { _, _, _, _, _ ->
            403 to JSONObject().put("reason", "forbidden")
        })
        assertNull(MemoryPeoplePresentation.person(forbidden, first))
    }

    @Test fun currentnessLabelsFollowStoredStateAndReplacementLinks() {
        val now = java.time.Instant.parse("2026-11-13T00:00:00Z").toEpochMilli()
        assertEquals("已生效", MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "published"), now))
        assertEquals("需要重验", MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "stale"), now))
        assertEquals("待重新处理", MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "proposed"), now))
        assertEquals("已过期", MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "published").put("validUntil", "2026-11-12T00:00:00Z"), now))
        assertEquals("已由新版本替代", MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "published")
            .put("supersededBy", second).put("supersededAt", "2026-11-12T00:00:00Z"), now))
        assertNull(MemoryPeoplePresentation.replacement(JSONObject().put("supersededBy", "not-a-uuid")))
        assertFalse(MemoryPeoplePresentation.stateLabel(JSONObject().put("status", "published")
            .put("supersededBy", second).put("supersededAt", "2026-11-14T00:00:00Z"), now) == "已由新版本替代")
    }
}
