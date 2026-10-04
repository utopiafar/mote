package dev.mote.collector
/** Transport deduplication only. Dismissal never alters the observed content history. */
internal object NotificationObservations {
 fun accept(seen: MutableMap<String,String>,key:String,hash:String,removed:Boolean=false):String? {
  if(removed || seen[key]==hash)return null
  val action=if(seen.containsKey(key))"updated" else "posted"
  seen[key]=hash;return action
 }
}
