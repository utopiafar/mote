package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ProtocolCompatibilityTest {
    private fun contractFile(path: String): File = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { File(it, "protocol/$path") }.first { it.isFile }

    @Test fun runtimeMetadataMatchesTheIndependentWireContract() {
        val contract = JSONObject(contractFile("contract.json").readText())
        assertEquals(contract.getString("metadataRequestHeader"), ProtocolCompatibility.HEADER)
        assertEquals(contract.getJSONObject("range").getInt("min"), ProtocolCompatibility.MIN)
        assertEquals(contract.getJSONObject("range").getInt("max"), ProtocolCompatibility.MAX)
        assertEquals(contract.getInt("legacyVersion"), ProtocolCompatibility.requireCompatible(null).max)
        assertEquals(mapOf(ProtocolCompatibility.HEADER to "1"), ProtocolCompatibility.headers)
    }

    @Test fun generatedCompatibilityCasesMatchTypeScriptAndDesktop() {
        val fixtures = JSONArray(contractFile("fixtures/compatibility.json").readText())
        for (index in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(index)
            if (fixture.has("error")) {
                val failure = assertThrows(fixture.getString("name"), ConnectionFailure::class.java) {
                    ProtocolCompatibility.requireCompatible(fixture.opt("protocol"))
                }
                assertEquals(if (fixture.getString("error") == "incompatible_protocol") "protocol_incompatible" else "response", failure.category)
            } else {
                val expected = fixture.getJSONObject("expected")
                assertEquals(fixture.getString("name"), ProtocolRange(expected.getInt("min"), expected.getInt("max")), ProtocolCompatibility.requireCompatible(fixture.opt("protocol")))
            }
        }
    }
}
