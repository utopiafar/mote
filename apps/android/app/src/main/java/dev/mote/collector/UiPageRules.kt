package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Pure bounded structural rules. No executable code, network, actions, or semantic classification. */
object UiPageRules {
    val modes = listOf("screen_only", "hybrid", "ui_preferred", "page_only")
    private val selectorKeys = setOf("resourceId", "role", "textEquals")
    fun parse(raw: String): List<JSONObject> {
        require(raw.toByteArray().size <= 65536); StrictJson.validate(raw)
        val array = JSONArray(raw); require(array.length() <= 32)
        val ids = mutableSetOf<String>()
        return (0 until array.length()).map { i ->
            array.getJSONObject(i).also { r ->
                require(r.keys().asSequence().all { it in setOf("id", "version", "platform", "appId", "activity", "appVersion", "required", "select", "ancestor", "complete") })
                for (key in listOf("id", "version", "platform", "appId")) require(r.get(key) is String && r.getString(key).length in 1..300)
                require(ids.add(r.getString("id")) && r.getString("platform") in setOf("android", "macos"))
                for (key in listOf("activity", "appVersion")) if (r.has(key)) require(r.get(key) is String && r.getString(key).length in 1..300)
                if (r.has("complete")) require(r.get("complete") is Boolean)
                selector(r.getJSONObject("select")); if (r.has("ancestor")) selector(r.getJSONObject("ancestor"))
                if (r.has("required")) { val required = r.getJSONArray("required"); require(required.length() <= 8); for (j in 0 until required.length()) selector(required.getJSONObject(j)) }
            }
        }
    }
    private fun selector(s: JSONObject) {
        require(s.length() in 1..3 && s.keys().asSequence().all { it in selectorKeys })
        for (key in s.keys()) require(s.get(key) is String && s.getString(key).length in (if (key == "textEquals") 0..500 else 1..300))
    }
    private fun matches(n: JSONObject, s: JSONObject) = s.keys().asSequence().all { n.optString(if (it == "textEquals") "text" else it) == s.getString(it) }
    fun extract(snapshot: JSONObject, rules: List<JSONObject>): JSONObject? {
        val all = snapshot.getJSONArray("nodes"); require(all.length() <= 256)
        val nodes = (0 until all.length()).map(all::getJSONObject)
        val byId = nodes.associateBy { it.getString("id") }
        for (r in rules) {
            if (r.getString("platform") != "android" || r.getString("appId") != snapshot.getString("appId")) continue
            if (listOf("activity", "appVersion").any { r.has(it) && r.getString(it) != snapshot.optString(it) }) continue
            val required = r.optJSONArray("required") ?: JSONArray()
            if ((0 until required.length()).any { j -> nodes.none { matches(it, required.getJSONObject(j)) } }) continue
            val chosen = nodes.filter { n ->
                if (n.optString("text").isBlank() || !matches(n, r.getJSONObject("select"))) false
                else if (!r.has("ancestor")) true
                else { var parent = n.optString("parentId"); var found = false
                    for (depth in 0 until 32) { val p = byId[parent] ?: break; if (matches(p, r.getJSONObject("ancestor"))) { found = true; break }; parent = p.optString("parentId") }; found }
            }.map { JSONObject(it.toString()).apply { remove("parentId") } }
            if (chosen.isNotEmpty()) return JSONObject().put("version", 1).put("scope", "visible_window").put("adapterId", r.getString("id"))
                .put("adapterVersion", r.getString("version")).put("activity", snapshot.optString("activity")).put("appVersion", snapshot.optString("appVersion"))
                .put("status", if (r.optBoolean("complete") && !snapshot.getBoolean("truncated")) "ok" else "partial")
                .put("truncated", snapshot.getBoolean("truncated")).put("nodes", JSONArray(chosen))
        }
        return null
    }
    fun text(page: JSONObject): String = page.getJSONArray("nodes").let { nodes -> (0 until nodes.length()).joinToString("\n") { nodes.getJSONObject(it).getString("text") } }
    fun validateEvent(event: JSONObject) {
        require(event.getString("source") == "ui_page" && event.getLong("durationMs") == 0L)
        require(event.getJSONObject("privacy").getString("collection") == "content")
        require(event.getString("appId").isNotBlank() && listOf("imageMime", "imageBase64", "ocr", "mood", "provenance").none(event::has))
        val metadata=event.getJSONObject("metadata"); require(metadata.getJSONObject("collector").getString("method")=="accessibility")
        val p=metadata.getJSONObject("uiPage"); require(p.getInt("version")==1 && p.getString("scope")=="visible_window" && p.getString("status") in setOf("ok","partial"))
        require(!(p.getBoolean("truncated") && p.getString("status")=="ok"))
        val nodes=p.getJSONArray("nodes"); require(nodes.length() in 1..256)
        val text=text(p); require(text.length<=32255 && event.getString("ocrText")==text)
    }
}
