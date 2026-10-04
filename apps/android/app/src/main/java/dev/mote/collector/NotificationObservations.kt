package dev.mote.collector
/** Transport deduplication only. Dismissal never alters the observed content history. */
internal object NotificationObservations {
 fun text(payload: org.json.JSONObject): String = buildList {
  for(key in listOf("title","text","bigText","subText","channelId","category"))
   if(payload.has(key)) add(payload.getString(key))
  payload.optJSONArray("textLines")?.let { lines -> for(i in 0 until lines.length()) add(lines.getString(i)) }
 }.joinToString("\n")
 fun accept(seen: MutableMap<String,String>,key:String,hash:String,removed:Boolean=false):String? {
  if(removed || seen[key]==hash)return null
  val action=if(seen.containsKey(key))"updated" else "posted"
  seen[key]=hash;return action
 }
}
