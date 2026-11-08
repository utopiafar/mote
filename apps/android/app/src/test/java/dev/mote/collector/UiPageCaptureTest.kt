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
    private fun field(id: String, required: Boolean = false, cardinality: String = "one") = JSONObject().put("select",JSONObject().put("resourceId","fixture:id/$id")).put("required",required).put("cardinality",cardinality)
    private fun articleRule() = JSONObject().put("formatVersion",3).put("id","fixture.article").put("version","1").put("platform","android").put("appId","fixture").put("appVersion","1").put("kind","article")
        .put("fields",JSONObject().put("title",field("title",true)).put("author",field("author")).put("url",field("url")).put("body",field("body",true,"many")))
    private fun rules(rule: JSONObject) = UiPageRules.parse(JSONArray().put(rule).toString())
    private fun article(body: List<String>, identity: Boolean = true, whenAt: String = at): JSONObject {
        val fields=JSONArray().put(JSONObject().put("name","title").put("values",JSONArray().put(JSONObject().put("text","Generated article").put("source","text"))))
            .put(JSONObject().put("name","author").put("values",JSONArray().put(JSONObject().put("text","Generated author").put("source","text"))))
        if(identity)fields.put(JSONObject().put("name","url").put("values",JSONArray().put(JSONObject().put("text","https://example.invalid/article/1").put("source","text"))))
        fields.put(JSONObject().put("name","body").put("values",JSONArray(body.map { JSONObject().put("text",it).put("source","text") })))
        val value=JSONObject().put("kind","article").put("fields",fields)
        return JSONObject().put("version",3).put("scope","visible_window").put("adapterId","fixture.article").put("adapterVersion","1").put("appVersion","1").put("activity","fixture.Page")
            .put("status","ok").put("truncated",false).put("observations",JSONObject().put("firstAt",whenAt).put("lastAt",whenAt).put("count",1)).put("objects",JSONArray().put(value))
    }
    private fun values(page: JSONObject, name: String): List<String> {
        val fields=page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
        val field=(0 until fields.length()).map(fields::getJSONObject).singleOrNull { it.getString("name")==name } ?: return emptyList()
        val values=field.getJSONArray("values");return (0 until values.length()).map { values.getJSONObject(it).getString("text") }
    }
    private fun body(page: JSONObject) = values(page,"body")
    @Test fun articleRequiresVisibleTitleAndBodyAtTheExactVersion() {
        val input = snapshot(listOf(node("title","Generated title"),node("author","Generated author"),node("body","Generated original paragraph"),node("url","https://example.invalid/a"),node("other","DO NOT UPLOAD CONTROLS")))
        val page=UiPageRules.extractAll(input,rules(articleRule())).single()
        assertEquals("Generated author\nGenerated original paragraph\nGenerated title\nhttps://example.invalid/a",UiPageRules.text(page))
        assertFalse(page.toString().contains("DO NOT UPLOAD"));assertFalse(page.toString().contains("resourceId"));assertFalse(page.has("nodes"))
        assertTrue(UiPageRules.extractAll(snapshot(listOf(node("title","Generated title"))),rules(articleRule())).isEmpty())
        assertTrue(UiPageRules.extractAll(snapshot(listOf(node("title","Generated title"),node("body","text")),"2"),rules(articleRule())).isEmpty())
        val ambiguous=snapshot(listOf(node("title","A"),node("title2","B",resource="fixture:id/title"),node("body","text")))
        assertTrue(UiPageRules.extractAll(ambiguous,rules(articleRule())).isEmpty())
    }
    @Test fun productCardsRemainSeparateAndKeepUnverifiedLinksAsLiteralTextWithoutIdentity() {
        val rule=articleRule().put("kind","product").put("region",JSONObject().put("resourceId","fixture:id/list")).put("repeat",JSONObject().put("resourceId","fixture:id/card"))
            .put("repeatParent",JSONObject().put("resourceId","fixture:id/list")).put("fields",JSONObject().put("title",field("title",true)).put("url",field("url")))
        val input=snapshot(listOf(node("list"),node("one",parent="list",resource="fixture:id/card"),node("title","Generated product",parent="one"),node("url","javascript:alert(1)",parent="one"),
            node("two",parent="list",resource="fixture:id/card",index=1),node("title2","Generated product",parent="two",resource="fixture:id/title"),node("url2","https://example.invalid/item/2",parent="two",resource="fixture:id/url")))
        val pages=UiPageRules.extractAll(input,rules(rule))
        assertEquals(2,pages.size)
        assertEquals(listOf("javascript:alert(1)"),values(pages[0],"url"))
        assertFalse(pages[0].getJSONArray("objects").getJSONObject(0).has("identity"))
        assertEquals(listOf("https://example.invalid/item/2"),values(pages[1],"url"))
        assertTrue(pages.all { it.getJSONArray("objects").length()==1 })
    }
    @Test fun positionalPathsUseOriginalChildIndicesAndRejectMissingOrAmbiguousChildren() {
        val rule=articleRule().put("kind","product").put("region",JSONObject().put("resourceId","fixture:id/card"))
            .put("fields",JSONObject().put("title",field("title",true).put("childPath",JSONArray(listOf(2)))))
        val input=snapshot(listOf(node("card"),node("title","Correct original third child",parent="card",index=2),node("noise","Earlier hidden sibling",parent="card",index=0)))
        assertEquals("Correct original third child",values(UiPageRules.extractAll(input,rules(rule)).single(),"title").single())
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
    @Test fun boundaryCharacterOverlapKeepsParagraphsBeforeAndAfterTheSharedBoundary() {
        val overlap="Generated exact boundary text with at least thirty two characters. "
        val merge=UiPageMerge()
        merge.accepted(article(listOf("Earlier paragraph","Before. "+overlap)),"session")
        val current=article(listOf(overlap+"After.","Following paragraph"),whenAt="2026-10-10T00:00:30Z")
        val combined=merge.merge(current,"session")
        assertEquals(listOf("Earlier paragraph","Before. "+overlap+"After.","Following paragraph"),body(combined))
        assertEquals(2,combined.getJSONObject("observations").getInt("count"))
    }
    @Test fun stateValuesAndInvalidOrCredentialBearingUrlsCannotUnifyIndependentObservations() {
        fun identified(body:List<String>,name:String,text:String,source:String):JSONObject {
            val page=article(body,identity=false)
            page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields").put(JSONObject().put("name",name)
                .put("values",JSONArray().put(JSONObject().put("text",text).put("source",source))))
            return page
        }
        val rejected=listOf(
            Triple("url","javascript:alert(1)","text"),Triple("url","file:///generated/article","text"),
            Triple("url","https://generated:secret@example.invalid/article","text"),Triple("url","https://example.invalid/white space","text"),
            Triple("url","https://example.invalid:99999/article","text"),Triple("url","https:///missing-host","text"),
            Triple("url","https://example.invalid/article","state"),Triple("item_id","selected","state"))
        for((name,id,source) in rejected) {
            val merge=UiPageMerge();merge.accepted(identified(listOf("A","B"),name,id,source),"session")
            val current=identified(listOf("B","C"),name,id,source)
            assertEquals(id,listOf("B","C"),body(merge.merge(current,"session")))
            assertEquals(id,1,merge.merge(current,"session").getJSONObject("observations").getInt("count"))
        }
        for((name,id) in listOf("url" to "https://example.invalid/article","url" to "HTTP://example.invalid/article","item_id" to "generated-observed-id")) {
            val merge=UiPageMerge();merge.accepted(identified(listOf("A","B"),name,id,"text"),"session")
            assertEquals(id,listOf("A","B","C"),body(merge.merge(identified(listOf("B","C"),name,id,"text"),"session")))
        }
    }
    @Test fun allSixtyFourBodyValuesCanAccumulateAlongsideTheOtherSixtyFourNamedValues() {
        fun full():JSONObject=article((0 until 64).map {"Generated paragraph $it"}).apply {
            getJSONArray("objects").getJSONObject(0).getJSONArray("fields").put(JSONObject().put("name","related_items").put("values",JSONArray((0 until 61).map {
                JSONObject().put("text","Generated related item $it").put("source","text")
            })))
        }
        val merge=UiPageMerge();merge.accepted(full(),"session")
        val combined=merge.merge(full(),"session")
        assertEquals((0 until 64).map {"Generated paragraph $it"},body(combined))
        assertEquals(2,combined.getJSONObject("observations").getInt("count"))
        val fields=combined.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
        assertEquals(128,(0 until fields.length()).sumOf {fields.getJSONObject(it).getJSONArray("values").length()})
        NamedPageRules.validatePage(combined)
    }
    @Test fun screenshotSelectionSurvivesStructuredSuccessFailureAndEmptyResults() {
        for(outcome in UiPageOutcome.entries) {
            assertFalse(outcome.name,UiPageCaptureChoice.screenshot(false,outcome))
            assertEquals(outcome.name,outcome !in setOf(UiPageOutcome.PRIVACY_REJECTED,UiPageOutcome.STATE_CHANGED),UiPageCaptureChoice.screenshot(true,outcome))
        }
    }
    @Test fun rejectNewRulesWithoutVersionOrSafeFieldContracts() {
        for(rule in listOf(JSONObject(articleRule().toString()).apply { remove("appVersion") }, articleRule().put("formatVersion",2),
            articleRule().put("fields",JSONObject().put("Title",field("title",true))), articleRule().put("script","execute"), articleRule().put("repeatParent",JSONObject().put("role","Text")))) {
            try { rules(rule);fail(rule.toString()) } catch(_:IllegalArgumentException) { }
        }
    }
    @Test fun v3UploadContainsOnlyNamedOriginalFieldsAndAlignedObservationMetadata() {
        val page=article(listOf("Generated original paragraph"))
        fun event(value: JSONObject) = JSONObject().put("source","ui_page").put("durationMs",0).put("appId","fixture").put("capturedAt",at).put("ocrText",UiPageRules.text(value))
            .put("privacy",JSONObject().put("collection","content")).put("metadata",JSONObject().put("observedAt",at).put("collector",JSONObject().put("method","accessibility")).put("uiPage",value))
        UiPageRules.validateEvent(event(page))
        val contaminated=JSONObject(page.toString()).put("nodes",JSONArray().put(node("body","Raw tree")))
        try { UiPageRules.validateEvent(event(contaminated));fail("raw nodes") } catch(_:IllegalArgumentException) { }
        val badIdentity=JSONObject(page.toString()).apply { getJSONArray("objects").getJSONObject(0).put("identity",JSONObject().put("type","url").put("value","https://example.invalid/guessed")) }
        try { UiPageRules.validateEvent(event(badIdentity));fail("guessed identity") } catch(_:IllegalArgumentException) { }
        val mismatched=event(page).apply { getJSONObject("metadata").put("observedAt","2026-10-10T00:00:30Z") }
        try { UiPageRules.validateEvent(mismatched);fail("misaligned metadata") } catch(_:IllegalArgumentException) { }
    }
    @Test fun maximumFieldBudgetAllowsAllProjectionSeparators() {
        // Preserve the original 64 body values plus header fields and exact 64 KiB text budget.
        fun header(name:String,text:String)=JSONObject().put("name",name).put("values",JSONArray().put(JSONObject().put("text",text).put("source","text")))
        val body=JSONArray((0 until 64).map {JSONObject().put("text","p".repeat(if(it==0)1300 else 900)).put("source","text")})
        val fields=JSONArray().put(header("title","t".repeat(2000))).put(header("author","a".repeat(1000)))
            .put(header("url","https://example.invalid/"+"u".repeat(2000-"https://example.invalid/".length))).put(header("item_id","i".repeat(1000)))
            .put(JSONObject().put("name","body").put("values",body))
        val page=article(listOf("unused")).apply { getJSONArray("objects").getJSONObject(0).put("fields",fields) }
        assertEquals(64067,UiPageRules.text(page).length)
        fun event()=JSONObject().put("source","ui_page").put("durationMs",0).put("appId","fixture").put("capturedAt",at).put("ocrText",UiPageRules.text(page))
            .put("privacy",JSONObject().put("collection","content")).put("metadata",JSONObject().put("observedAt",at).put("collector",JSONObject().put("method","accessibility")).put("uiPage",page))
        UiPageRules.validateEvent(event())
        val merge=UiPageMerge();merge.accepted(page,"session")
        assertEquals(2,merge.merge(JSONObject(page.toString()),"session").getJSONObject("observations").getInt("count"))
        body.getJSONObject(0).put("text","p".repeat(1301))
        assertThrows(IllegalArgumentException::class.java) { UiPageRules.validateEvent(event()) }
    }
    @Test fun mergeRetainsPartialStatusAndNeverRelabelsOcrAsAccessibilityText() {
        val merge=UiPageMerge()
        val prior=article(listOf("Paragraph A","Paragraph B")).put("truncated",true).put("status","partial")
        merge.accepted(prior,"session")
        val combined=merge.merge(article(listOf("Paragraph B","Paragraph C")),"session")
        assertTrue(combined.getBoolean("truncated"));assertEquals("partial",combined.getString("status"))
        fun ocr(page:JSONObject):JSONObject {
            val fields=page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
            val body=(0 until fields.length()).map(fields::getJSONObject).single { it.getString("name")=="body" }.getJSONArray("values")
            for(i in 0 until body.length())body.getJSONObject(i).put("source","ocr")
            return page
        }
        val recognized=UiPageMerge();recognized.accepted(ocr(article(listOf("Paragraph A","Paragraph B"))),"session")
        val current=recognized.merge(ocr(article(listOf("Paragraph B","Paragraph C"))),"session")
        val fields=current.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
        val body=(0 until fields.length()).map(fields::getJSONObject).single { it.getString("name")=="body" }.getJSONArray("values")
        assertTrue((0 until body.length()).all { body.getJSONObject(it).getString("source")=="ocr" })
    }
    @Test fun exceedingAccumulationBudgetPreservesTheCurrentVisibleFragment() {
        val merge=UiPageMerge()
        val before=article((0 until 61).map { "Generated paragraph $it" })
        merge.accepted(before,"session")
        val after=article((60 until 121).map { "Generated paragraph $it" },whenAt="2026-10-10T00:00:30Z")
        val result=merge.merge(after,"session")
        assertEquals(body(after),body(result))
        assertEquals("Generated paragraph 120",body(result).last())
        assertEquals(1,result.getJSONObject("observations").getInt("count"))
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
