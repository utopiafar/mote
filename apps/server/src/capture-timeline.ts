import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {CapturePreview,CaptureTimelineGroup,CaptureTimelinePage,CaptureTimelineMembers} from '@mote/shared';
import {Store,StoreError,type Range} from './store.js';
import {captureSessionMembersSql} from './capture-session-members.js';

export type TimelineRange=Pick<Range,'deviceId'|'appId'|'source'|'collection'|'ocrStatus'>&{after:string;before:string;timeZone:string;limit:number;cursor?:string};
type Position={type:'group'|'groups-page'|'members-page';scope:string;revision:string;key?:string;at?:string;id?:string};
const positionSchema=z.object({type:z.enum(['group','groups-page','members-page']),scope:z.string().length(64),revision:z.string().length(64),key:z.string().max(2048).optional(),at:z.string().datetime().optional(),id:z.string().max(2048).optional()}).strict();
type GroupRow={group_key:string;kind:'record'|'screen-session'|'source';source:CapturePreview['source'];device_id:string;day:string;first_at:string;last_at:string;record_count:number;image_count:number;sample_count:number|null;representative:string};

/** Split civil dates by actual instants, including 23/25-hour DST days. */
function dayBuckets(after:string,before:string,timeZone:string){
 let formatter:Intl.DateTimeFormat;try{formatter=new Intl.DateTimeFormat('en',{timeZone,calendar:'iso8601',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw new StoreError('Invalid timeline time zone');}
 const day=(at:number)=>{const p=Object.fromEntries(formatter.formatToParts(new Date(at)).map(part=>[part.type,part.value]));return `${p.year}-${p.month}-${p.day}`;};
 const end=Date.parse(before),result:{day:string;after:string;before:string}[]=[];let at=Date.parse(after);
 while(at<end){
  const label=day(at);let low=at,high=Math.min(end,at+6*3600000);
  while(high<end&&day(high)===label){low=high;high=Math.min(end,high+6*3600000);}
  if(day(high-1)===label&&high===end){result.push({day:label,after:new Date(at).toISOString(),before});break;}
  while(high-low>1){const middle=Math.floor((low+high)/2);if(day(middle)===label)low=middle;else high=middle;}
  result.push({day:label,after:new Date(at).toISOString(),before:new Date(high).toISOString()});at=high;
  if(result.length>40)throw new StoreError('Choose a shorter timeline range');
 }
 return result;
}

/** Read-only grouping of existing observations; no inferred document identity. */
export class CaptureTimeline {
 private secret=randomBytes(32);
 private grouped=new Map<string,GroupRow[]>();
 constructor(private store:Store){}
 private seal(value:Position){const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',this.secret).update(body).digest('base64url');}
 private open(raw:string,type:Position['type']){
  try{const [body,signature,extra]=raw.split('.');if(extra||!body||!signature)throw Error();const actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.secret).update(body).digest();if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const value=positionSchema.parse(JSON.parse(Buffer.from(body,'base64url').toString()));if(value.type!==type)throw Error();return value;}
  catch{throw new StoreError('Invalid timeline reference');}
 }
 private snapshot<T>(read:()=>T):T{
  if(this.store.db.isTransaction)return read();
  this.store.db.exec('BEGIN');try{const value=read();this.store.db.exec('COMMIT');return value;}catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
 private prepare(input:TimelineRange,ownerIdentity:string){
  const {cursor,limit,timeZone,...raw}=input,range={...raw,after:new Date(raw.after).toISOString(),before:new Date(raw.before).toISOString()};
  const scope=createHash('sha256').update(JSON.stringify(['capture-timeline-v1',ownerIdentity,range,timeZone])).digest('hex');
  const filter=this.store.captureBrowseScope(range),digest=createHash('sha256').update(scope);
  // Complete membership and effective OCR inputs, including records after the
  // current page. A processing/filter or visibility change invalidates locators.
  const metadata=this.store.db.prepare(`SELECT id,fingerprint,json_extract(json,'$.stateSeries') series,
   (SELECT fingerprint FROM perception_results p WHERE p.capture_id=captures.id AND p.kind='ocr' AND p.current=1) ocr_result,
   (SELECT json_array(state,error) FROM perception_jobs p WHERE p.capture_id=captures.id AND p.kind='ocr') ocr_job
   FROM captures${filter.where} ORDER BY id`);
  for(const row of metadata.iterate(...filter.values))digest.update(JSON.stringify(row));
  digest.update(String(this.store.db.prepare("SELECT json_extract(value,'$.enabled') enabled FROM settings WHERE key='perception-effective'").get()?.enabled??''));
  // An excluded app can still be a real A → B → A session boundary.
  const screenArgs=[range.after,range.before,...(range.deviceId?[range.deviceId]:[])];
  for(const row of this.store.db.prepare(`SELECT id,captured_at,app_id FROM capture_gallery WHERE captured_at>=? AND captured_at<? ${range.deviceId?'AND device_id=?':''} ORDER BY id`).iterate(...screenArgs))digest.update(JSON.stringify(row));
  const revision=digest.digest('hex'),days=dayBuckets(range.after,range.before,timeZone),dayValues=days.flatMap(day=>[day.day,day.after,day.before]);
  const sql=captureSessionMembersSql(range.deviceId)+`, dates(day,first_at,last_at) AS (VALUES ${days.map(()=>'(?,?,?)').join(',')}), scope_records AS (
   SELECT id,device_id,captured_at,blob_hash,json_extract(json,'$.source') source,
    json_extract(json,'$.stateSeries.samples') series FROM captures${filter.where}
  ), observations AS (
   SELECT scope_records.*,strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(observation.value,'$.at')) observation_at,1 has_series
   FROM scope_records JOIN json_each(scope_records.series) observation
   UNION ALL SELECT *,captured_at observation_at,0 has_series FROM scope_records WHERE COALESCE(json_array_length(series),0)=0
  ), filtered AS (
   SELECT observations.*,dates.day,members.session_id
   FROM observations JOIN dates ON observations.observation_at>=dates.first_at AND observations.observation_at<dates.last_at
   LEFT JOIN members ON members.id=observations.id
  ), classified AS (
   SELECT *,CASE WHEN source='screen' AND session_id IS NOT NULL THEN 'screen-session'
    WHEN source IN ('ui_page','notification','device_event','activity','media') THEN 'source' ELSE 'record' END kind FROM filtered
  ), identified AS (
   SELECT *,CASE WHEN kind='screen-session' THEN json_array(kind,device_id,day,session_id)
    WHEN kind='source' THEN json_array(kind,device_id,day,source) ELSE json_array(kind,id,day) END group_key FROM classified
  ), ranked AS (
   SELECT *,ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY observation_at DESC,id DESC) rn FROM identified
  ), grouped AS (
   SELECT group_key,kind,source,device_id,day,MIN(observation_at) first_at,MAX(observation_at) last_at,COUNT(DISTINCT id) record_count,
    COUNT(DISTINCT CASE WHEN blob_hash IS NOT NULL THEN id END) image_count,
    CASE WHEN SUM(has_series)=COUNT(*) THEN COUNT(*) ELSE NULL END sample_count,
    MAX(CASE WHEN rn=1 THEN id END) representative FROM ranked GROUP BY group_key
  ), member_rows AS (
   SELECT group_key,id,MIN(observation_at) first_at,MAX(observation_at) last_at,
    CASE WHEN SUM(has_series)=COUNT(*) THEN COUNT(*) ELSE NULL END sample_count FROM identified GROUP BY group_key,id
  )`;
  return {scope,revision,sql,values:[...screenArgs,...dayValues,...filter.values]};
 }
 private current(value:Position,context:ReturnType<CaptureTimeline['prepare']>){if(value.scope!==context.scope||value.revision!==context.revision)throw new StoreError('Timeline changed; reload the selected range',409);}
 private cachedGroups(context:ReturnType<CaptureTimeline['prepare']>){
  const key=context.scope+':'+context.revision,hit=this.grouped.get(key);
  if(hit){this.grouped.delete(key);this.grouped.set(key,hit);}return hit;
 }
 private groupedRows(context:ReturnType<CaptureTimeline['prepare']>){
  const hit=this.cachedGroups(context);if(hit)return hit;
  const rows=this.store.db.prepare(context.sql+' SELECT * FROM grouped ORDER BY last_at DESC,group_key DESC LIMIT 5001').all(...context.values) as unknown as GroupRow[];
  if(rows.length>5000)return undefined;
  this.grouped.set(context.scope+':'+context.revision,rows);while(this.grouped.size>8)this.grouped.delete(this.grouped.keys().next().value!);
  return rows;
 }
 private group(row:GroupRow,context:ReturnType<CaptureTimeline['prepare']>):CaptureTimelineGroup{
  const record=this.store.evidence([row.representative])[0];if(!record)throw new StoreError('Timeline changed; reload the selected range',409);
  return {type:'group',id:this.seal({type:'group',scope:context.scope,revision:context.revision,key:row.group_key}),kind:row.kind==='screen-session'?'screen-session':'source',source:row.source,deviceId:row.device_id,deviceName:record.deviceName,day:row.day,firstAt:row.first_at,lastAt:row.last_at,recordCount:Number(row.record_count),imageCount:Number(row.image_count),sampleCount:row.sample_count===null?null:Number(row.sample_count),...(row.kind==='screen-session'?{appId:record.appId,appName:record.appName}:{})};
 }
 page(input:TimelineRange,ownerIdentity:string):CaptureTimelinePage{return this.snapshot(()=>{
  const context=this.prepare(input,ownerIdentity),position=input.cursor?this.open(input.cursor,'groups-page'):undefined;if(position)this.current(position,context);
  if(position&&(!position.at||!position.key))throw new StoreError('Invalid timeline cursor');
  const grouped=this.groupedRows(context),key=position?Buffer.from(position.key!):undefined,start=position&&grouped?grouped.findIndex(row=>row.last_at<position.at!||row.last_at===position.at&&Buffer.compare(Buffer.from(row.group_key),key!)<0):0;
  const rows=grouped?(start<0?[]:grouped.slice(start,start+input.limit+1)):this.store.db.prepare(context.sql+` SELECT * FROM grouped ${position?'WHERE last_at<? OR (last_at=? AND group_key<?)':''} ORDER BY last_at DESC,group_key DESC LIMIT ?`).all(...context.values,...(position?[position.at!,position.at!,position.key!]:[]),input.limit+1) as unknown as GroupRow[];
  const selected=rows.slice(0,input.limit),items:CaptureTimelinePage['items']=selected.map(row=>row.kind==='record'?{type:'record',id:this.seal({type:'group',scope:context.scope,revision:context.revision,key:row.group_key}),day:row.day,firstAt:row.first_at,lastAt:row.last_at,sampleCount:row.sample_count===null?null:Number(row.sample_count),record:this.store.preview(this.store.evidence([row.representative])[0])}:this.group(row,context)),last=selected.at(-1);
  return {revision:context.revision,items,nextCursor:rows.length>input.limit&&last?this.seal({type:'groups-page',scope:context.scope,revision:context.revision,at:last.last_at,key:last.group_key}):null};
 });}
 members(input:TimelineRange,ownerIdentity:string,groupId:string):CaptureTimelineMembers{return this.snapshot(()=>{
  const context=this.prepare(input,ownerIdentity),group=this.open(groupId,'group');this.current(group,context);
  const position=input.cursor?this.open(input.cursor,'members-page'):undefined;if(position){this.current(position,context);if(position.key!==group.key||!position.at||!position.id)throw new StoreError('Timeline member cursor does not match this group',409);}
  const cached=this.cachedGroups(context),memberSql=` SELECT * FROM member_rows WHERE group_key=? ${position?'AND (last_at<? OR (last_at=? AND id<?))':''} ORDER BY last_at DESC,id DESC LIMIT ?`,memberValues=[group.key!,...(position?[position.at!,position.at!,position.id!]:[]),input.limit+1];
  // A group locator can outlive its LRU entry, or refer to an oversized range.
  // On that path read the summary and page together, preserving empty pages.
  const combined=cached?undefined:this.store.db.prepare(context.sql+` SELECT grouped.*,page.id member_id,page.first_at member_first_at,page.last_at member_last_at,page.sample_count member_sample_count
   FROM grouped LEFT JOIN (${memberSql}) page ON page.group_key=grouped.group_key WHERE grouped.group_key=? ORDER BY page.last_at DESC,page.id DESC`).all(...context.values,...memberValues,group.key!);
  const row=(cached?cached.find(row=>row.group_key===group.key):combined?.[0]) as GroupRow|undefined;
  if(!row||row.kind==='record')throw new StoreError('Timeline group is unavailable',404);
  const rows=cached?this.store.db.prepare(context.sql+memberSql).all(...context.values,...memberValues):combined!.filter(row=>row.member_id!==null).map(row=>({id:row.member_id,first_at:row.member_first_at,last_at:row.member_last_at,sample_count:row.member_sample_count}));
  const selected=rows.slice(0,input.limit),items=selected.map(row=>({record:this.store.preview(this.store.evidence([String(row.id)])[0]),firstAt:String(row.first_at),lastAt:String(row.last_at),sampleCount:row.sample_count===null?null:Number(row.sample_count)})),last=selected.at(-1);
  return {revision:context.revision,group:this.group(row,context),items,nextCursor:rows.length>input.limit&&last?this.seal({type:'members-page',scope:context.scope,revision:context.revision,key:group.key,at:String(last.last_at),id:String(last.id)}):null};
 });}
}
