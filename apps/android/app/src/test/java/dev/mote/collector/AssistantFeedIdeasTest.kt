package dev.mote.collector

import dev.mote.collector.plugins.AssistantFeed
import dev.mote.collector.plugins.AssistantFeedQuery
import dev.mote.collector.plugins.AssistantFeedRow
import dev.mote.collector.plugins.AssistantIdeas
import dev.mote.collector.plugins.AssistantTabStatus
import dev.mote.collector.plugins.CalendarNeedRow
import dev.mote.collector.plugins.IdeaAction
import dev.mote.collector.plugins.IdeasFilter
import dev.mote.collector.plugins.assistantTabStatus
import dev.mote.collector.plugins.rows
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.time.ZoneId
import java.time.ZonedDateTime

class AssistantFeedIdeasTest {
    private val f = AssistantFixtures
    private val scope = AssistantScope(JSONObject().put("kind", "all"))
    private val zone = ZoneId.of("Asia/Shanghai")

    private fun api(exchange: (String, URI, JSONObject?) -> Pair<Int, JSONObject?>): CentralAssistant {
        val client = CentralClient("https://generated.invalid", "generated-only", transport = { method, url, bytes, _, _ ->
            exchange(method, URI(url), bytes?.let { JSONObject(String(it)) })
        })
        return CentralAssistant(client, scope, AssistantHttpBindings(client))
    }

    private fun URI.queryValue(name: String) = rawQuery.split('&').first { it.substringBefore('=') == name }
        .substringAfter('=').let { URLDecoder.decode(it, "UTF-8") }

    private fun feedPage(vararg rows: JSONObject) = f.page(*rows).put("revision", "generated-feed")
        .put("categories", JSONArray())

    private fun idea(id: String, source: String, vararg actions: String) =
        JSONObject().put("id", id).put("source", source).put("title", "Generated idea").put("kind", "suggestion")
            .put("revision", 14).put("seq", if (source == "card") 64 else 0).put("actions", JSONArray(actions.toList()))

    private fun ideasPage(mine: List<JSONObject> = emptyList(), yours: List<JSONObject> = emptyList(), started: List<JSONObject> = emptyList()) =
        JSONObject().put("revision", "generated-ideas").put("watermark", if (mine.isEmpty() && yours.isEmpty()) 0 else 64)
            .put("mine", JSONArray(mine)).put("yours", JSONArray(yours)).put("started", JSONArray(started))

    @Test fun unreadFeedRowOpensCurrentEvidenceAndLosesItsDotAfterReadReceipt() {
        val raw = f.card().put("kind", "activity").put("subject", "Generated project").put("action", "Updated")
            .put("gist", "Generated key point")
        var marks = 0
        val feed = AssistantFeed(api { method, uri, body ->
            if (method == "POST") {
                assertEquals("/api/assistant-cards/${f.work}/feedback", uri.path)
                assertEquals("read", body!!.getString("action"))
                assertEquals(1L, body.getLong("expectedRevision"))
                marks++
                200 to JSONObject(raw.toString()).put("readAt", f.time).put("revision", 2)
            } else {
                assertEquals("/api/assistant-cards", uri.path)
                assertEquals("3d", uri.queryValue("window"))
                assertEquals(zone.id, uri.queryValue("tz"))
                200 to feedPage(raw)
            }
        })
        val view = feed.read(AssistantFeedQuery(), zone = zone)
        val row = view.items.single()
        assertTrue(row.unread)
        assertEquals("Generated project Updated", row.title)
        assertEquals("Generated key point", row.summary)
        val opened = feed.open(row)
        assertEquals(CentralEvidenceReference.capture(f.evidence), opened.evidenceRef)
        assertEquals(2L, opened.revision)
        assertFalse(view.opened(opened, unreadOnly = false).items.single().unread)
        assertTrue(view.opened(opened, unreadOnly = true).items.isEmpty())
        assertEquals(opened, feed.open(opened))
        assertEquals(1, marks)
    }

    @Test fun anAcknowledgedStartRemovesOnePendingIdeaFromTheBadge() {
        val started = JSONObject().put("taskId", f.taskId).put("title", "Generated idea").put("state", "waiting")
            .put("progress", "Generated progress")
        val mine = idea(f.work, "card", "start", "later", "ignore")
        val question = idea(f.life, "owner-question", "answer")
        var command: JSONObject? = null
        val api = api { method, uri, body ->
            when (uri.path) {
                "/api/assistant/ideas" -> {
                    assertTrue(scope.same(AssistantScope(JSONObject(uri.queryValue("scope")))))
                    200 to if (command == null) ideasPage(listOf(mine), listOf(question)) else ideasPage(yours = listOf(question), started = listOf(started))
                }
                "/api/assistant-cards/${f.work}" -> 200 to f.card(revision = 14)
                "/api/assistant/tasks" -> {
                    assertEquals("POST", method)
                    command = requireNotNull(body)
                    200 to JSONObject().put("requestId", body.getString("requestId")).put("taskId", f.taskId)
                }
                else -> error("Unexpected path ${uri.path}")
            }
        }
        var saved = JSONObject()
        val acceptance = AssistantFeedViewModel(api, { saved }, { saved = it })
        val ideas = AssistantIdeas(api, { acceptance.startIdea(it.id, it.revision, it.title) })
        val before = ideas.read()
        assertEquals(2, before.pendingCount)
        val after = ideas.handle(before, before.mine.single(), IdeaAction.START)
        assertEquals(before.pendingCount - 1, after.pendingCount)
        assertEquals(listOf(f.life), after.yours.map { it.id })
        assertEquals(f.work, command!!.getString("cardId"))
        assertEquals(14L, command!!.getLong("expectedRevision"))
        assertTrue(f.scope().same(AssistantScope(command!!.getJSONObject("scope"))))
        assertFalse(saved.has("pending"))
        val finishedRead = ideas.read()
        assertEquals(after.pendingCount, finishedRead.pendingCount)
        assertEquals(f.taskId, finishedRead.started.single().id)
        assertEquals("waiting", finishedRead.started.single().state)
    }

    @Test fun emptyFeedAndIdeaReadsEachSelectOneEmptyState() {
        val api = api { _, uri, _ ->
            when (uri.path) {
                "/api/assistant-cards" -> 200 to feedPage()
                "/api/assistant/ideas" -> 200 to ideasPage()
                "/api/actions" -> 200 to f.page()
                else -> error("Unexpected path ${uri.path}")
            }
        }
        val feed = AssistantFeed(api).read(AssistantFeedQuery())
        val ideas = AssistantIdeas(api, { error("Unexpected acceptance") })
        val empty = ideas.read().rows(IdeasFilter.ALL, ideas.calendarNeeds())
        assertEquals(AssistantTabStatus.FEED_EMPTY, assistantTabStatus(AssistantTabStatus.FEED_EMPTY, true, feed.items.size))
        assertEquals(AssistantTabStatus.IDEAS_EMPTY, assistantTabStatus(AssistantTabStatus.IDEAS_EMPTY, true, empty.size))
        assertEquals(AssistantTabStatus.LOADING, assistantTabStatus(AssistantTabStatus.FEED_EMPTY, false, 0))
        assertEquals(AssistantTabStatus.OFFLINE, assistantTabStatus(AssistantTabStatus.FEED_EMPTY, false, 0, IOException()))
        assertEquals(AssistantTabStatus.FAILED, assistantTabStatus(AssistantTabStatus.FEED_EMPTY, false, 0, CentralFailure(500)))
        assertEquals(AssistantTabStatus.PARTIAL, assistantTabStatus(AssistantTabStatus.IDEAS_EMPTY, true, 1, CentralFailure(500)))
        assertEquals(AssistantTabStatus.STALE, assistantTabStatus(AssistantTabStatus.IDEAS_EMPTY, false, 0, CentralFailure(410)))
    }

    @Test fun oldCalendarNeedsAndDiscoveriesLandInTheirNewLists() {
        val action = JSONObject().put("id", f.life).put("kind", "calendar.update").put("status", "proposed")
            .put("event", JSONObject().put("title", "Generated calendar suggestion").put("start", f.time).put("end", JSONObject.NULL))
        val discovery = f.card().put("kind", "discovery").put("revision", 0).put("evidence", JSONArray())
        val api = api { method, uri, _ ->
            assertEquals("GET", method)
            when (uri.path) {
                "/api/actions" -> {
                    assertEquals("0", uri.queryValue("cursor"))
                    200 to f.page(action, JSONObject(action.toString()).put("id", f.work).put("status", "approved"))
                }
                "/api/assistant/ideas" -> 200 to ideasPage()
                "/api/assistant-cards" -> {
                    assertEquals(setOf("activity", "briefing", "artifact", "discovery"), uri.queryValue("kinds").split(',').toSet())
                    200 to feedPage(discovery)
                }
                else -> error("Unexpected path ${uri.path}")
            }
        }
        val ideas = AssistantIdeas(api, { error("Unexpected acceptance") })
        val view = ideas.read()
        val needs = ideas.calendarNeeds()
        assertEquals(listOf(CalendarNeedRow(f.life, "Generated calendar suggestion")), view.rows(IdeasFilter.YOURS, needs))
        assertTrue(view.rows(IdeasFilter.MINE, needs).isEmpty())
        val feed = AssistantFeed(api)
        val item = feed.read(AssistantFeedQuery()).items.single()
        assertTrue(item.discovery)
        assertEquals(f.work, item.id)
        assertFalse(item.unread)
        assertEquals(item, feed.open(item))
    }

    @Test fun onlyServerActionsCanRunAndAnswerCarriesTheExactTypedReference() {
        var writes = 0
        val api = api { method, uri, body ->
            if (method == "GET") {
                200 to ideasPage(
                    mine = listOf(idea(f.work, "card", "later")),
                    yours = listOf(idea(f.life, "owner-question", "answer"), idea(f.matterId, "card", "answer")),
                )
            } else {
                assertEquals("/api/assistant-cards/${f.work}/feedback", uri.path)
                assertEquals("later", body!!.getString("action"))
                assertEquals(14L, body.getLong("expectedRevision"))
                assertEquals("2026-11-22T01:00:00Z", body.getString("until"))
                writes++
                200 to f.card()
            }
        }
        val ideas = AssistantIdeas(api, { error("The server did not offer start") }, { ZonedDateTime.parse("2026-11-21T18:00:00+08:00[Asia/Shanghai]") })
        val view = ideas.read()
        val mine = view.mine.single()
        val question = view.yours.first()
        assertEquals(listOf(IdeaAction.LATER), mine.actions)
        assertEquals(listOf(IdeaAction.ANSWER), question.actions)
        assertThrows(IllegalArgumentException::class.java) { ideas.handle(view, mine, IdeaAction.START) }
        assertThrows(IllegalArgumentException::class.java) { ideas.handle(view, question, IdeaAction.IGNORE) }
        assertThrows(IllegalArgumentException::class.java) { mine.answer() }
        assertEquals("#/${CentralPageRoutes.chat}?about=question%3A${f.life}", question.answer().hash())
        assertEquals("#/${CentralPageRoutes.chat}?about=card%3A${f.matterId}", view.yours.last().answer().hash())
        assertEquals(view.pendingCount - 1, ideas.handle(view, mine, IdeaAction.LATER).pendingCount)
        assertEquals(1, writes)
    }

    @Test fun staleFeedRowsDiscardTextAndNeverProduceAReadAction() {
        val raw = f.card().put("kind", "activity").put("state", "stale").put("gist", "Generated withdrawn detail")
        val row = AssistantFeedRow.read(raw)
        assertTrue(row.stale)
        assertFalse(row.unread)
        assertNull(row.title)
        assertNull(row.summary)
        assertNull(row.evidenceRef)
        assertEquals(row, AssistantFeed(api { _, _, _ -> error("Unexpected read command") }).open(row))
    }
}
