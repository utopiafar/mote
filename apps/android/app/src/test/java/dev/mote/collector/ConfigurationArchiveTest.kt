package dev.mote.collector
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ConfigurationArchiveTest {
 @Test fun roundTripPreservesPrivacyGateAndPackedTransport() {
  val config=CollectorConfig(deviceName="Generated",packedUpload=false,uploadGate=UploadGateConfig(true,"Generated private\n秘密","drop"),masks="0,0,0.1,0.1")
  val restored=ConfigurationArchive.decode(ConfigurationArchive.encode(config),CollectorConfig(deviceName="Fixture"))
  assertEquals(config.uploadGate,restored.uploadGate);assertEquals(config.packedUpload,restored.packedUpload);assertEquals(config.masks,restored.masks)
  assertFalse(JSONObject(ConfigurationArchive.encode(config)).getJSONObject("settings").has("token"))
 }
 @Test fun oldArchivesPreserveCurrentGateRatherThanResettingPrivacy() {
  val current=CollectorConfig(deviceName="Generated",packedUpload=false,uploadGate=UploadGateConfig(true,"Private","hold"))
  val root=JSONObject(ConfigurationArchive.encode(current));val values=root.getJSONObject("settings");for(k in listOf("packedUpload","uploadGateEnabled","uploadGateText","uploadGateFailure"))values.remove(k)
  val restored=ConfigurationArchive.decode(root.toString(),current);assertEquals(current.uploadGate,restored.uploadGate);assertEquals(current.packedUpload,restored.packedUpload)
 }
 @Test fun malformedPrivacyFieldsAreRejected() {
  val config=CollectorConfig(deviceName="Generated");for((key,value) in listOf("packedUpload" to "false","uploadGateEnabled" to "true","uploadGateText" to 42,"uploadGateFailure" to "unknown")) {
   val root=JSONObject(ConfigurationArchive.encode(config));root.getJSONObject("settings").put(key,value);assertThrows(Exception::class.java){ConfigurationArchive.decode(root.toString(),config)}
  }
 }
}
