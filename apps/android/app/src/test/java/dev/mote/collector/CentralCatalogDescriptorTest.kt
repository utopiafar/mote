package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CentralCatalogDescriptorTest {
    private fun fixture() = JSONObject().put("schemaVersion", 1).put("types", JSONArray().put(JSONObject()
        .put("id", "fixture.journal").put("kind", "fixture.journal").put("schemaVersion", 1)
        .put("label", "Generated journal").put("card", "fixture.journal-card")))
    @Test fun newTypeHasDataOnlyAnchorsAndUnknownVersionsUseGenericFallback() {
        val descriptor = CentralCatalogDescriptor.read(fixture())
        assertEquals("Generated journal", descriptor.type("fixture.journal", 1)?.label)
        assertNull(descriptor.type("fixture.journal", 2))
        assertNull(descriptor.type("fixture.uninstalled", 1))
        assertNull(CentralCatalogDescriptor.read(JSONObject().put("schemaVersion", 1)).type("fixture.journal", 1))
    }
    @Test fun ambiguousTypesAndUnsupportedCatalogVersionsFailClosed() {
        val duplicate = fixture(); duplicate.getJSONArray("types").put(duplicate.getJSONArray("types").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { CentralCatalogDescriptor.read(duplicate) }
        assertThrows(IllegalArgumentException::class.java) { CentralCatalogDescriptor.read(fixture().put("schemaVersion", 2)) }
        val invalid = fixture(); invalid.getJSONArray("types").getJSONObject(0).put("id", "https://untrusted.example/module.js")
        assertThrows(IllegalArgumentException::class.java) { CentralCatalogDescriptor.read(invalid) }
    }
}
