package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A record entry may never rewrite the scope of an already accepted or retryable question. */
internal object NativeAskEvidenceScope {
    fun select(state: JSONObject, id: String): Boolean = selectRecord(state, id, false)
    fun selectOnly(state: JSONObject, id: String): Boolean = selectRecord(state, id, true)
    private fun selectRecord(state: JSONObject, id: String, only: Boolean): Boolean {
        UUID.fromString(id)
        val key = if (only) "evidenceIds" else "anchorEvidenceIds"
        val other = if (only) "anchorEvidenceIds" else "evidenceIds"
        if (NativeAskRunState.busy(state)) {
            val selected = wire(state, key)
            return selected?.length() == 1 && selected.optString(0) == id && wire(state, other) == null && wireMaterial(state) == null
        }
        state.put(key, JSONArray().put(id)).put(other, JSONObject.NULL).put("anchorMaterialRef", JSONObject.NULL).put("scopeDirty", true)
        return true
    }
    fun material(state: JSONObject): String? = state.opt("anchorMaterialRef").let { it as? String }?.takeIf { it.matches(Regex("material:mat_[a-f0-9]{64}@[a-f0-9]{64}")) }
    fun selectMaterial(state: JSONObject, reference: String): Boolean {
        require(reference.matches(Regex("material:mat_[a-f0-9]{64}@[a-f0-9]{64}")))
        if (NativeAskRunState.busy(state)) {
            return wireMaterial(state) == reference && wire(state, "evidenceIds") == null && wire(state, "anchorEvidenceIds") == null
        }
        state.put("anchorMaterialRef", reference).put("evidenceIds", JSONObject.NULL).put("anchorEvidenceIds", JSONObject.NULL).put("scopeDirty", true)
        return true
    }
    fun clear(state: JSONObject): Boolean {
        if (NativeAskRunState.busy(state)) return false
        state.put("evidenceIds", JSONObject.NULL).put("anchorEvidenceIds", JSONObject.NULL).put("anchorMaterialRef", JSONObject.NULL).put("scopeDirty", true)
        state.remove("scopeLabel")
        return true
    }
    fun writeInput(state: JSONObject, input: JSONObject) {
        for (key in listOf("evidenceIds", "anchorEvidenceIds", "anchorMaterialRef")) if (state.has(key)) input.put(key, state.get(key))
    }
    fun restore(state: JSONObject, conversation: JSONObject) {
        if (state.optBoolean("scopeDirty") || NativeAskRunState.busy(state)) return
        for (key in listOf("evidenceIds", "anchorEvidenceIds")) {
            val evidence = conversation.optJSONObject("scope")?.optJSONArray(key)
            if (evidence != null) state.put(key, JSONArray(evidence.toString())) else state.remove(key)
        }
        val reference = conversation.optJSONObject("scope")?.let(::material)
        if (reference != null) state.put("anchorMaterialRef", reference) else state.remove("anchorMaterialRef")
        state.remove("scopeLabel")
    }

    /** The exact admission wins while it is unresolved; after acceptance the
     * local scope mirrors the immutable question that produced the message. */
    private fun wire(state: JSONObject, key: String): JSONArray? {
        val pending = state.optJSONObject("pending") ?: return state.optJSONArray(key)
        return if (key == "evidenceIds") pending.optJSONObject("scope")?.optJSONArray(key) else pending.optJSONArray(key)
    }

    private fun wireMaterial(state: JSONObject): String? {
        val pending = state.optJSONObject("pending") ?: return material(state)
        return pending.optString("anchorMaterialRef").takeIf(String::isNotBlank)
    }
}
