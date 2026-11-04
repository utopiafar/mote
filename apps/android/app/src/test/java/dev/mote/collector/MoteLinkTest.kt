package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class MoteLinkTest {
    private val origin = "https://central.example"
    private val id = "6a1f2b3c-4d5e-46f7-8a9b-0c1d2e3f4a5b"
    private val ref = "capture:1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d"

    @Test fun serializedLinksParseBackToTheExactRoute() {
        val scope = MoteLink.Scope(origin)
        val routes = listOf(
            MoteLink.Route.Conversation(id),
            MoteLink.Route.Run("generated-run-42"),
            MoteLink.Route.Reference(ref),
            MoteLink.Route.Reference(ref, id),
            MoteLink.Route.View("mote.notes", "notes.editor", ref),
        )
        for (route in routes) {
            val link = MoteLink.parse(MoteLink.serialize(scope, route))
            assertEquals(MoteLink.Link(scope, route), link)
        }
        assertEquals("$origin/#/ask?conversation=$id", MoteLink.serialize(scope, MoteLink.Route.Conversation(id)))
        assertEquals("$origin/#/activity?work=generated-run-42", MoteLink.serialize(scope, MoteLink.Route.Run("generated-run-42")))
        assertEquals("$origin/#/ask?evidence=${java.net.URLEncoder.encode(ref, "UTF-8")}", MoteLink.serialize(scope, MoteLink.Route.Reference(ref)))
    }

    @Test fun canonicalHashStringsMatchTheSharedVocabulary() {
        // These literals are asserted against serializeMoteLink output in
        // apps/android/test-fixtures/deep-link.ts — keep them in sync.
        assertEquals(MoteLink.Route.Conversation(id), MoteLink.parse("$origin/#/ask?conversation=$id")?.route)
        assertEquals(MoteLink.Route.Run("run+plus"), MoteLink.parse("$origin/#/activity?work=run%2Bplus")?.route)
        assertEquals(MoteLink.Route.Reference(ref), MoteLink.parse("$origin/#/ask?evidence=capture%3A1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d")?.route)
        assertEquals(MoteLink.Route.View("mote.notes", "notes.editor", ref), MoteLink.parse("$origin/#/view?package=mote.notes&route=notes.editor&evidence=capture%3A1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d")?.route)
    }

    @Test fun malformedAndForeignLinksParseToNothing() {
        for (url in listOf(
            origin, "$origin/notes", "$origin/?x=1#/ask?conversation=$id", "https://u@central.example/#/ask?conversation=$id",
            "http://remote.example/#/ask?conversation=$id", "central.example/#/ask?conversation=$id",
            " $origin/#/ask?conversation=$id", "$origin/#/ask?conversation=oops", "$origin/#/ask?conversation=$id&conversation=$id",
            "$origin/#/ask?evidence=$id", "$origin/#/ask?evidence=capture%3A1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d&conversation=oops",
            "$origin/#/view?package=mote.notes&route=notes.editor",
            "$origin/#/unknown?conversation=$id", "$origin/#ask?extra",
        )) assertNull(url, MoteLink.parse(url))
        assertThrows(IllegalArgumentException::class.java) { MoteLink.serialize(MoteLink.Scope("http://remote.example"), MoteLink.Route.Run("r")) }
        assertThrows(IllegalArgumentException::class.java) { MoteLink.serialize(MoteLink.Scope(origin), MoteLink.Route.Conversation("not-a-uuid")) }
    }

    @Test fun resolutionKeepsTargetOrRefusesWithoutRetargeting() {
        val scope = MoteLink.Scope(origin)
        val view = MoteLink.Route.View("mote.notes", "notes.editor", ref)
        val viewLink = MoteLink.parse(MoteLink.serialize(scope, view))!!
        assertEquals(MoteLink.Resolution.Keep(view), MoteLink.resolve(viewLink, origin) { it.routeId == "notes.editor" })
        assertEquals(MoteLink.Resolution.Reader(ref), MoteLink.resolve(viewLink, origin) { false })
        assertEquals(MoteLink.Resolution.ForeignScope, MoteLink.resolve(viewLink, "https://other.example"))
        assertEquals(MoteLink.Resolution.Denied, MoteLink.resolve(viewLink, origin, granted = false))
        assertEquals(MoteLink.Resolution.Missing, MoteLink.resolve(viewLink, origin, exists = false))
    }

    @Test fun destinationsProjectOntoTheGuardedExtrasVocabulary() {
        val scope = MoteLink.Scope(origin)
        val conversation = MoteLink.parse(MoteLink.serialize(scope, MoteLink.Route.Conversation(id)))!!
        assertEquals(MoteLink.Destination.Extras("ask", conversationId = id), MoteLink.destination(conversation, origin))
        val work = MoteLink.parse(MoteLink.serialize(scope, MoteLink.Route.Run("generated-run")))!!
        assertEquals(MoteLink.Destination.Extras("activity"), MoteLink.destination(work, origin))
        val evidence = MoteLink.parse(MoteLink.serialize(scope, MoteLink.Route.Reference(ref, id)))!!
        assertEquals(MoteLink.Destination.Extras("ask", conversationId = id, evidenceId = ref), MoteLink.destination(evidence, origin))
        val view = MoteLink.parse(MoteLink.serialize(scope, MoteLink.Route.View("mote.notes", "notes.editor", ref)))!!
        assertEquals(MoteLink.Destination.Extras("notes.editor"), MoteLink.destination(view, origin) { it.routeId == "notes.editor" })
        assertEquals(MoteLink.Destination.Extras("ask", evidenceId = ref), MoteLink.destination(view, origin) { false })
        assertEquals(MoteLink.Destination.None, MoteLink.destination(view, "https://other.example"))
        assertEquals(MoteLink.Destination.None, MoteLink.destination(view, origin, granted = false))
        assertEquals(MoteLink.Destination.None, MoteLink.destination(view, origin, exists = false))
    }
}
