package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UiPageRulesTest {
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
    @Test fun sharedConformance() {
        val cases=JSONArray();for(path in listOf("/conformance.json","/builtin-coverage.json")){val batch=JSONArray(javaClass.getResource(path)!!.readText());for(i in 0 until batch.length())cases.put(batch.getJSONObject(i))}
        for(i in 0 until cases.length()) {
            val f=cases.getJSONObject(i); if(f.getString("platform")!="android")continue
            val result=UiPageRules.extract(f.getJSONObject("snapshot"),UiPageRules.parse(f.getJSONArray("rules").toString()))
            if(f.isNull("expected"))assertNull(f.getString("name"),result)
            else { val expected=f.getJSONObject("expected");assertNotNull(result);assertEquals(expected.getString("status"),result!!.getString("status"))
                val nodes=result.getJSONArray("nodes");assertEquals(expected.getJSONArray("ids").toString(),JSONArray((0 until nodes.length()).map { nodes.getJSONObject(it).getString("id") }).toString()) }
        }
    }
    @Test fun rejectsExecutableAndUnboundedRules() {
        val rule=JSONObject("""{"id":"fixture","version":"1","platform":"android","appId":"fixture","select":{"role":"Text"}}""")
        for(key in listOf("script","action","fetch")) {val invalid=JSONObject(rule.toString()).put(key,"evil");try{UiPageRules.parse(JSONArray().put(invalid).toString());fail(key)}catch(_:IllegalArgumentException){}}
        try{UiPageRules.parse(JSONArray().put(rule).put(rule).toString());fail("duplicate")}catch(_:IllegalArgumentException){}
    }
    @Test fun configRoundTrip() {
        val config=CollectorConfig(deviceName="Generated",uiPageMode="hybrid",uiPageRules="[]")
        val restored=ConfigurationArchive.decode(ConfigurationArchive.encode(config),CollectorConfig(deviceName="Generated"))
        assertEquals(config.uiPageMode,restored.uiPageMode);assertEquals(config.uiPageRules,restored.uiPageRules)
    }
}
