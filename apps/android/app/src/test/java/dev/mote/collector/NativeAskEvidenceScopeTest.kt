package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class NativeAskEvidenceScopeTest {
    private val material="material:mat_"+"a".repeat(64)+"@"+"b".repeat(64)
    @Test fun `exact whole material remains one selection across history and explicit clear`() {
        val state=JSONObject().put("question","Generated private later question").put("attachments",JSONArray().put(JSONObject().put("id",UUID.randomUUID().toString())))
        assertTrue(NativeAskEvidenceScope.selectMaterial(state,material))
        val input=JSONObject();NativeAskEvidenceScope.writeInput(state,input)
        assertEquals(material,input.getString("anchorMaterialRef"));assertTrue(input.isNull("evidenceIds"));assertTrue(input.isNull("anchorEvidenceIds"))
        val restored=JSONObject();NativeAskEvidenceScope.restore(restored,JSONObject().put("scope",input));assertEquals(material,NativeAskEvidenceScope.material(restored))
        val question=state.getString("question");val attachments=state.getJSONArray("attachments").toString()
        assertTrue(NativeAskEvidenceScope.clear(state));NativeAskEvidenceScope.restore(state,JSONObject().put("scope",input))
        assertNull(NativeAskEvidenceScope.material(state));assertTrue(state.isNull("anchorMaterialRef"));assertEquals(question,state.getString("question"));assertEquals(attachments,state.getJSONArray("attachments").toString())
    }
    @Test fun `material and UUID selections replace one another but cannot rewrite an uncertain request`() {
        val state=JSONObject();val id=UUID.randomUUID().toString()
        NativeAskEvidenceScope.select(state,id);NativeAskEvidenceScope.selectMaterial(state,material);assertTrue(state.isNull("anchorEvidenceIds"))
        val input=JSONObject();NativeAskEvidenceScope.writeInput(state,input)
        state.put("pending",JSONObject().put("scope",JSONObject().put("kind","all")).put("anchorMaterialRef",input.getString("anchorMaterialRef")))
        val before=state.toString();assertFalse(NativeAskEvidenceScope.select(state,id));assertFalse(NativeAskEvidenceScope.clear(state));assertTrue(NativeAskEvidenceScope.selectMaterial(state,material));assertEquals(before,state.toString())
        state.remove("pending");NativeAskEvidenceScope.selectOnly(state,id);assertTrue(state.isNull("anchorMaterialRef"));assertEquals(id,state.getJSONArray("evidenceIds").getString(0))
    }
    @Test fun `record navigation cannot alter retryable question or accepted scope`() {
        val first = UUID.randomUUID().toString(); val other = UUID.randomUUID().toString()
        val pending = JSONObject().put("clientRequestId", UUID.randomUUID().toString())
            .put("conversationId", UUID.randomUUID().toString()).put("question", "Generated exact question")
            .put("scope", JSONObject().put("kind", "selection").put("evidenceIds", JSONArray().put(first)))
        val state = JSONObject().put("pending", pending).put("question", "Generated exact question").put("evidenceIds", JSONArray().put(first))
        val before = state.toString()
        assertFalse(NativeAskEvidenceScope.selectOnly(state, other)); assertEquals(before, state.toString())
        assertTrue(NativeAskEvidenceScope.selectOnly(state, first)); assertEquals(before, state.toString())
    }
    @Test fun `running question stays scoped and completed composer accepts a new explicit record`() {
        val first = UUID.randomUUID().toString(); val other = UUID.randomUUID().toString()
        val state = JSONObject().put("runStatus", "running").put("evidenceIds", JSONArray().put(first))
        assertFalse(NativeAskEvidenceScope.selectOnly(state, other)); assertEquals(first, state.getJSONArray("evidenceIds").getString(0))
        state.put("runStatus", "completed")
        assertTrue(NativeAskEvidenceScope.selectOnly(state, other)); assertEquals(other, state.getJSONArray("evidenceIds").getString(0))
    }
    @Test fun `wire distinguishes inherited scope from explicit clear and selected record`() {
        val state = JSONObject(); val inherited = JSONObject()
        NativeAskEvidenceScope.writeInput(state, inherited); assertFalse(inherited.has("evidenceIds"))
        val id = UUID.randomUUID().toString(); NativeAskEvidenceScope.selectOnly(state, id)
        val selected = JSONObject(); NativeAskEvidenceScope.writeInput(state, selected); assertEquals(id, selected.getJSONArray("evidenceIds").getString(0))
        state.put("scopeLabel", "Generated scope title")
        assertTrue(NativeAskEvidenceScope.clear(state)); assertFalse(state.has("scopeLabel"))
        val cleared = JSONObject(); NativeAskEvidenceScope.writeInput(state, cleared); assertTrue(cleared.has("evidenceIds")); assertTrue(cleared.isNull("evidenceIds"))
    }
    @Test fun `history restores accepted selection without undoing a local explicit clear`() {
        val id = UUID.randomUUID().toString(); val conversation = JSONObject().put("scope", JSONObject().put("evidenceIds", JSONArray().put(id)))
        val state = JSONObject(); NativeAskEvidenceScope.restore(state, conversation); assertEquals(id, state.getJSONArray("evidenceIds").getString(0))
        NativeAskEvidenceScope.clear(state); NativeAskEvidenceScope.restore(state, conversation); assertTrue(state.isNull("evidenceIds"))
        state.remove("scopeDirty"); NativeAskEvidenceScope.restore(state, conversation); assertEquals(id, state.getJSONArray("evidenceIds").getString(0))
    }
    @Test fun `clear while answering leaves accepted request and scope untouched`() {
        val state = JSONObject().put("runStatus", "running").put("evidenceIds", JSONArray().put(UUID.randomUUID().toString()))
        val before = state.toString(); assertFalse(NativeAskEvidenceScope.clear(state)); assertEquals(before, state.toString())
    }

    @Test fun `record entry is a reference and explicit strict mode stays distinct through restore`() {
        val id = UUID.randomUUID().toString(); val state = JSONObject()
        assertTrue(NativeAskEvidenceScope.select(state, id))
        val input = JSONObject(); NativeAskEvidenceScope.writeInput(state, input)
        assertEquals(id, input.getJSONArray("anchorEvidenceIds").getString(0)); assertTrue(input.isNull("evidenceIds"))
        val restored = JSONObject(); NativeAskEvidenceScope.restore(restored, JSONObject().put("scope", input))
        assertEquals(id, restored.getJSONArray("anchorEvidenceIds").getString(0))
        assertTrue(NativeAskEvidenceScope.selectOnly(restored, id)); assertTrue(restored.isNull("anchorEvidenceIds"))
        assertEquals(id, restored.getJSONArray("evidenceIds").getString(0))
        restored.put("pending", JSONObject().put("scope", JSONObject().put("kind", "all")).put("anchorEvidenceIds", JSONArray().put(id))); val before = restored.toString()
        assertFalse(NativeAskEvidenceScope.selectOnly(restored, id)); assertEquals(before, restored.toString())
        assertTrue(NativeAskEvidenceScope.select(restored, id)); assertEquals(before, restored.toString())
    }
}
