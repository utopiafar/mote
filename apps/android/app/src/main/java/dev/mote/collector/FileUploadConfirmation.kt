package dev.mote.collector

import org.json.JSONObject

/** One final-ACK validator for normal commit, already-received begin, and safe local recovery. */
internal object FileUploadConfirmation {
    fun canonicalId(sourceId: String, manifest: JSONObject, ack: JSONObject): String {
        check(IngressV2Protocol.validFile(sourceId,manifest.getJSONObject("item"),ack)) { MoteI18n.text("中央归档确认不匹配") }
        val id = ack.getString("id")
        check(!ack.has("captureId") || ack.opt("captureId") == id) { MoteI18n.text("中央归档确认不匹配") }
        if(manifest.has("sha256")) check(ack.optString("sha256")==manifest.getString("sha256") && ack.optLong("sizeBytes",-1)==manifest.getLong("sizeBytes")) { MoteI18n.text("中央原件校验确认不匹配") }
        return id
    }
    fun part(ack: JSONObject, index: Int, bytes: ByteArray) {
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        check(ack.optInt("part",-1)==index && ack.optLong("bytes",-1)==bytes.size.toLong() && ack.optString("hash")==hash) { MoteI18n.text("文件块确认不匹配") }
    }
    fun envelope(identity: ItemUploadIdentity, id: String): JSONObject {
        val receipt = JSONObject().put("version",2).put("id",id).put("kind","file-revision").put("state","received").put("duplicate",true)
            .put("sourceId",identity.sourceId).put("externalId",identity.externalId).put("revision",identity.revision)
        return JSONObject().put("id",id).put("captureId",id).put("sourceId",identity.sourceId).put("externalId",identity.externalId).put("revision",identity.revision)
            .put("sha256",identity.sha256).put("sizeBytes",identity.sizeBytes).put("receipt",receipt)
    }
}
