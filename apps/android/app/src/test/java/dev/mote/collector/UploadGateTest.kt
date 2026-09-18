package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class UploadGateTest {
 @Test fun `review does not recognize without rules or when disabled`() {
  assertEquals("allow", UploadGate.review(UploadGateConfig()) { error("Must not OCR") })
  assertEquals("allow", UploadGate.review(UploadGateConfig(false,"private")) { error("Must not OCR") })
 }
 @Test fun `literal rules do not classify topics`() {
  val c=UploadGateConfig(blockedText="private.value")
  assertEquals("allow",UploadGate.review(c){"private value"})
  assertEquals("drop",UploadGate.review(c){"my private.value"})
 }
 @Test fun `failure defaults to hold with explicit alternative policies`() {
  for(action in listOf("hold","drop","allow")) assertEquals(action,UploadGate.review(UploadGateConfig(blockedText="private",failureAction=action)){error("OCR failure")})
 }
}
