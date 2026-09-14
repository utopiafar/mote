import type {CaptureRecord} from '@mote/shared';
import type {Range} from './store.js';

export type MediaActivityRange = Range & {
  appVisibility?: 'foreground'|'background'|'unknown';
  screenLocked?: boolean;
  playbackType?: 'local'|'remote'|'unknown';
};
type Interval={deviceId:string;start:number;end:number};
type Duration={durationMs:number;ends:Map<string,number>};
type Bucket=Duration&{observations:number;evidence:Set<string>;evidenceTruncated:boolean};
const duration=():Duration=>({durationMs:0,ends:new Map()});
const bucket=():Bucket=>({...duration(),observations:0,evidence:new Set(),evidenceTruncated:false});
const evidence=(value:Bucket)=>({evidenceIds:[...value.evidence],evidenceTruncated:value.evidenceTruncated});

/** Concurrent sessions count once within a device; simultaneous devices remain separate. */
function addInterval(value:Duration,interval:Interval) {
  value.durationMs+=Math.max(0,interval.end-Math.max(interval.start,value.ends.get(interval.deviceId)??-Infinity));
  value.ends.set(interval.deviceId,Math.max(interval.end,value.ends.get(interval.deviceId)??-Infinity));
}
function observe(value:Bucket,id:string,interval?:Interval){
  value.observations++;
  if(value.evidence.size<100)value.evidence.add(id);else if(!value.evidence.has(id))value.evidenceTruncated=true;
  if(interval)addInterval(value,interval);
}
const summarize=(value:Bucket)=>({durationMs:value.durationMs,observations:value.observations,...evidence(value)});

/**
 * Consume records ordered by capturedAt - durationMs (enforced by Store's SQLite iterator).
 * Keep only one union end per device/bucket and bounded evidence, never all sample metadata.
 * Only explicit, bounded playing intervals are measured; point observations imply no elapsed playback.
 */
export function mediaActivity(records:Iterable<CaptureRecord>,range:MediaActivityRange={}) {
  const all=bucket(),apps=new Map<string,Bucket&{appId:string;appName:string}>(),devices=new Map<string,Bucket&{deviceId:string;deviceName:string}>();
  const visibility={foreground:duration(),background:duration(),unknown:duration()};
  const screenLock={locked:duration(),unlocked:duration(),unknown:duration()};
  const playbackType={local:duration(),remote:duration(),unknown:duration()};
  const availability={available:0,disabled:0,permission_required:0,unavailable:0};
  const lower=range.after?Date.parse(range.after):-Infinity,upper=range.before?Date.parse(range.before):Infinity;
  let playingSamples=0;
  for(const record of records){
    if(record.source!=='media'||(range.source&&range.source!=='media')||(range.deviceId&&range.deviceId!==record.deviceId))continue;
    const media=record.metadata?.media;if(!media)continue;
    if(range.collection&&(record.privacy.collection??'content')!==range.collection)continue;
    const locked=record.metadata?.state?.screenLocked;
    if(range.screenLocked!==undefined&&locked!==range.screenLocked)continue;
    const sessions=media.sessions.filter(session=>(range.appId===undefined||session.appId===range.appId)&&(!range.appVisibility||session.appVisibility===range.appVisibility)&&(!range.playbackType||session.playbackType===range.playbackType));
    if((range.appId!==undefined||range.appVisibility||range.playbackType)&&!sessions.length)continue;
    const t=Date.parse(record.capturedAt),start=Math.max(lower,t-record.durationMs),end=Math.min(upper,t);
    // Defensive even for old/restored data: screenshots and unobserved gaps cannot add duration.
    const measured=media.status==='available'&&record.durationMs>0&&record.durationMs<=60000&&media.sessions.length===1&&sessions.length===1&&sessions[0].playbackState==='playing'&&sessions[0].appId===record.appId&&end>start;
    if((t<lower||t>=upper)&&!measured)continue;
    const interval:Interval|undefined=measured?{deviceId:record.deviceId,start,end}:undefined;
    const device=devices.get(record.deviceId)??{...bucket(),deviceId:record.deviceId,deviceName:record.deviceName};
    for(const value of [all,device])observe(value,record.id,interval);
    devices.set(record.deviceId,device);availability[media.status]++;
    for(const session of new Map(sessions.map(s=>[s.appId,s])).values()){
      const app=apps.get(session.appId)??{...bucket(),appId:session.appId,appName:session.appName||session.appId};
      observe(app,record.id,interval);apps.set(session.appId,app);
    }
    if(interval){
      playingSamples++;
      addInterval(visibility[sessions[0].appVisibility],interval);
      addInterval(screenLock[locked===true?'locked':locked===false?'unlocked':'unknown'],interval);
      addInterval(playbackType[sessions[0].playbackType],interval);
    }
  }
  return {
    totalDurationMs:all.durationMs,observations:all.observations,playingSamples,
    apps:[...apps.values()].map(({appId,appName,...value})=>({appId,appName,...summarize(value)})).sort((a,b)=>b.durationMs-a.durationMs||a.appId.localeCompare(b.appId)),
    devices:[...devices.values()].map(({deviceId,deviceName,...value})=>({deviceId,deviceName,...summarize(value)})).sort((a,b)=>b.durationMs-a.durationMs||a.deviceId.localeCompare(b.deviceId)),
    visibility:{foreground:visibility.foreground.durationMs,background:visibility.background.durationMs,unknown:visibility.unknown.durationMs},
    screenLock:{locked:screenLock.locked.durationMs,unlocked:screenLock.unlocked.durationMs,unknown:screenLock.unknown.durationMs},
    playbackType:{local:playbackType.local.durationMs,remote:playbackType.remote.durationMs,unknown:playbackType.unknown.durationMs},
    availability,...evidence(all),
    accounting:'union_per_device_sum_across_devices' as const,coverage:'observed_intervals_only' as const,breakdownsMayOverlap:true as const,
  };
}
