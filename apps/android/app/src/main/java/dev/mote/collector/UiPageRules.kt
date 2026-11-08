package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Pure bounded structural rules. No executable code, network, actions, or semantic classification. */
object UiPageRules {
    val modes = listOf("screen_only", "hybrid", "ui_preferred", "page_only")
    fun parse(raw: String): List<JSONObject> {
        require(raw.toByteArray().size <= 1048576); StrictJson.validate(raw)
        val array = JSONArray(raw); require(array.length() <= 512)
        val ids = mutableSetOf<String>()
        return (0 until array.length()).map { i ->
            array.getJSONObject(i).also { r ->
                require(r.optInt("formatVersion") == 3)
                NamedPageRules.validate(r); require(ids.add(r.getString("id")))
            }
        }
    }
    private fun matches(n: JSONObject, s: JSONObject) = s.keys().asSequence().all { n.optString(if (it == "textEquals") "text" else it) == s.getString(it) }
    /** New collection never publishes the local tree. Each object has an immutable queue record. */
    fun extractAll(snapshot: JSONObject, rules: List<JSONObject>, observedAt: String = snapshot.optString("observedAt")): List<JSONObject> {
        if (runCatching { java.time.Instant.parse(observedAt) }.isFailure) return emptyList()
        val all = snapshot.getJSONArray("nodes"); require(all.length() <= 256)
        val nodes = (0 until all.length()).map(all::getJSONObject)
        val allPages=mutableListOf<JSONObject>()
        for (rule in rules) {
            if(rule.optInt("formatVersion")!=3 || rule.getString("platform")!="android" || rule.getString("appId")!=snapshot.getString("appId") || rule.getString("appVersion")!=snapshot.optString("appVersion") || rule.has("activity")&&rule.getString("activity")!=snapshot.optString("activity")) continue
            val required=rule.optJSONArray("required")?:JSONArray();if((0 until required.length()).all {j->nodes.any{matches(it,required.getJSONObject(j))}})allPages+=NamedPageRules.extract(snapshot,rule,observedAt)
            if(allPages.size>=64)break
        }
        if(allPages.size>=64)allPages.take(64).forEach{it.put("truncated",true).put("status","partial")}
        return allPages.take(64)
    }
    fun text(page: JSONObject): String = NamedPageRules.text(page)
    fun validateEvent(event:JSONObject){
        require(event.getString("source")=="ui_page"&&event.getLong("durationMs")==0L&&event.getJSONObject("privacy").getString("collection")=="content")
        require(listOf("imageMime","imageBase64","ocr","mood","provenance").none(event::has))
        val m=event.getJSONObject("metadata");require(m.getJSONObject("collector").getString("method")=="accessibility")
        val p=m.getJSONObject("uiPage");NamedPageRules.validatePage(p)
        require(p.keys().asSequence().toSet()==setOf("version","scope","adapterId","adapterVersion","activity","appVersion","status","truncated","observations","objects"))
        require(p.getString("scope")=="visible_window"&&p.getString("status") in setOf("ok","partial")&&!(p.getBoolean("truncated")&&p.getString("status")=="ok"))
        val times=p.getJSONObject("observations");require(times.keys().asSequence().toSet()==setOf("firstAt","lastAt","count")&&times.getInt("count") in 1..256&&times.getDouble("count")==times.getInt("count").toDouble())
        require(times.getString("lastAt")==event.getString("capturedAt")&&m.getString("observedAt")==event.getString("capturedAt")&&!java.time.Instant.parse(times.getString("firstAt")).isAfter(java.time.Instant.parse(times.getString("lastAt"))))
        require(event.getString("ocrText")==text(p))
    }
}
