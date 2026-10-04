package dev.mote.collector
import org.junit.Assert.*
import org.junit.Test
class NotificationObservationsTest {
 @Test fun postedAndUpdatesRemainWhileDismissalsNeitherEmitNorResetDedup() {
  val seen=linkedMapOf<String,String>();val accepted=mutableListOf<String>()
  for((key,hash,removed) in listOf(Triple("fixture","v1",false),Triple("fixture","v1",false),Triple("fixture","v1",true),Triple("fixture","v1",false),Triple("fixture","v2",false),Triple("other","v1",true),Triple("other","v1",false)))NotificationObservations.accept(seen,key,hash,removed)?.let(accepted::add)
  assertEquals(listOf("posted","updated","posted"),accepted);assertEquals(mapOf("fixture" to "v2","other" to "v1"),seen)
 }
}
