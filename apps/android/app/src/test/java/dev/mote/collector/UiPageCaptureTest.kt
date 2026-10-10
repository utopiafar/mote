package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UiPageCaptureTest {
    private val at = "2026-10-10T00:00:00Z"
    private fun node(id: String, text: String = "", parent: String? = null, resource: String = "fixture:id/$id", index: Int = 0) =
        JSONObject().put("id",id).put("parentId",parent).put("resourceId",resource).put("role","Text").put("text",text).put("childIndex",index)
    private fun snapshot(nodes: List<JSONObject>, version: String = "1") = JSONObject().put("appId","fixture").put("appVersion",version).put("activity","fixture.Page")
        .put("observedAt",at).put("truncated",false).put("nodes",JSONArray(nodes))
    private fun field(id: String, required: Boolean = false) = JSONObject().put("select",JSONObject().put("resourceId","fixture:id/$id")).put("required",required)
    private fun articleRule() = JSONObject().put("formatVersion",2).put("id","fixture.article").put("version","1").put("platform","android").put("appId","fixture").put("appVersion","1").put("kind","article")
        .put("fields",JSONObject().put("title",field("title",true)).put("author",field("author")).put("url",field("url")).put("body",field("body",true)))
    private fun rules(rule: JSONObject) = UiPageRules.parse(JSONArray().put(rule).toString())
    private fun article(body: List<String>, identity: Boolean = true, whenAt: String = at): JSONObject {
        val value=JSONObject().put("kind","article").put("title","Generated article").put("author","Generated author").put("body",JSONArray(body.map { JSONObject().put("text",it) }))
        if(identity)value.put("url","https://example.invalid/article/1").put("identity",JSONObject().put("type","url").put("value","https://example.invalid/article/1"))
        return JSONObject().put("version",2).put("scope","visible_window").put("adapterId","fixture.article").put("adapterVersion","1").put("appVersion","1").put("activity","fixture.Page")
            .put("status","ok").put("truncated",false).put("observations",JSONObject().put("firstAt",whenAt).put("lastAt",whenAt).put("count",1)).put("objects",JSONArray().put(value))
    }
    private fun body(page: JSONObject) = page.getJSONArray("objects").getJSONObject(0).getJSONArray("body").let { b -> (0 until b.length()).map { b.getJSONObject(it).getString("text") } }
    @Test fun articleRequiresVisibleTitleAndBodyAtTheExactVersion() {
        val input = snapshot(listOf(node("title","Generated title"),node("author","Generated author"),node("body","Generated original paragraph"),node("url","https://example.invalid/a"),node("other","DO NOT UPLOAD CONTROLS")))
        val page=UiPageRules.extractAll(input,rules(articleRule())).single()
        assertEquals("Generated title\nGenerated author\nhttps://example.invalid/a\nGenerated original paragraph",UiPageRules.text(page))
        assertFalse(page.toString().contains("DO NOT UPLOAD"));assertFalse(page.toString().contains("resourceId"));assertFalse(page.has("nodes"))
        assertTrue(UiPageRules.extractAll(snapshot(listOf(node("title","Generated title"))),rules(articleRule())).isEmpty())
        assertTrue(UiPageRules.extractAll(snapshot(listOf(node("title","Generated title"),node("body","text")),"2"),rules(articleRule())).isEmpty())
        val ambiguous=snapshot(listOf(node("title","A"),node("title2","B",resource="fixture:id/title"),node("body","text")))
        assertTrue(UiPageRules.extractAll(ambiguous,rules(articleRule())).isEmpty())
    }
    @Test fun productCardsRemainSeparateAndNeverInventALink() {
        val rule=articleRule().put("kind","product").put("region",JSONObject().put("resourceId","fixture:id/list")).put("repeat",JSONObject().put("resourceId","fixture:id/card"))
            .put("repeatParent",JSONObject().put("resourceId","fixture:id/list")).put("fields",JSONObject().put("title",field("title",true)).put("url",field("url")))
        val input=snapshot(listOf(node("list"),node("one",parent="list",resource="fixture:id/card"),node("title","Generated product",parent="one"),node("url","javascript:alert(1)",parent="one"),
            node("two",parent="list",resource="fixture:id/card",index=1),node("title2","Generated product",parent="two",resource="fixture:id/title"),node("url2","https://example.invalid/item/2",parent="two",resource="fixture:id/url")))
        val pages=UiPageRules.extractAll(input,rules(rule))
        assertEquals(2,pages.size)
        assertFalse(pages[0].getJSONArray("objects").getJSONObject(0).has("url"))
        assertFalse(pages[0].getJSONArray("objects").getJSONObject(0).has("identity"))
        assertEquals("https://example.invalid/item/2",pages[1].getJSONArray("objects").getJSONObject(0).getJSONObject("identity").getString("value"))
        assertTrue(pages.all { it.getJSONArray("objects").length()==1 })
    }
    @Test fun positionalPathsUseOriginalChildIndicesAndRejectMissingOrAmbiguousChildren() {
        val rule=articleRule().put("kind","product").put("region",JSONObject().put("resourceId","fixture:id/card"))
            .put("fields",JSONObject().put("title",field("title",true).put("childPath",JSONArray(listOf(2)))))
        val input=snapshot(listOf(node("card"),node("title","Correct original third child",parent="card",index=2),node("noise","Earlier hidden sibling",parent="card",index=0)))
        assertEquals("Correct original third child",UiPageRules.extractAll(input,rules(rule)).single().getJSONArray("objects").getJSONObject(0).getString("title"))
        val missing=snapshot(listOf(node("card"),node("title","Wrong first visible child",parent="card",index=0)))
        assertTrue(UiPageRules.extractAll(missing,rules(rule)).isEmpty())
        input.getJSONArray("nodes").put(node("duplicate","Duplicate index",parent="card",index=2,resource="fixture:id/title"))
        assertTrue(UiPageRules.extractAll(input,rules(rule)).isEmpty())
    }
    @Test fun onlyDurablyAcceptedReliableIdentitiesMergeKnownOverlap() {
        val merge=UiPageMerge()
        val before=article(listOf("Paragraph A","Paragraph B"))
        val after=article(listOf("Paragraph B","Paragraph C"),whenAt="2026-10-10T00:00:30Z")
        assertEquals(listOf("Paragraph B","Paragraph C"),body(merge.merge(after,"session")))
        merge.accepted(before,"session")
        val combined=merge.merge(after,"session")
        assertEquals(listOf("Paragraph A","Paragraph B","Paragraph C"),body(combined))
        assertEquals(2,combined.getJSONObject("observations").getInt("count"))
        assertEquals(at,combined.getJSONObject("observations").getString("firstAt"))
        assertEquals(listOf("Paragraph B","Paragraph C"),body(merge.merge(after,"new-session")))
        val unidentified=article(listOf("Paragraph B","Paragraph C"),identity=false)
        assertEquals(1,merge.merge(unidentified,"session").getJSONObject("observations").getInt("count"))
        val disjoint=article(listOf("Unrelated visible paragraph"))
        assertEquals(body(disjoint),body(merge.merge(disjoint,"session")))
        merge.reset();assertEquals(body(after),body(merge.merge(after,"session")))
    }
    @Test fun repeatedParagraphsWithinOneObservationAreNeverCollapsed() {
        val input=snapshot(listOf(node("title","Generated title"),node("body","Same paragraph"),node("body2","Same paragraph",resource="fixture:id/body")))
        assertEquals(listOf("Same paragraph","Same paragraph"),body(UiPageRules.extractAll(input,rules(articleRule())).single()))
    }
    @Test fun knownCharacterOverlapMergesButShortCoincidenceDoesNot() {
        val overlap="Generated exact common paragraph content. "
        val merge=UiPageMerge();merge.accepted(article(listOf("First part. "+overlap)),"session")
        assertEquals(listOf("First part. "+overlap+"Last part."),body(merge.merge(article(listOf(overlap+"Last part.")),"session")))
        val short=UiPageMerge();short.accepted(article(listOf("Before word")),"session")
        assertEquals(listOf("word after"),body(short.merge(article(listOf("word after")),"session")))
    }
    @Test fun structuredSuccessAndPrivacyRejectionNeverTriggerScreenshotFallback() {
        for(mode in listOf("hybrid","ui_preferred","page_only")) {
            assertFalse(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.CAPTURED))
            assertFalse(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.EXTRACTED))
            assertFalse(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.SAVE_FAILED))
            assertTrue(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.EMPTY))
            assertTrue(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.FAILED))
            assertFalse(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.PRIVACY_REJECTED))
            assertFalse(mode,UiPageCaptureChoice.screenshot(mode,UiPageOutcome.STATE_CHANGED))
        }
    }
    @Test fun rejectNewRulesWithoutVersionAndFieldContracts() {
        for(rule in listOf(JSONObject(articleRule().toString()).apply { remove("appVersion") }, articleRule().put("fields",JSONObject().put("title",field("title",false))),
            articleRule().put("fields",JSONObject().put("title",field("title",true))), articleRule().put("script","execute"), articleRule().put("repeatParent",JSONObject().put("role","Text")))) {
            try { rules(rule);fail(rule.toString()) } catch(_:IllegalArgumentException) { }
        }
    }
    @Test fun v2UploadContainsOnlyOriginalFieldsAndAlignedObservationMetadata() {
        val page=article(listOf("Generated original paragraph"))
        fun event(value: JSONObject) = JSONObject().put("source","ui_page").put("durationMs",0).put("appId","fixture").put("capturedAt",at).put("ocrText",UiPageRules.text(value))
            .put("privacy",JSONObject().put("collection","content")).put("metadata",JSONObject().put("observedAt",at).put("collector",JSONObject().put("method","accessibility")).put("uiPage",value))
        UiPageRules.validateEvent(event(page))
        val contaminated=JSONObject(page.toString()).put("nodes",JSONArray().put(node("body","Raw tree")))
        try { UiPageRules.validateEvent(event(contaminated));fail("raw nodes") } catch(_:IllegalArgumentException) { }
        val badIdentity=JSONObject(page.toString()).apply { getJSONArray("objects").getJSONObject(0).getJSONObject("identity").put("value","https://example.invalid/guessed") }
        try { UiPageRules.validateEvent(event(badIdentity));fail("guessed identity") } catch(_:IllegalArgumentException) { }
        val mismatched=event(page).apply { getJSONObject("metadata").put("observedAt","2026-10-10T00:00:30Z") }
        try { UiPageRules.validateEvent(mismatched);fail("misaligned metadata") } catch(_:IllegalArgumentException) { }
    }
    @Test fun maximumFieldBudgetAllowsAllProjectionSeparators() {
        val page=article((0 until 64).map { "p".repeat(if(it==0)1300 else 900) })
        val value=page.getJSONArray("objects").getJSONObject(0)
        value.put("title","t".repeat(2000)).put("author","a".repeat(1000)).put("url","https://example.invalid/"+"u".repeat(2000-"https://example.invalid/".length))
            .put("itemId","i".repeat(1000)).put("identity",JSONObject().put("type","source_id").put("value","i".repeat(1000)))
        assertEquals(64067,UiPageRules.text(page).length)
        val event=JSONObject().put("source","ui_page").put("durationMs",0).put("appId","fixture").put("capturedAt",at).put("ocrText",UiPageRules.text(page))
            .put("privacy",JSONObject().put("collection","content")).put("metadata",JSONObject().put("observedAt",at).put("collector",JSONObject().put("method","accessibility")).put("uiPage",page))
        UiPageRules.validateEvent(event)
    }
    @Test fun mergeCounterStartsANewDurableSegmentAtTheProtocolBound() {
        val merge=UiPageMerge()
        val first=article(listOf("Generated paragraph")).apply { getJSONObject("observations").put("count",256) }
        merge.accepted(first,"session")
        val current=article(listOf("Generated paragraph"),whenAt="2026-10-10T00:00:30Z")
        val fresh=merge.merge(current,"session")
        assertEquals(1,fresh.getJSONObject("observations").getInt("count"))
        assertEquals("2026-10-10T00:00:30Z",fresh.getJSONObject("observations").getString("firstAt"))
        assertEquals(body(current),body(fresh))
        merge.accepted(fresh,"session")
        assertEquals(2,merge.merge(article(listOf("Generated paragraph"),whenAt="2026-10-10T00:01:00Z"),"session").getJSONObject("observations").getInt("count"))
    }
}
