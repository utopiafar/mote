package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/** Run by apps/android/test-fixtures/agent-runtime-status.ts against a private
 * real Central response. Other JVM selections do not implicitly launch Node. */
class RuntimeStatusReceiptContractTest {
    private val receiptPath = System.getenv("MOTE_RUNTIME_STATUS_RECEIPT").orEmpty()
    private val badRevisionPath = System.getenv("MOTE_RUNTIME_STATUS_BAD_REVISION").orEmpty()
    private val unconfiguredPath = System.getenv("MOTE_RUNTIME_STATUS_UNCONFIGURED").orEmpty()

    @Before fun requireRealReceipt() {
        assumeTrue("Use the runtime status contract runner", receiptPath.isNotEmpty())
        assertTrue(badRevisionPath.isNotEmpty() && unconfiguredPath.isNotEmpty())
    }

    private fun read(path: String): JSONObject = JSONObject(File(path).readText())

    @Test fun realCentralReceiptIsConsumedByTheProductionParser() {
        val receipt = RuntimeStatusReceipt.parse(read(receiptPath))
        assertNotNull("The real Central receipt must parse", receipt)
        receipt!!
        assertEquals(receipt.saved.getLong("revision"), receipt.revision)
        assertEquals("generated-runtime-model", receipt.features["chat"]!!.model)
        assertTrue(receipt.features["chat"]!!.configured)
        assertEquals("applied", receipt.domain?.status)
        assertEquals(RuntimeStatusReceipt.Readiness.READY, RuntimeStatusReceipt.readiness(receipt))
        assertEquals(RuntimeStatusReceipt.FeatureState.READY, RuntimeStatusReceipt.featureState(receipt, "chat"))
        assertEquals(RuntimeStatusReceipt.FeatureState.UNKNOWN, RuntimeStatusReceipt.featureState(receipt, "future-capability"))
        val summary = RuntimeStatusReceipt.effectiveSummary(receipt, { it }) { id ->
            receipt.saved.getJSONArray("profiles").let { profiles ->
                (0 until profiles.length()).map { profiles.getJSONObject(it) }
                    .firstOrNull { it.getString("id") == id }?.optString("name")
            }
        }
        assertTrue(summary.contains("generated-runtime-model"))
    }

    @Test fun badRevisionIsRejectedWhileTheCurrentSelectionStaysReadable() {
        val current = RuntimeStatusReceipt.parse(read(receiptPath))
        assertNotNull(current)
        assertNull(RuntimeStatusReceipt.parse(read(badRevisionPath)))
        assertEquals("generated-runtime-model", current!!.features["chat"]!!.model)
    }

    @Test fun realUnconfiguredReceiptStaysReadableWithoutFakingReady() {
        val receipt = RuntimeStatusReceipt.parse(read(unconfiguredPath))
        assertNotNull("The real unconfigured receipt must parse", receipt)
        receipt!!
        assertEquals(RuntimeStatusReceipt.Readiness.UNCONFIGURED, RuntimeStatusReceipt.readiness(receipt))
        assertEquals(RuntimeStatusReceipt.FeatureState.UNCONFIGURED, RuntimeStatusReceipt.featureState(receipt, "chat"))
        val profileId = receipt.features["chat"]!!.profileId
        assertTrue(receipt.saved.getJSONArray("profiles").let { profiles ->
            (0 until profiles.length()).any { profiles.getJSONObject(it).getString("id") == profileId }
        })
    }
}
