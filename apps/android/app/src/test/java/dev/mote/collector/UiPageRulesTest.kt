package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UiPageRulesTest {
    @Test fun portableSubtreeJsonMatchesNodeIncludingEscapesAndUnpairedSurrogates() {
        assertEquals("f7663005ee16f9914f4245624a683e396a5973f9735bfde989cf614aaf265fab",UiStructureHash.hash("dev.generated:id/root","android.view.ViewGroup",emptyList()))
        assertEquals("5f54ca9724e6fcf1c8c7b6ff59d2c37549f9672a98274c6e6e7f89c1b3b0c1a0",UiStructureHash.hash("generated/路径","role\"\\\n😀",listOf("abc")))
        assertEquals("516caa0ea195791312a69335fb752c858c2c1738d7d7536772ab10acfc1405cf",UiStructureHash.hash("\uD800","\uDC00",emptyList()))
    }
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    @Test fun structuredSharedConformance() {
        val cases = JSONArray(javaClass.getResource("/structured-conformance.json")!!.readText())
        for (i in 0 until cases.length()) {
            val fixture = cases.getJSONObject(i)
            if (fixture.getString("platform") != "android") continue
            val pages = UiPageRules.extractAll(fixture.getJSONObject("snapshot"), UiPageRules.parse(fixture.getJSONArray("rules").toString()))
            assertEquals(fixture.getString("name"), canonical(fixture.getJSONArray("expected")), canonical(JSONArray(pages)))
        }
    }
    @Test fun builtinWechatAndTaobaoFieldsRemainIdenticalAfterV3Migration() {
        val cases=JSONArray(javaClass.getResource("/structured-conformance.json")!!.readText())
        for(name in listOf("builtin-wechat-article-android-8.0.78-visible","builtin-taobao-products-android-10.66.22-visible")) {
            val fixture=(0 until cases.length()).map(cases::getJSONObject).single{it.getString("name")==name}
            val rule=fixture.getJSONArray("rules").getJSONObject(0)
            assertEquals(name,3,rule.getInt("formatVersion"))
            val pages=UiPageRules.extractAll(fixture.getJSONObject("snapshot"),UiPageRules.parse(fixture.getJSONArray("rules").toString()))
            assertEquals(name,1,pages.size)
            val expected=fixture.getJSONArray("expected").getJSONObject(0).getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
            assertEquals(name,canonical(expected),canonical(pages.single().getJSONArray("objects").getJSONObject(0).getJSONArray("fields")))
        }
    }
    @Test fun retiredRuleFormatsAreRejectedWithoutExtraction() {
        val snapshot=JSONObject().put("appId","fixture").put("appVersion","1").put("activity","fixture.Page").put("observedAt","2026-10-24T00:00:00Z").put("truncated",false)
            .put("nodes",JSONArray().put(JSONObject().put("id","body").put("resourceId","fixture:id/body").put("role","Text").put("text","Generated body")))
        val v1=JSONObject("""{"id":"fixture.v1","version":"1","platform":"android","appId":"fixture","select":{"resourceId":"fixture:id/body"}}""")
        val v2=JSONObject("""{"formatVersion":2,"id":"fixture.v2","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"article","fields":{"title":{"select":{"role":"Text"},"required":true},"body":{"select":{"resourceId":"fixture:id/body"},"required":true}}}""")
        val unversioned=JSONObject("""{"id":"fixture.unversioned","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"visible_text","fields":{"visible_text":{"select":{"role":"Text"}}}}""")
        for(rule in listOf(v1,v2,unversioned)) {
            try { UiPageRules.parse(JSONArray().put(rule).toString());fail(rule.getString("id")) } catch(_:IllegalArgumentException) { }
            assertTrue(rule.getString("id"),UiPageRules.extractAll(snapshot,listOf(rule)).isEmpty())
        }
    }
    @Test fun retiredSelectedNodeFixturesAreRejectedBeforeExtraction() {
        for(path in listOf("/conformance.json","/builtin-coverage.json")) {
            val cases=JSONArray(javaClass.getResource(path)!!.readText())
            for(i in 0 until cases.length()) {
                val fixture=cases.getJSONObject(i);if(fixture.getString("platform")!="android")continue
                try { UiPageRules.parse(fixture.getJSONArray("rules").toString());fail(fixture.getString("name")) } catch(_:IllegalArgumentException) { }
            }
        }
    }
    @Test fun namedFieldSharedConformanceMatchesReviewedStructureAndExactVersion() {
        val cases=JSONObject(javaClass.getResource("/named-field-conformance.json")!!.readText()).getJSONArray("cases")
        for(i in 0 until cases.length()) {
            val fixture=cases.getJSONObject(i);val snapshot=fixture.getJSONObject("snapshot");val rule=fixture.getJSONObject("rule")
            val rules=UiPageRules.parse(JSONArray().put(rule).toString());val pages=UiPageRules.extractAll(snapshot,rules)
            val expected=fixture.getJSONArray("expectedFields")
            if(expected.length()==0)assertTrue(fixture.getString("name"),pages.isEmpty())
            else {assertEquals(fixture.getString("name"),1,pages.size);assertEquals(canonical(expected),canonical(pages.single().getJSONArray("objects").getJSONObject(0).getJSONArray("fields")))}
            snapshot.put("appVersion",snapshot.getString("appVersion")+"-changed")
            assertTrue(fixture.getString("name"),UiPageRules.extractAll(snapshot,rules).isEmpty())
        }
    }
    @Test fun aLongRepeatedFieldCannotConsumeItsRequiredHeaderOrExceedThePerFieldLimit() {
        val nodes=JSONArray((0 until 70).map {JSONObject().put("id","p$it").put("resourceId","generated:id/paragraph").put("role","Text").put("text","Generated paragraph $it")})
        nodes.put(JSONObject().put("id","header").put("resourceId","generated:id/header").put("role","Text").put("text","Generated required header"))
        val snapshot=JSONObject().put("appId","generated").put("appVersion","1").put("activity","generated.Page").put("observedAt","2026-10-24T00:00:00Z").put("truncated",false).put("nodes",nodes)
        fun field(id:String,many:Boolean)=JSONObject().put("select",JSONObject().put("resourceId",id)).put("required",true).put("cardinality",if(many)"many" else "one")
        val rule=JSONObject().put("formatVersion",3).put("id","generated.repeat").put("version","1").put("platform","android").put("appId","generated").put("appVersion","1").put("kind","article")
            .put("fields",JSONObject().put("body",field("generated:id/paragraph",true)).put("z_header",field("generated:id/header",false)))
        val page=UiPageRules.extractAll(snapshot,UiPageRules.parse(JSONArray().put(rule).toString())).single()
        NamedPageRules.validatePage(page)
        assertTrue(page.getBoolean("truncated"));assertEquals("partial",page.getString("status"))
        val fields=page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
        assertEquals(64,fields.getJSONObject(0).getJSONArray("values").length())
        assertEquals("Generated paragraph 63",fields.getJSONObject(0).getJSONArray("values").getJSONObject(63).getString("text"))
        assertEquals("Generated required header",fields.getJSONObject(1).getJSONArray("values").getJSONObject(0).getString("text"))
    }
    @Test fun aggregateTextClippingNeverEmitsAHalfSurrogateOrAnEmptyRequiredField() {
        val nodes=JSONArray().put(JSONObject().put("id","long").put("resourceId","generated:id/long").put("role","Text").put("text","x".repeat(21333)))
            .put(JSONObject().put("id","emoji").put("resourceId","generated:id/emoji").put("role","Text").put("text","\uD83D\uDE00"))
        val snapshot=JSONObject().put("appId","generated").put("appVersion","1").put("activity","generated.Page").put("observedAt","2026-10-24T00:00:00Z").put("truncated",false).put("nodes",nodes)
        val fields=JSONObject()
        for(name in listOf("a","b","c"))fields.put(name,JSONObject().put("select",JSONObject().put("resourceId","generated:id/long")).put("required",true))
        fields.put("z",JSONObject().put("select",JSONObject().put("resourceId","generated:id/emoji")))
        val rule=JSONObject().put("formatVersion",3).put("id","generated.unicode").put("version","1").put("platform","android").put("appId","generated").put("appVersion","1").put("kind","visible_text").put("fields",fields)
        val page=UiPageRules.extractAll(snapshot,UiPageRules.parse(JSONArray().put(rule).toString())).single()
        NamedPageRules.validatePage(page)
        assertTrue(page.getBoolean("truncated"));assertEquals(3,page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields").length())
        assertEquals(64001,UiPageRules.text(page).length) // 63999 original units plus two separators.
        fields.getJSONObject("z").put("required",true)
        assertTrue(UiPageRules.extractAll(snapshot,UiPageRules.parse(JSONArray().put(rule).toString())).isEmpty())
    }
    @Test fun rejectsExecutableAndUnboundedRules() {
        val rule=JSONObject("""{"formatVersion":3,"id":"fixture","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"visible_text","fields":{"visible_text":{"select":{"role":"Text"}}}}""")
        for(key in listOf("script","action","fetch")) {val invalid=JSONObject(rule.toString()).put(key,"evil");try{UiPageRules.parse(JSONArray().put(invalid).toString());fail(key)}catch(_:IllegalArgumentException){}}
        try{UiPageRules.parse(JSONArray().put(rule).put(rule).toString());fail("duplicate")}catch(_:IllegalArgumentException){}
    }
    @Test fun configRoundTrip() {
        val config=CollectorConfig(deviceName="Generated",uiPageMode="hybrid",uiPageRules="[]")
        val restored=ConfigurationArchive.decode(ConfigurationArchive.encode(config),CollectorConfig(deviceName="Generated"))
        assertEquals(config.uiPageMode,restored.uiPageMode);assertEquals(config.uiPageRules,restored.uiPageRules)
    }
}
