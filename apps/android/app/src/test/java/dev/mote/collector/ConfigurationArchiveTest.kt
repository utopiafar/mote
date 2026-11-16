package dev.mote.collector
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ConfigurationArchiveTest {
 @Test fun removedStorageQuotasAreNotExportedAndCannotChangePrivacyOnImport() {
  val current=CollectorConfig(deviceName="Generated",mediaCollectionEnabled=false,notificationCollectionEnabled=false,deviceEventCollectionEnabled=false,
   uploadGate=UploadGateConfig(true,"Keep explicit approval","hold"),appCollectionRules="{\"default\":\"off\",\"apps\":{}}")
  val root=JSONObject(ConfigurationArchive.encode(current));val values=root.getJSONObject("settings")
  assertFalse(values.has("maxQueueMiB"));assertFalse(values.has("uploadedRetentionDays"))
  values.put("maxQueueMiB",8).put("uploadedRetentionDays",0)
  assertThrows(IllegalArgumentException::class.java){ConfigurationArchive.decode(root.toString(),current)}
  assertFalse(current.mediaCollectionEnabled);assertFalse(current.notificationCollectionEnabled);assertFalse(current.deviceEventCollectionEnabled)
 }
 @Test fun roundTripPreservesPrivacyGateAndPackedTransport() {
  val config=CollectorConfig(deviceName="Generated",packedUpload=false,uploadGate=UploadGateConfig(true,"Generated private\n秘密","drop"),masks="0,0,0.1,0.1")
  val restored=ConfigurationArchive.decode(ConfigurationArchive.encode(config),CollectorConfig(deviceName="Fixture"))
  assertEquals(config.uploadGate,restored.uploadGate);assertEquals(config.packedUpload,restored.packedUpload);assertEquals(config.masks,restored.masks)
  assertFalse(JSONObject(ConfigurationArchive.encode(config)).getJSONObject("settings").has("token"))
 }
 @Test fun omittedCurrentArchiveFieldsPreserveExplicitCurrentPrivacy() {
  val current=CollectorConfig(deviceName="Generated",packedUpload=false,uploadGate=UploadGateConfig(true,"Private","hold"))
  val root=JSONObject(ConfigurationArchive.encode(current));val values=root.getJSONObject("settings");for(k in listOf("packedUpload","uploadGateEnabled","uploadGateText","uploadGateFailure"))values.remove(k)
  val restored=ConfigurationArchive.decode(root.toString(),current);assertEquals(current.uploadGate,restored.uploadGate);assertEquals(current.packedUpload,restored.packedUpload)
 }
 @Test fun malformedPrivacyFieldsAreRejected() {
  val config=CollectorConfig(deviceName="Generated");for((key,value) in listOf("packedUpload" to "false","uploadGateEnabled" to "true","uploadGateText" to 42,"uploadGateFailure" to "unknown")) {
   val root=JSONObject(ConfigurationArchive.encode(config));root.getJSONObject("settings").put(key,value);assertThrows(Exception::class.java){ConfigurationArchive.decode(root.toString(),config)}
  }
 }
 @Test fun retiredContentAndScreenOnlyArchiveCannotGrantStructuredCollection() {
  val current=CollectorConfig(deviceName="Generated")
  val retired="""{"format":"mote-android-settings","version":1,"settings":{"uiPageMode":"screen_only","appCollectionRules":"{\"default\":\"content\",\"apps\":{}}"}}"""
  assertThrows(IllegalArgumentException::class.java){ConfigurationArchive.decode(retired,current)}
  assertEquals(AppCollectionMode.ACTIVITY,current.collectionRules.defaultMode)
  assertEquals(2,JSONObject(ConfigurationArchive.encode(current)).getInt("version"))
 }
 @Test fun currentLargeRulePackSurvivesPortableSettingsRoundTrip() {
  val rules=org.json.JSONArray()
  repeat(500){index->
   rules.put(JSONObject().put("id","generated-$index").put("version","1").put("formatVersion",3).put("platform","android").put("appId","fixture.generated").put("appVersion","1").put("kind","visible_text").put("fields",JSONObject().put("visible_text",JSONObject().put("select",JSONObject().put("resourceId","fixture:"+"x".repeat(260))).put("source","text").put("cardinality","many").put("required",true))))
  }
  val config=CollectorConfig(deviceName="Generated",uiPageRules=rules.toString(2))
  assertTrue(ConfigurationArchive.encode(config).toByteArray().size>256*1024)
  assertEquals(500,UiPageRules.parse(config.uiPageRules).size)
  assertEquals(config.uiPageRules,ConfigurationArchive.decode(ConfigurationArchive.encode(config),CollectorConfig(deviceName="Generated receiver")).uiPageRules)
 }

}
