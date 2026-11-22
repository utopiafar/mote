package dev.mote.collector

import org.json.JSONObject
import java.net.URLEncoder

/** Current owner read capability; the host resolves any virtual identity again at DELETE. */
internal object CentralDeletion {
    fun kind(record: JSONObject): String? {
        val capability=record.optJSONObject("deletion") ?: return null
        if (capability.opt("available") != true) return null
        return capability.opt("kind").takeIf { it == "capture" || it == "file" } as? String
    }
    fun requireCompleted(receipt: JSONObject): JSONObject {
        val count=receipt.opt("deleted") as? Number
        val value=count?.toDouble()
        check(value != null && value.isFinite() && value > 0 && value <= 9_007_199_254_740_991.0 && value % 1.0 == 0.0) { MoteI18n.text("未能确认删除完成。刷新查看当前状态") }
        return receipt
    }
    fun evidence(api: CentralClient, id: String, expectedKind: String): JSONObject {
        val encoded=URLEncoder.encode(id,"UTF-8")
        val current=api.get("/api/capture-browser/"+encoded)
        check(current.optString("id") == id && kind(current) == expectedKind) { MoteI18n.text("此引用不能直接删除原始记录。") }
        val path="/api/captures/"+encoded
        return delete(api,path)
    }
    fun delete(api: CentralClient, path: String): JSONObject = try { requireCompleted(api.delete(path)) }
    catch(error: CentralFailure) { throw error }
    catch(error: Exception) { throw IllegalStateException(MoteI18n.text("未能确认删除完成。刷新查看当前状态"),error) }
}
