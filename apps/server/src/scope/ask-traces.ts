import {z} from 'zod';
import type {AgentTraceEvent} from '@mote/agent';
import {compactTraceValue} from '../diagnostics.js';
import {MAX_TRACE_EVENT_BYTES} from '../log-retention-config.mjs';
import {PrivateCursor,type PrivateSql} from './private-data-sql.js';

type Settings={traceEnabled:boolean;maxBytes:number;maxFiles:number;maxEntries:number};
const recording=(settings:Settings)=>({enabled:settings.traceEnabled});
/** Same opt-in, compaction and event retention as original diagnostics; detailed
 * values stay in the existing owner/run JSON, never instance diagnostics. */
export function recordAskTrace(sql:PrivateSql,runId:string,event:AgentTraceEvent,settings:Settings){
 const value:Record<string,unknown>={type:event.type,stage:event.stage,phase:event.phase,tool:event.tool,status:event.status,durationMs:event.durationMs,at:new Date().toISOString()};
 if(recording(settings).enabled){const payload=compactTraceValue(event.payload);if(payload.value!==undefined)value.payload=payload.value;if(payload.truncated)value.truncated=true;
  if(Buffer.byteLength(JSON.stringify(value))>Math.min(settings.maxBytes,MAX_TRACE_EVENT_BYTES)){value.payload='trace payload exceeded the diagnostic event limit';value.truncated=true;}}
 sql.run('INSERT INTO ma_traces SELECT $user,?,coalesce(max(sequence),0)+1,? FROM ma_traces WHERE user_id=$user AND run_id=?',runId,JSON.stringify(value),runId);
 sql.run("UPDATE ma_traces SET json=json_set(json_remove(json,'$.payload'),'$.truncated',json('true')) WHERE user_id=$user AND rowid IN(SELECT position FROM(SELECT rowid position,row_number() OVER(ORDER BY rowid DESC) n,sum(length(CAST(json AS BLOB))) OVER(ORDER BY rowid DESC) bytes FROM ma_traces WHERE user_id=$user AND json_type(json,'$.payload') IS NOT NULL) WHERE n>? OR bytes>?)",settings.maxEntries,settings.maxBytes*settings.maxFiles);
}

export function privateAskTraces(sql:PrivateSql,codec:PrivateCursor,assertRun:(id:string)=>void,settings:Settings){
 const checked=new Set<string>(),visible=(id:string)=>{if(!checked.has(id)){assertRun(id);checked.add(id);}};
 return {
  runs:()=>{const rows=sql.all("SELECT run_id,max(json_extract(json,'$.at')) at FROM ma_traces WHERE user_id=$user GROUP BY run_id ORDER BY at DESC,run_id DESC LIMIT 20"),items=[];for(const row of rows)try{visible(String(row.run_id));items.push({runId:String(row.run_id),at:String(row.at),type:'retained'});}catch(error){if(!error||typeof error!=='object'||!('statusCode' in error)||![404,409].includes(Number(error.statusCode)))throw error;}return {items,recording:recording(settings),partial:true};},
  events:(raw:unknown)=>{
   const {cursor,afterSeq:_afterSeq,...query}=z.object({runId:z.string().uuid().optional(),cursor:z.string().max(8192).optional(),afterSeq:z.coerce.number().int().max(0).min(0).optional(),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().parse(raw);if(query.runId)visible(query.runId);
   const identity={collection:'agent-trace-events',...query},position=cursor?z.object({at:z.string(),id:z.string()}).strict().parse(codec.decodeCompact(cursor,identity)):undefined;
   const rows=sql.all("SELECT run_id,sequence,json FROM ma_traces WHERE user_id=$user AND (? IS NULL OR run_id=?) AND (json_extract(json,'$.at')>? OR(json_extract(json,'$.at')=? AND run_id||':'||printf('%010d',sequence)>?)) ORDER BY json_extract(json,'$.at'),run_id,sequence LIMIT ?",query.runId??null,query.runId??null,position?.at??'',position?.at??'',position?.id??'',query.limit+1),page=rows.slice(0,query.limit),items=[];let characters=0,last:typeof rows[number]|undefined;
   for(const row of page){try{visible(String(row.run_id));}catch(error){if(!error||typeof error!=='object'||!('statusCode' in error)||![404,409].includes(Number(error.statusCode)))throw error;last=row;continue;}let trace=JSON.parse(String(row.json));const payload=JSON.stringify(trace.payload??null);if(payload.length>12000)trace={...trace,truncated:true,payload:{preview:payload.slice(0,12000)}};const item={seq:String(row.run_id)+':'+row.sequence,at:String(trace.at),trace:{...trace,runId:String(row.run_id)}};const size=JSON.stringify(item).length;if(characters+size>60000)break;items.push(item);characters+=size;last=row;}
   const more=Boolean(last&&(rows.length>query.limit||last!==page.at(-1))),nextCursor=more?codec.encodeCompact(identity,{at:String(JSON.parse(String(last!.json)).at),id:String(last!.run_id)+':'+String(last!.sequence).padStart(10,'0')}):null;
   return {items,nextCursor,recording:recording(settings),partial:true};
  },
 };
}
