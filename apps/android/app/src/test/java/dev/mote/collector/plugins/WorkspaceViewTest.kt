package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** These literals are actual `/api/assistant/workbench` responses from the
 * real Fastify route with a generated store, not hand-shaped view models. */
class WorkspaceViewTest {
    private val project = """{"request":{"template":"project","scope":{"kind":"all"}},"descriptor":{"id":"assistant.workbench.project","kind":"declarative-view","apiVersion":"1","platforms":["web","mac","android"],"presentation":{"labelKey":"project","i18nNamespace":"mote"},"commands":[{"id":"refresh","apiVersion":"1"}]},"spec":{"components":[{"type":"detail","fields":[{"key":"goal","labelKey":"goal"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"matters","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"commitments","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"},{"key":"deadline","labelKey":"deadline"}]},{"type":"list","itemKey":"progress","fields":[{"key":"summary","labelKey":"summary"},{"key":"occurredAt","labelKey":"occurredAt"},{"key":"recordedAt","labelKey":"recordedAt"}]},{"type":"list","itemKey":"files","fields":[{"key":"title","labelKey":"title"},{"key":"extraction","labelKey":"extraction"}]},{"type":"list","itemKey":"memories","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"}]},{"type":"action","command":"refresh","labelKey":"refresh"}]},"data":{"matters":[],"memories":[],"commitments":[],"progress":[],"files":[],"evidence":[]},"commands":[{"id":"refresh","apiVersion":"1"}]}"""
    private val person = """{"request":{"template":"person","scope":{"kind":"all"}},"descriptor":{"id":"assistant.workbench.person","kind":"declarative-view","apiVersion":"1","platforms":["web","mac","android"],"presentation":{"labelKey":"person","i18nNamespace":"mote"},"commands":[{"id":"refresh","apiVersion":"1"}]},"spec":{"components":[{"type":"detail","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"memories","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"},{"key":"source","labelKey":"source"}]},{"type":"list","itemKey":"commitments","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"},{"key":"deadline","labelKey":"deadline"}]},{"type":"list","itemKey":"progress","fields":[{"key":"summary","labelKey":"summary"},{"key":"occurredAt","labelKey":"occurredAt"},{"key":"recordedAt","labelKey":"recordedAt"}]},{"type":"list","itemKey":"evidence","fields":[{"key":"title","labelKey":"title"},{"key":"observedAt","labelKey":"observedAt"},{"key":"occurredAt","labelKey":"occurredAt"},{"key":"recordedAt","labelKey":"recordedAt"}]},{"type":"action","command":"refresh","labelKey":"refresh"}]},"data":{"matters":[],"memories":[],"commitments":[],"progress":[],"files":[],"evidence":[]},"commands":[{"id":"refresh","apiVersion":"1"}]}"""
    private val travel = """{"request":{"template":"travel","scope":{"kind":"all"}},"descriptor":{"id":"assistant.workbench.travel","kind":"declarative-view","apiVersion":"1","platforms":["web","mac","android"],"presentation":{"labelKey":"travel","i18nNamespace":"mote"},"commands":[{"id":"refresh","apiVersion":"1"}]},"spec":{"components":[{"type":"detail","fields":[{"key":"goal","labelKey":"goal"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"matters","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"commitments","fields":[{"key":"title","labelKey":"title"},{"key":"deadline","labelKey":"deadline"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"files","fields":[{"key":"title","labelKey":"title"},{"key":"original","labelKey":"original"},{"key":"extraction","labelKey":"extraction"}]},{"type":"list","itemKey":"memories","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"}]},{"type":"action","command":"refresh","labelKey":"refresh"}]},"data":{"matters":[],"memories":[],"commitments":[],"progress":[],"files":[],"evidence":[]},"commands":[{"id":"refresh","apiVersion":"1"}]}"""
    private val reading = """{"request":{"template":"reading","scope":{"kind":"all"}},"descriptor":{"id":"assistant.workbench.reading","kind":"declarative-view","apiVersion":"1","platforms":["web","mac","android"],"presentation":{"labelKey":"reading","i18nNamespace":"mote"},"commands":[{"id":"refresh","apiVersion":"1"}]},"spec":{"components":[{"type":"detail","fields":[{"key":"goal","labelKey":"goal"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"matters","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"files","fields":[{"key":"title","labelKey":"title"},{"key":"extraction","labelKey":"extraction"},{"key":"reason","labelKey":"reason"},{"key":"semantic","labelKey":"semantic"},{"key":"embedding","labelKey":"embedding"},{"key":"original","labelKey":"original"}]},{"type":"list","itemKey":"memories","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"}]},{"type":"list","itemKey":"evidence","fields":[{"key":"title","labelKey":"title"},{"key":"observedAt","labelKey":"observedAt"},{"key":"occurredAt","labelKey":"occurredAt"},{"key":"recordedAt","labelKey":"recordedAt"}]},{"type":"action","command":"refresh","labelKey":"refresh"}]},"data":{"matters":[],"memories":[],"commitments":[],"progress":[],"files":[],"evidence":[]},"commands":[{"id":"refresh","apiVersion":"1"}]}"""
    private val matter = """{"request":{"template":"project","scope":{"kind":"all"},"matterId":"1e01117c-62ce-486b-9bcf-0b3596bbdb6c"},"descriptor":{"id":"assistant.workbench.project","kind":"declarative-view","apiVersion":"1","platforms":["web","mac","android"],"presentation":{"labelKey":"project","i18nNamespace":"mote"},"commands":[{"id":"refresh","apiVersion":"1"},{"id":"matter.edit","apiVersion":"1"},{"id":"matter.pause","apiVersion":"1"},{"id":"matter.archive","apiVersion":"1"}]},"spec":{"components":[{"type":"detail","fields":[{"key":"goal","labelKey":"goal"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"matters","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"}]},{"type":"list","itemKey":"commitments","fields":[{"key":"title","labelKey":"title"},{"key":"state","labelKey":"state"},{"key":"deadline","labelKey":"deadline"}]},{"type":"list","itemKey":"progress","fields":[{"key":"summary","labelKey":"summary"},{"key":"occurredAt","labelKey":"occurredAt"},{"key":"recordedAt","labelKey":"recordedAt"}]},{"type":"list","itemKey":"files","fields":[{"key":"title","labelKey":"title"},{"key":"extraction","labelKey":"extraction"}]},{"type":"list","itemKey":"memories","fields":[{"key":"title","labelKey":"title"},{"key":"statement","labelKey":"statement"}]},{"type":"form","fields":[{"key":"goal","labelKey":"goal","input":"text","required":true}],"submitCommand":"matter.edit"},{"type":"action","command":"refresh","labelKey":"refresh"},{"type":"action","command":"matter.pause","labelKey":"pause"},{"type":"action","command":"matter.archive","labelKey":"archive"}]},"data":{"matters":[{"id":"1e01117c-62ce-486b-9bcf-0b3596bbdb6c","title":"Generated studio goal","state":"active"}],"memories":[],"commitments":[],"progress":[],"files":[],"evidence":[{"ref":"capture:6f1f0107-42af-4c3a-9d51-add101d7ebb8","title":"","observedAt":"2026-10-01T00:00:00.000Z","recordedAt":null,"occurredAt":null}],"goal":"Generated studio goal","state":"active"},"commands":[{"id":"refresh","apiVersion":"1"},{"id":"matter.edit","apiVersion":"1","matterId":"1e01117c-62ce-486b-9bcf-0b3596bbdb6c","expectedRevision":1},{"id":"matter.pause","apiVersion":"1","matterId":"1e01117c-62ce-486b-9bcf-0b3596bbdb6c","expectedRevision":1},{"id":"matter.archive","apiVersion":"1","matterId":"1e01117c-62ce-486b-9bcf-0b3596bbdb6c","expectedRevision":1}]}"""

    private fun read(value: String) = WorkspaceDecode.read(JSONObject(value))
    private fun reject(value: String): String = assertThrows(IllegalArgumentException::class.java) { read(value) }.message.orEmpty()

    @Test fun `all four real producer outputs decode through the Android decoder`() {
        val views = listOf(project, person, travel, reading).map(::read)
        assertEquals(listOf(WorkspaceTemplate.PROJECT, WorkspaceTemplate.PERSON, WorkspaceTemplate.TRAVEL, WorkspaceTemplate.READING), views.map { it.request.template })
        views.forEach { view ->
            assertEquals("declarative-view", view.descriptor.kind)
            assertEquals("android", view.descriptor.platforms.single { it == "android" })
            assertEquals(listOf("refresh"), view.commands.map { it.id })
            assertTrue(view.spec.components.any { it is DeclarativeNode.Listing })
            assertTrue(view.spec.components.any { it is DeclarativeNode.Action })
        }
    }

    @Test fun `a real matter output admits only its declared revisioned commands`() {
        val view = read(matter)
        assertEquals(WorkspaceTemplate.PROJECT, view.request.template)
        assertEquals("1e01117c-62ce-486b-9bcf-0b3596bbdb6c", view.request.matterId)
        assertEquals(listOf("refresh", "matter.edit", "matter.pause", "matter.archive"), view.commands.map { it.id })
        val edit = view.command("matter.edit") as WorkspaceCommand.Matter
        assertEquals("1e01117c-62ce-486b-9bcf-0b3596bbdb6c", edit.matterId)
        assertEquals(1L, edit.expectedRevision)
        assertEquals("matter.edit", edit.json().getString("id"))
        assertEquals("1", edit.json().getString("apiVersion"))
        assertEquals("1e01117c-62ce-486b-9bcf-0b3596bbdb6c", edit.json().getString("matterId"))
        assertEquals(1L, edit.json().getLong("expectedRevision"))
        assertThrows(IllegalArgumentException::class.java) { view.command("execute-script") }
        assertTrue(view.spec.components.any { it is DeclarativeNode.Form && it.submitCommand == "matter.edit" })
    }

    @Test fun `unknown components and undeclared commands are rejected with a located reason`() {
        assertTrue(reject(project.replace("\"type\":\"action\"", "\"type\":\"script\"")) .contains("unknown component type"))
        assertTrue(reject(project.replace("\"command\":\"refresh\"", "\"command\":\"rm\"")) .contains("undeclared"))
        assertTrue(reject(matter.replace("\"input\":\"text\"", "\"input\":\"script\"")) .contains("invalid"))
        assertTrue(reject(project.replace("\"key\":\"goal\"", "\"key\":\"goal\",\"extra\":true")) .contains("unknown field"))
    }

    @Test fun `descriptor command directory drift and unsupported platform are rejected whole`() {
        val missing = JSONObject(project)
        missing.getJSONObject("descriptor").put("commands", JSONArray())
        assertTrue(reject(missing.toString()).contains("descriptor directory mismatch"))
        val noAndroid = JSONObject(project)
        noAndroid.getJSONObject("descriptor").put("platforms", JSONArray().put("web").put("mac"))
        assertTrue(reject(noAndroid.toString()).contains("android is not declared"))
        val wrongKind = JSONObject(project)
        wrongKind.getJSONObject("descriptor").put("kind", "custom-page")
        assertTrue(reject(wrongKind.toString()).contains("only declarative-view"))
        val unknownCommand = JSONObject(project).also { root ->
            root.put("commands", JSONArray().put(JSONObject().put("id", "rm").put("apiVersion", "1")))
        }
        assertTrue(reject(unknownCommand.toString()).contains("unknown command"))
    }

    @Test fun `display only localizes authored states and original availability`() {
        val data = JSONObject("""{"files":[{"title":"Generated title","extraction":"failed","original":true}],"state":"active"}""")
        val shown = WorkspaceLabels.present(data) { key -> "T:$key" }
        assertEquals("T:失败", shown.getJSONArray("files").getJSONObject(0).getString("extraction"))
        assertEquals("T:打开", shown.getJSONArray("files").getJSONObject(0).getString("original"))
        assertEquals("T:进行中", shown.getString("state"))
        assertEquals("Generated title", shown.getJSONArray("files").getJSONObject(0).getString("title"))
        assertFalse(shown.getJSONArray("files").getJSONObject(0).has("coverage"))
    }

    @Test fun `a selection scope keeps both empty arrays meaningful`() {
        val emptySources = project.replace("\"scope\":{\"kind\":\"all\"}", "\"scope\":{\"kind\":\"selection\",\"sourceIds\":[]}")
        assertEquals(0, read(emptySources).request.scope.json.getJSONArray("sourceIds").length())
        val emptyEvidence = project.replace("\"scope\":{\"kind\":\"all\"}", "\"scope\":{\"kind\":\"selection\",\"evidenceIds\":[]}")
        assertEquals(0, read(emptyEvidence).request.scope.json.getJSONArray("evidenceIds").length())
        assertTrue(reject(project.replace("\"scope\":{\"kind\":\"all\"}", "\"scope\":{\"kind\":\"selection\"}")).contains("selection requires"))
    }
}
