package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Configuration metadata only. A matching version never claims a live page was validated. */
internal object AppPageSetup {
    data class Adapter(val id: String, val kind: String, val fields: Set<String>)
    fun adapters(raw: String, appId: String, appVersion: String): List<Adapter> = UiPageRules.parse(raw)
        .filter { it.optInt("formatVersion") == 2 && it.optString("platform") == "android" &&
            it.optString("appId") == appId && appVersion.isNotBlank() && it.optString("appVersion") == appVersion }
        .map { Adapter(it.getString("id"), it.getString("kind"), it.getJSONObject("fields").keys().asSequence().toSet()) }

    /** Import only the selected installed version; do not widen app content authorization. */
    fun merge(current: String, imported: String, appId: String, appVersion: String): String {
        val incoming = UiPageRules.parse(imported)
        require(appVersion.isNotBlank() && incoming.isNotEmpty() && incoming.all {
            it.optInt("formatVersion") == 2 && it.optString("platform") == "android" &&
                it.optString("appId") == appId && it.optString("appVersion") == appVersion
        }) { MoteI18n.text("规则必须是所选应用当前版本的文章或商品字段规则") }
        val replace = incoming.map { it.getString("id") }.toSet()
        val previous = UiPageRules.parse(current)
        require(previous.none { it.optString("appId") != appId && it.getString("id") in replace }) {
            MoteI18n.text("规则 ID 与其他应用冲突，请为导入规则使用独立 ID")
        }
        val retained = previous.filterNot { it.getString("id") in replace }
        return JSONArray(retained + incoming).toString(2).also { UiPageRules.parse(it) }
    }

    fun fieldRule(appId: String, appVersion: String, kind: String, selectors: Map<String, String>,
        activity: String = "", region: String = "", repeat: String = ""): String {
        require(appVersion.isNotBlank()) { MoteI18n.text("无法读取应用版本，请重新选择已安装应用") }
        require(kind in setOf("article", "product"))
        require(!selectors["title"].isNullOrBlank() && (kind != "article" || !selectors["body"].isNullOrBlank())) {
            MoteI18n.text("标题控件 ID 必填；文章还需要正文控件 ID")
        }
        val fields = JSONObject()
        selectors.filterValues { it.isNotBlank() }.forEach { (field, id) ->
            fields.put(field, JSONObject().put("select", JSONObject().put("resourceId", id.trim()))
                .put("required", field == "title" || kind == "article" && field == "body"))
        }
        val rule = JSONObject().put("formatVersion", 2).put("id", "$appId.$appVersion.$kind")
            .put("version", "1").put("platform", "android").put("appId", appId).put("appVersion", appVersion)
            .put("kind", kind).put("fields", fields)
        if (activity.isNotBlank()) rule.put("activity", activity.trim())
        if (region.isNotBlank()) rule.put("region", JSONObject().put("resourceId", region.trim()))
        if (repeat.isNotBlank()) rule.put("repeat", JSONObject().put("resourceId", repeat.trim()))
        return JSONArray().put(rule).toString(2).also { UiPageRules.parse(it) }
    }
}
