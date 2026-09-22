import {createHash} from 'node:crypto';
import type {InsightSnapshot} from '@mote/shared';
import {StoreError,type Store} from './store.js';
type Scope={after?:string;before?:string;deviceId?:string;timeZone?:string};
const current="(NOT EXISTS(SELECT 1 FROM source_versions v WHERE v.capture_id=c.id) OR EXISTS(SELECT 1 FROM source_heads h WHERE h.capture_id=c.id AND h.deleted=0) OR c.id IN (SELECT capture_id FROM file_heads))";
function selection(scope:Scope){return {where:current+(scope.after?' AND c.context_end>=?':'')+(scope.before?" AND (c.context_at<? OR (json_extract(c.json,'$.source') IN ('screen','activity') AND (unixepoch(c.captured_at,'subsec')*1000-json_extract(c.json,'$.durationMs')<? OR EXISTS(SELECT 1 FROM json_each(c.json,'$.stateSeries.samples') sample WHERE unixepoch(json_extract(sample.value,'$.at'),'subsec')*1000-json_extract(sample.value,'$.durationMs')<?))))":'')+(scope.deviceId?' AND c.device_id=?':''),args:[...(scope.after?[scope.after]:[]),...(scope.before?[scope.before,Date.parse(scope.before),Date.parse(scope.before)]:[]),...(scope.deviceId?[scope.deviceId]:[])]};}
/** Incremental hash of scoped host identities and revisions. No original prose,
 * screenshots, credentials or inferred semantic categories enter this receipt. */
function evidenceFingerprint(store:Store,scope:Scope){
 const {where,args}=selection(scope),hash=createHash('sha256');let records=0,referenceOnlyRecords=0,pendingProcessing=0;
 for(const row of store.db.prepare(`SELECT c.id,c.fingerprint,c.context_at,c.context_end,json_extract(c.json,'$.stateSeries.samples') samples,CASE WHEN json_type(c.json,'$.stateSeries') IS NOT NULL THEN json_remove(c.json,'$.stateSeries') END state,json_extract(c.json,'$.provenance.layer') layer,
  (SELECT group_concat(id,',') FROM (SELECT id FROM perception_results WHERE capture_id=c.id AND current=1 ORDER BY id)) perception,
  (SELECT group_concat(id,',') FROM (SELECT id FROM file_artifacts WHERE capture_id=c.id AND current=1 ORDER BY id)) files,
  EXISTS(SELECT 1 FROM perception_jobs WHERE capture_id=c.id AND state NOT IN ('succeeded','blocked')) OR EXISTS(SELECT 1 FROM file_jobs WHERE capture_id=c.id AND state!='succeeded') pending
  FROM captures c WHERE ${where} ORDER BY c.id`).iterate(...args)){
  records++;if(row.layer==='reference')referenceOnlyRecords++;if(row.pending)pendingProcessing++;
  const samples=row.samples?(JSON.parse(String(row.samples)) as {at:string;durationMs:number}[]).filter(sample=>(!scope.after||Date.parse(sample.at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(sample.at)-sample.durationMs<Date.parse(scope.before))).map(sample=>[sample.at,sample.durationMs]):undefined;
  hash.update(JSON.stringify([row.id,samples?row.state:row.fingerprint,row.context_at,samples??row.context_end,row.perception,row.files]));
 }
 // Curated memories are interpretations, but their version is still part of
 // what a review could read. Include only memories whose complete original
 // dependency set belongs to this window; unrelated consolidation keeps running.
 for(const row of store.db.prepare(`WITH selected AS (SELECT c.id FROM captures c WHERE ${where}) SELECT m.id,m.json FROM memories m WHERE json_extract(m.json,'$.status')='published' AND EXISTS(SELECT 1 FROM memory_dependencies d LEFT JOIN file_chunks f ON f.id=d.evidence_id WHERE d.memory_id=m.id AND coalesce(f.capture_id,d.evidence_id) IN (SELECT id FROM selected)) AND NOT EXISTS(SELECT 1 FROM memory_dependencies d LEFT JOIN file_chunks f ON f.id=d.evidence_id WHERE d.memory_id=m.id AND coalesce(f.capture_id,d.evidence_id) NOT IN (SELECT id FROM selected)) ORDER BY m.id`).iterate(...args))hash.update(JSON.stringify(['memory',row.id,row.json]));
 for(const row of store.db.prepare(`WITH RECURSIVE selected AS (SELECT c.id FROM captures c WHERE ${where}),related(id) AS (SELECT artifact_id FROM artifact_inputs WHERE observation_id IN (SELECT id FROM selected) UNION SELECT d.artifact_id FROM artifact_dependencies d JOIN related r ON d.parent_id=r.id) SELECT a.id,a.revision,a.content_hash FROM context_artifacts a JOIN related r ON r.id=a.id ORDER BY a.id`).iterate(...args))hash.update(JSON.stringify(['artifact',row.id,row.revision,row.content_hash]));
 return {scopeFingerprint:hash.digest('hex'),records,referenceOnlyRecords,pendingProcessing};
}
/** Use the existing per-device activity service, then union explicit sampled
 * intervals across devices for the review's person-level coverage measurement. */
function measuredCoverage(store:Store,scope:Scope):InsightSnapshot['coverage']['measured']{
 const activity=store.activity(scope),where=['json_extract(c.json,\'$.source\') IN (\'screen\',\'activity\')',current],args:string[]=[];
 if(scope.deviceId){where.push('c.device_id=?');args.push(scope.deviceId);}
 if(scope.after){where.push('c.context_end>=?');args.push(new Date(Date.parse(scope.after)-21600000).toISOString());}
 if(scope.before){where.push('c.context_at<?');args.push(new Date(Date.parse(scope.before)+300000).toISOString());}
 const rows=store.db.prepare(`WITH samples AS (
  SELECT coalesce(json_extract(s.value,'$.at'),c.captured_at) at,coalesce(json_extract(s.value,'$.durationMs'),json_extract(c.json,'$.durationMs'),0) duration
  FROM captures c LEFT JOIN json_each(c.json,'$.stateSeries.samples') s WHERE ${where.join(' AND ')})
  SELECT at,duration FROM samples ORDER BY unixepoch(at,'subsec')*1000-duration,at`).iterate(...args);
 const lower=scope.after?Date.parse(scope.after):-Infinity,upper=scope.before?Date.parse(scope.before):Infinity;let end=-Infinity,observedDurationMs=0;
 for(const row of rows){const at=Date.parse(String(row.at)),start=Math.max(lower,at-Number(row.duration)),finish=Math.min(upper,at);if(finish<=start)continue;observedDurationMs+=Math.max(0,finish-Math.max(start,end));end=Math.max(end,finish);}
 return {observedDurationMs,deviceDurationMs:activity.totalDurationMs,overlapDurationMs:Math.max(0,activity.totalDurationMs-observedDurationMs),unobservedDurationMs:Number.isFinite(lower)&&Number.isFinite(upper)?Math.max(0,upper-lower-observedDurationMs):null,accounting:'union_across_devices',coverage:'observed_intervals_only'};
}
export function createInsightSnapshot(store:Store,id:string,input:Scope&{prompt?:string}):InsightSnapshot{
 const asOf=new Date().toISOString(),scope={...(input.after?{after:new Date(input.after).toISOString()}:{}),before:input.before?new Date(input.before).toISOString():asOf,...(input.deviceId?{deviceId:input.deviceId}:{}),timeZone:input.timeZone??'UTC'};
 const seriesId=createHash('sha256').update(JSON.stringify([input.after??null,input.before??null,input.deviceId??null,input.timeZone??'UTC',input.prompt??''])).digest('hex');
 const previous=store.db.prepare("SELECT id,json_extract(json,'$.snapshot.version') version FROM insight_runs WHERE json_extract(json,'$.snapshot.seriesId')=? ORDER BY CAST(json_extract(json,'$.snapshot.version') AS INTEGER) DESC LIMIT 1").get(seriesId);
 const {scopeFingerprint,...counts}=evidenceFingerprint(store,scope),measured=measuredCoverage(store,scope);
 const sourceStates=store.db.prepare("SELECT id,coalesce(json_extract(json,'$.status.state'),CASE WHEN json_extract(json,'$.enabled')=0 THEN 'paused' ELSE 'unknown' END) state,json_extract(json,'$.status.lastSyncAt') lastSyncAt FROM source_connections "+(scope.deviceId?"WHERE json_extract(json,'$.deviceId')=? ":'')+'ORDER BY id LIMIT 500').all(...(scope.deviceId?[scope.deviceId]:[])).map(row=>({id:String(row.id),state:String(row.state),...(row.lastSyncAt?{lastSyncAt:String(row.lastSyncAt)}:{})}));
 const limitations=['observed_samples_do_not_establish_work_time','source_registration_does_not_establish_complete_coverage',...(counts.records?[]:['no_records_in_scope']),...(counts.referenceOnlyRecords?['reference_content_unavailable']:[]),...(counts.pendingProcessing?['processing_incomplete']:[]),...(measured.unobservedDurationMs===null?['sampling_extent_unknown']:measured.unobservedDurationMs>0?['unobserved_sampling_intervals']:[])];
 return {schemaVersion:1,id,seriesId,version:previous?Number(previous.version)+1:1,...(previous?{previousRunId:String(previous.id)}:{}),asOf,scope,watermark:Number(store.db.prepare('SELECT coalesce(max(seq),0) n FROM changes').get()!.n),scopeFingerprint,coverage:{...counts,sourceStates,measured,limitations}};
}
export class InsightSnapshotChanged extends StoreError {readonly reason='snapshot_changed';constructor(){super('Evidence in this review window changed. Generate a new review version to include the latest records.',409);}}
export function assertInsightSnapshot(store:Store,snapshot:InsightSnapshot){if(evidenceFingerprint(store,snapshot.scope).scopeFingerprint!==snapshot.scopeFingerprint)throw new InsightSnapshotChanged();}
