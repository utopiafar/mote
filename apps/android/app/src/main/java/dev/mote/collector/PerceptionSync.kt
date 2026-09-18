package dev.mote.collector
import android.content.Context
import java.net.URLEncoder
/** One bounded pull during an existing sync; no additional recurring wakeup. */
object PerceptionSync {
 fun pull(context: Context, settings: Settings, config: CollectorConfig, queue: DurableQueue) {
  val prefs=context.getSharedPreferences("central-perception",Context.MODE_PRIVATE)
  val key=SourceRules.hash(config.server+"\n"+config.token+"\n"+settings.deviceId)
  val cursor=prefs.getLong(key,0)
  val (code,body)=HttpJson.get("${config.server}/api/capture-browser/updates?cursor=$cursor&limit=20&deviceId=${URLEncoder.encode(settings.deviceId,"UTF-8")}",config.token)
  if(code!=200||body==null)return
  val next=body.getLong("nextCursor");require(next>=cursor)
  val items=body.getJSONArray("items");require(items.length()<=20)
  for(i in 0 until items.length())queue.cacheCentralDerived(items.getJSONObject(i),config.maxQueueMiB*1024L*1024L)
  check(prefs.edit().putLong(key,next).commit())
 }
}
