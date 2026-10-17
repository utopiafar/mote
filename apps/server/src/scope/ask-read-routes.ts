import {z} from 'zod';
import {memoryPageInputSchema} from './memory-data.js';
import {navigationScopeSchema} from '../context-navigation.js';
import {safeTextWindow} from '../text-window.js';
import {registerUserRoute,type ScopedRuntime} from './http.js';
import type {AskHost} from './ask.js';
import {ASK_DOMAIN} from './ask-schema.js';
import {buildContextEnvelope,taskTools,systemInstructions,contextToolDefinitions} from '@mote/agent';
import {requestLocale} from '../i18n.js';

const flag=z.enum(['true','false']).transform(value=>value==='true').optional(),range=navigationScopeSchema.extend({limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().max(8192).optional()}),query=range.extend({query:z.string().max(2000).optional(),maxCharacters:z.coerce.number().int().min(1000).max(24000).optional(),includeMemories:flag,includeRecentSessions:flag}).strict(),window={offset:z.coerce.number().int().min(0).max(10000000).default(0),length:z.coerce.number().int().min(1).max(12000).default(4000)};
/** HTTP and MCP consume the same actual query-visible host facade. These routes
 * do not fall back to the owner's full private-data repository. */
export function registerAskReadRoutes(runtime:ScopedRuntime,host:AskHost){
 const reader=(context:Parameters<AskHost['bind']>[0])=>host.bind(context,{assertCurrent:()=>runtime.authority.assert(context)}).reader();
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/context/browse',handle:({context,request})=>reader(context).browse(query.parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/context/search',handle:({context,request})=>reader(context).search(query.parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/context/retrieve',handle:({context,request})=>reader(context).retrieve(query.parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/context/bundle',handle:({context,request})=>reader(context).context(query.parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/context/status',handle:({context})=>reader(context).status()});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'POST',url:'/api/context/read',handle:({context,request})=>{const {refs,offset,length,...scope}=navigationScopeSchema.extend({refs:z.array(z.string().min(1).max(4096)).min(1).max(50),...window}).strict().parse(request.body);return reader(context).read(refs,{offset,length,scope});}});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/runs',handle:({context})=>host.bind(context,{assertCurrent:()=>runtime.authority.assert(context)}).traceRuns()});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/events',handle:({context,request})=>host.bind(context,{assertCurrent:()=>runtime.authority.assert(context)}).traceEvents(request.query)});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'POST',url:'/api/agent-view/startup',handle:async({context,request})=>{
  const input=navigationScopeSchema.pick({after:true,before:true,deviceId:true}).extend({question:z.string().max(4000).default(''),timeZone:z.string().max(100).default('UTC')}).strict().parse(request.body),bound=reader(context),contextTime=new Date().toISOString();
  const leads=await bound.opening({after:input.after,before:input.before,deviceId:input.deviceId});bound.assertCurrent();
  const query={...input,language:requestLocale.getStore()??'zh-CN',contextTime,openingMemories:leads,toolContributions:bound.agent.contextTools?.()},tools=taskTools(query);
  return {kind:'new_conversation_preview',context:buildContextEnvelope(query,[]),system:systemInstructions(query,[]),tools,toolDefinitions:contextToolDefinitions(query).filter(([name])=>tools.includes(name)),modelCalls:0};
 }});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/evidence',handle:async({context,request})=>{
  const {id,offset,length,...scope}=navigationScopeSchema.extend({id:z.string().min(1).max(1600),...window}).strict().parse(request.query),bound=reader(context),records=await bound.agent.evidence({...scope,ids:[id]});bound.assertCurrent();
  return {items:records.map(record=>{const {text,textRange}=safeTextWindow(record.ocrText,offset,length);return {...record,ocrText:text,textRange};})};
 }});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/catalog',handle:({context,request})=>reader(context).agent.catalog!(range.extend({limit:z.coerce.number().int().min(1).max(12).default(12),path:z.string().max(100).optional(),query:z.string().max(500).optional()}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/materials',handle:({context,request})=>reader(context).agent.materialCatalog!(range.extend({kind:z.string().max(128).optional(),query:z.string().max(500).optional()}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/material-read',handle:({context,request})=>reader(context).agent.materialRead!(navigationScopeSchema.extend({ref:z.string().min(1).max(160),...window}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/memories',handle:({context,request})=>reader(context).agent.memories!(memoryPageInputSchema.extend({includeEvidence:flag,includeHistory:flag,includeStale:flag}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/source-items',handle:({context,request})=>reader(context).agent.sourceItems!(range.extend({sourceId:z.string().min(1).max(128)}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/segments',handle:async({context,request})=>{const {offset,length,...scope}=range.extend({id:z.string().max(160).optional(),query:z.string().max(500).optional(),...window}).strict().parse(request.query),bound=reader(context),page=await bound.agent.segments!(scope);bound.assertCurrent();return {...page,items:page.items.map(item=>({...item,...safeTextWindow(String(item.text),offset,length)}))};}});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/source-history',handle:({context,request})=>reader(context).logicalHistory(navigationScopeSchema.extend({sourceId:z.string().min(1).max(128),externalId:z.string().min(1).max(2048)}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/agent-view/file-chunks',handle:({context,request})=>reader(context).agent.fileChunks!(navigationScopeSchema.extend({id:z.string().min(1).max(128),offset:z.coerce.number().int().nonnegative().optional()}).strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/activity',handle:({context,request})=>reader(context).agent.activity(navigationScopeSchema.strict().parse(request.query))});
 registerUserRoute(runtime,{scope:'user',service:ASK_DOMAIN,method:'GET',url:'/api/media-activity',handle:({context,request})=>reader(context).agent.mediaActivity!(navigationScopeSchema.extend({appVisibility:z.enum(['foreground','background','unknown']).optional(),screenLocked:flag,playbackType:z.enum(['local','remote','unknown']).optional()}).strict().parse(request.query))});
}
