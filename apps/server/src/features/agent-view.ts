import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { navigationScopeSchema } from '../context-navigation.js';
import type { FeatureServices } from '../feature-services.js';
import {buildContextEnvelope,taskTools,systemInstructions,contextToolDefinitions} from '@mote/agent';
import {openingMemories} from '../opening-memory.js';
import {requestLocale} from '../i18n.js';
const scope={...navigationScopeSchema.shape,limit:z.coerce.number().int().min(1).max(20).default(12),cursor:z.string().max(4096).optional()};
export function register(app:FastifyInstance,{archiveReader,diagnostics}:Pick<FeatureServices,'archiveReader'|'diagnostics'>){
  app.get('/api/agent-view/catalog',async req=>archiveReader.catalog!(z.object({...scope,path:z.string().max(100).optional()}).strict().parse(req.query)));
  app.get('/api/agent-view/materials',async req=>archiveReader.materialCatalog!(z.object({...scope,kind:z.string().max(128).optional()}).strict().parse(req.query)));
  app.get('/api/agent-view/material-read',async req=>archiveReader.materialRead!(z.object({...navigationScopeSchema.shape,ref:z.string().min(1).max(1600),offset:z.coerce.number().int().min(0).default(0),length:z.coerce.number().int().min(1).max(4000).default(4000)}).strict().parse(req.query)));
  app.get('/api/agent-view/memories',async req=>{
    const page=await archiveReader.memories!(z.object({...scope,id:z.string().max(128).optional(),includeEvidence:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict().parse(req.query));
    return {...page,...(page.sourceSpans?{sourceSpans:page.sourceSpans.map(span=>({...span,offset:0,record:{...span.record,ocrText:span.record.ocrText.slice(span.offset,span.offset+span.length)}}))}:{})};
  });
  app.get('/api/agent-view/source-items',async req=>{
    const page=await archiveReader.sourceItems!(z.object({...scope,sourceId:z.string().max(128)}).strict().parse(req.query));
    const items=(Array.isArray(page)?page:page.items).map(record=>({id:record.id,ref:record.ref,appName:record.appName,windowTitle:record.windowTitle,capturedAt:record.capturedAt,sourceType:record.sourceType,revisionState:record.revisionState,preview:record.ocrText.slice(0,400),characters:record.ocrText.length}));
    return {items,nextCursor:Array.isArray(page)?null:page.nextCursor};
  });
  app.get('/api/agent-view/segments',async req=>archiveReader.segments!(z.object({...scope,id:z.string().max(1600).optional()}).strict().parse(req.query)));
  app.post('/api/agent-view/startup',{bodyLimit:16384},async req=>{
    const input=z.object({question:z.string().max(4000).default(''),after:navigationScopeSchema.shape.after,before:navigationScopeSchema.shape.before,deviceId:navigationScopeSchema.shape.deviceId,timeZone:z.string().max(100).default('UTC')}).strict().parse(req.body);
    // Preview a NEW conversation through the same reader and envelope builder.
    // Never compact dialogue, invoke a provider, or reconstruct a previous run.
    const contextTime=new Date().toISOString(),leads=await openingMemories(archiveReader,input.question,{...input,contextTime});
    const query={...input,language:requestLocale.getStore()??'zh-CN',contextTime,openingMemories:leads,toolContributions:archiveReader.contextTools?.()};
    const tools=taskTools(query);
    return {kind:'new_conversation_preview',context:buildContextEnvelope(query,[]),system:systemInstructions(query,[]),tools,toolDefinitions:contextToolDefinitions(query).filter(([name])=>tools.includes(name)),modelCalls:0};
  });
  app.get('/api/agent-view/evidence',async req=>{
    const {id,offset,length,...range}=z.object({...navigationScopeSchema.shape,id:z.string().min(1).max(1600),offset:z.coerce.number().int().min(0).default(0),length:z.coerce.number().int().min(1).max(4000).default(4000)}).strict().parse(req.query);
    const records=await archiveReader.evidence({...range,ids:[id]});
    return {items:records.map(record=>({...record,ocrText:record.ocrText.slice(offset,offset+length),textRange:{offset,total:record.ocrText.length,nextOffset:offset+length<record.ocrText.length?offset+length:null}}))};
  });
  app.get('/api/agent-view/runs',async()=>{
    const snapshot=diagnostics.snapshot(),events=diagnostics.events(Math.max(0,snapshot.lastSeq-500),500),runs=new Map<string,{runId:string;at:string;type:string;firstSeq:number}>();
    for(const event of events.items){const trace=event.trace;if(event.event!=='agent.trace'||typeof trace?.runId!=='string'||typeof trace.type!=='string')continue;const previous=runs.get(trace.runId);runs.set(trace.runId,{runId:trace.runId,at:event.at,type:trace.type,firstSeq:previous?.firstSeq??event.seq});}
    return {items:[...runs.values()].reverse().slice(0,20),recording:snapshot.agentTrace,partial:true};
  });
  app.post('/api/agent-view/read',{bodyLimit:8192},async req=>{
    const {ref,offset,length,...range}=z.object({...navigationScopeSchema.shape,ref:z.string().min(1).max(1600),offset:z.number().int().min(0).default(0),length:z.number().int().min(1).max(4000).default(4000)}).strict().parse(req.body);
    return archiveReader.materialRead!({...range,ref,offset,length});
  });
  // Only previously recorded events; never reconstruct a historical prompt from current data.
  app.get('/api/agent-view/events',async req=>{
    const {afterSeq,runId}=z.object({afterSeq:z.coerce.number().int().min(0).default(0),runId:z.string().max(200).optional()}).strict().parse(req.query);
    const page=diagnostics.events(afterSeq,100);
    const items:typeof page.items=[];let characters=0,nextSeq=afterSeq;
    for(const event of page.items){
      if(event.event!=='agent.trace'||runId&&event.trace?.runId!==runId){nextSeq=event.seq;continue;}
      const payload=JSON.stringify(event.trace?.payload??null),bounded=payload.length>12000?{...event,trace:{...event.trace,truncated:true,payload:{preview:payload.slice(0,12000)}}}:event;
      const size=JSON.stringify(bounded).length;if(characters+size>60000)break;
      items.push(bounded);characters+=size;nextSeq=event.seq;
    }
    return {items,nextSeq,oldestSeq:page.oldestSeq,recording:diagnostics.snapshot().agentTrace};
  });
}
