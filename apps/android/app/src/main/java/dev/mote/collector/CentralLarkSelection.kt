package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Source ranges use native controls; changing document scope preserves calendar and pause settings. */
internal object CentralLarkSelection {
    fun failure(code: String) = MoteI18n.text(when (code) {
        "lark_permission_required" -> "飞书只读权限未完整授予"
        "lark_not_connected" -> "尚未连接飞书账号，完成只读授权"
        "lark_authorization_expired" -> "授权链接已过期，重新发起登录"
        "lark_partial_failure" -> "部分文档未完成读取，成功归档已保留。逐篇重试失败项"
        "lark_document_scope_changed" -> "文档范围已变化，保存后重新预览"
        "lark_document_not_selected" -> "此文档已不在同步范围内，检查范围后重试"
        "lark_document_archive_required" -> "确认后此来源保留正文原件"
        else -> "飞书操作失败，重新检测连接后重试"
    })
    fun references(value: String) = JSONArray(value.lines().map(String::trim).filter(String::isNotEmpty))
    fun text(value: JSONObject, key: String): String = value.optJSONArray(key)?.let { rows ->
        (0 until rows.length()).joinToString("\n") { rows.getString(it) }
    }.orEmpty()
    fun discovery(value: JSONObject) = value.optJSONObject("documentDiscovery")
        ?: JSONObject().put("created", false).put("edited", false).put("opened", false).put("firstSyncDays", 30)
    fun payload(current: JSONObject, created: Boolean, edited: Boolean, opened: Boolean, days: String,
        documents: String, folders: String, wikiRoots: String, exclusions: String, autoSync: Boolean): JSONObject {
        val firstSyncDays = days.toIntOrNull()
        require(firstSyncDays != null && firstSyncDays >= 1) { MoteI18n.text("首次回溯天数必须是正整数。") }
        return JSONObject(current.toString()).put("documentDiscovery", JSONObject().put("created", created)
            .put("edited", edited).put("opened", opened).put("firstSyncDays", firstSyncDays))
            .put("documents", references(documents)).put("folders", references(folders)).put("wikiRoots", references(wikiRoots))
            .put("excludedDocuments", references(exclusions)).put("autoSync", autoSync)
    }
}
