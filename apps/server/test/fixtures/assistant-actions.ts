import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {centralCalendarPluginCapabilitySchema,messageSendPluginCapabilitySchema,type AssistantActionDraft,type ConnectorActionExecution,type ActionPluginProvider,type QueryScope} from '@mote/shared';
import {buildApp} from '../../src/app.js';
import type {Config} from '../../src/config.js';
import {TaskRecords} from '../../src/task-records.js';
import {sha256} from '../../src/store.js';
import {hostRun} from './host-run.js';

export const actionText='Generated meeting follow-up: prepare the brief and propose the next appointment.';
export const actionEvent={title:'Generated next appointment',start:'2099-11-15T10:00:00Z',end:'2099-11-15T11:00:00Z',timeZone:'UTC',allDay:false,location:'',description:'Generated follow-up'};
export const until=async(check:()=>boolean)=>{const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'generated action must settle');await new Promise(resolve=>setTimeout(resolve,10));}};

/** Real task/HTTP/SQLite and Actions domain, generated external declarations,
 * a controlled model and connector adapter. No third-party calls or profiles. */
export async function assistantActionFixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-actions-')),token='generated-assistant-actions-owner',headers={authorization:'Bearer '+token};
 const config:Config={dataDir:directory,dataKey:'42'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,
  maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-only',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 let drafts:AssistantActionDraft[]=[],loseResponse=false,enabled=true;
 const calls:ConnectorActionExecution[]=[],sourceId='generated-actions-source';
 const calendar=centralCalendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'central-connector',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,completionInMoteOnly:true}});
 const message=messageSendPluginCapabilitySchema.parse({id:'message.send',version:1,inputSchema:'message.send.v1',outputSchema:'message.receipt.v1',operations:['message.send'],executionLocation:'central-connector',risk:'message-send',constraints:{confirmsEveryMessage:true,currentEvidence:true}});
 const providers:ActionPluginProvider[]=[calendar,message].map(capability=>({name:'Generated '+capability.id,capability,identity:{packageId:'generated.assistant-actions',releaseDigest:'a'.repeat(64),instanceId:'generated-'+capability.id,instanceRevision:1,capabilityDigest:sha256(JSON.stringify(capability))}}));
 const build=async()=>{
  const value=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
   hostRun(input);
   const ids=input.evidenceIds??[];
   return {answer:JSON.stringify({answer:'Generated preparation result',actions:drafts}),citations:ids.slice(0,1).map(id=>({id,capturedAt:'2026-11-01T00:00:00Z',appName:'Generated source',excerpt:actionText})),
    runId:randomUUID(),trace:[],evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}};
  }}});
  t.mock.method(value.pluginCenter,'actionProviders',()=>enabled?providers:[]);
  t.mock.method(value.pluginCenter,'executeConnectorAction',async({request}:{request:ConnectorActionExecution})=>{
   calls.push(structuredClone(request));if(loseResponse)throw Error('Generated lost external response');
   return {status:'succeeded' as const,externalId:'generated-external-'+request.operationId};
  });
  await value.app.ready();return value;
 };
 let node=await build();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PUT',url:string,payload?:unknown,auth=headers)=>node.app.inject({method,url,headers:auth,...(payload===undefined?{}:{payload})});
 const read=async(url:string)=>{const response=await request('GET',url);assert.equal(response.statusCode,200,response.body);return response.json();};
 node.sources.register({id:sourceId,kind:'custom',name:'Generated actions source',deviceId:'generated-input',platform:'import'});
 const record=await node.sources.upsert(sourceId,{externalId:'meeting',revision:'1',observedAt:'2026-11-01T00:00:00Z',kind:'message',layer:'original',text:actionText});
 const proof=[{id:record.id,quote:actionText}];
 drafts=[{kind:'todo.create',todo:{title:'Generated preparation Todo',description:'Generated private brief',dueAt:null},evidence:proof},
  {kind:'calendar.create',event:actionEvent,uncertainty:'Review the next appointment',evidence:proof},
  {kind:'message.send',message:{conversationId:'generated-conversation',conversationName:'Generated teammate',text:'Generated private follow-up message'},evidence:proof}];
 const scope:QueryScope={kind:'selection',sourceIds:[sourceId]};
 const tasks=new TaskRecords(node.store),matters=node.featureServices.assistantMatters;
 const authority={currentEvidence:(ids:readonly string[])=>node.store.evidence([...ids]).map(item=>({id:item.id,title:item.windowTitle??'',deviceId:item.deviceId,sourceId:item.provenance?.sourceId,at:item.capturedAt})),
  currentTask:(id:string)=>{try{return tasks.get(id);}catch{return undefined;}}};
 const matter=matters.command({type:'create',requestId:randomUUID(),goal:'Generated meeting follow-up',scope,evidenceIds:[record.id]},authority);
 const start=async()=>{
  const card=node.featureServices.assistantCards.publish({id:randomUUID(),kind:'suggestion',matterId:matter.id,version:randomUUID(),state:'open',title:'Generated preparation',body:'Generated follow-up',evidence:proof,evidenceDependencies:{version:1,complete:true,ids:[record.id]}},undefined,scope,()=>{});
  const task=node.assistantTasks.acceptSuggestion({requestId:randomUUID(),goal:'Prepare for the generated meeting',scope},{cardId:card.id,expectedRevision:card.revision},authority);
  await until(()=>['succeeded','failed','blocked','stale'].includes(tasks.get(task.id).state));
  assert.equal(tasks.get(task.id).state,'succeeded',JSON.stringify(node.assistantTasks.get(task.id,scope)));
  return task.id;
 };
 const grant=async(kind:'calendar.manage'|'message.send',inputsSource=sourceId)=>{
  const inventory=await read('/api/action-capabilities'),choice=inventory.centralConnectors.find((value:any)=>value.capability.id===kind),provider=providers.find(value=>value.capability.id===kind)!;
  const identity=node.sources.getSource(inputsSource),input={operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:choice.capability,target:choice.target,inputs:{sources:[{sourceId:identity.id,kind:identity.kind,deviceId:identity.deviceId,platform:identity.platform}],existingArchived:true,futureInputs:true}};
  const saved=await request('PUT','/api/action-capability-drafts',input);assert.equal(saved.statusCode,200,saved.body);
  const authorized=await request('PUT','/api/action-capability-grants',{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:saved.json().id,draftRevision:saved.json().revision,plugin:provider.identity,...(kind==='message.send'?{acknowledgeMessageSends:true}:{acknowledgeCalendarWrites:true})});assert.equal(authorized.statusCode,200,authorized.body);
  return {target:choice.target,grant:authorized.json()};
 };
 const paired=await node.connections.redeem({code:node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated'},'collector').invitation.code,deviceId:'generated-review',deviceName:'Generated review',platform:'macos'});
 const collector={authorization:'Bearer '+paired.token};
 const tick=async()=>{const response=await request('GET','/api/managed-calendar-deliveries',undefined,collector);assert.equal(response.statusCode,200,response.body);};
 const path=(taskId:string)=>'/api/assistant/tasks/'+taskId+'/actions?'+new URLSearchParams({scope:JSON.stringify(scope)});
 const create=async(taskId:string,index:number,target?:unknown)=>{
  const view=await read(path(taskId)),payload={taskId,expectedRevision:view.revision,index,scope,...(target?{target}:{})};
  return {payload,response:await request('POST','/api/assistant/action-commands',payload)};
 };
 return {get node(){return node;},headers,collector,request,read,start,grant,tick,path,create,calls,record,scope,matter,
  setLoseResponse(value:boolean){loseResponse=value;},setEnabled(value:boolean){enabled=value;},setDrafts(value:AssistantActionDraft[]){drafts=value;},
  async restart(){await node.app.close();node=await build();}};
}
