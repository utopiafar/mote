import {testInstanceState as createInstanceState} from './fixtures/plugin-storage.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

import {materialId} from '../src/materials.js';
import {LARK_VERSION,larkArguments,type LarkCommand,type LarkRunner} from '../src/connectors/lark-cli.js';
import {createLarkBinding,LARK_IM_READ_SCOPES} from '../src/connectors/lark-binding.js';

const epoch=Date.now()-90*86400000;
const chatId='oc_generated_sync';
const at=(n=0)=>String(epoch+n);
const message=(n:number,extra:Record<string,unknown>={})=>({message_id:'om_generated_'+n,msg_type:'text',create_time:at(n),chat_id:chatId,sender:{id:'ou_generated_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated historical message '+n})},...extra});
type Message=ReturnType<typeof message>;
type PageCommand=Extract<LarkCommand,{kind:'im-messages'|'im-thread-messages'}>;
const isPage=(command:LarkCommand):command is PageCommand=>command.kind==='im-messages'||command.kind==='im-thread-messages';
function fakeLark(){
 const calls:{command:LarkCommand;account:string;scopes:string[]}[]=[];
 const threads=new Map<string,Message[]>();
 const state={account:'ou_generated_A',connected:true,scopes:[...LARK_IM_READ_SCOPES],messages:[] as Message[],pending:[] as string[],sent:0,failStatus:false,providerPageSize:50};
 const api={state,calls,threads,
  beforePage:undefined as undefined|((command:PageCommand)=>Promise<void>),
  pageResult:undefined as undefined|((command:PageCommand,body:Record<string,unknown>)=>Record<string,unknown>),
  statusResult:undefined as undefined|((body:Record<string,unknown>)=>Record<string,unknown>),
  runner:undefined as unknown as LarkRunner};
 api.runner=async(command,options={})=>{
  calls.push({command,account:state.account,scopes:[...state.scopes]});
  const json=(data:unknown)=>JSON.stringify(data);
  if(command.kind==='version')return 'lark-cli version '+LARK_VERSION;
  if(command.kind==='status'){if(state.failStatus)throw Object.assign(Error('generated temporary CLI failure'),{code:'lark_command_failed',statusCode:502});const body={appId:'cli_generated_sync',identities:{user:{available:state.connected,openId:state.account,userName:'Generated '+state.account,scope:state.scopes.join(' ')}}};return json(api.statusResult?.(body)??body);}
  if(command.kind==='login'){state.pending=[...command.scopes];return json({verification_url:'https://accounts.feishu.cn/authorize?generated=sync',device_code:'private-generated-only',expires_in:600});}
  if(command.kind==='complete'){state.scopes=state.pending;return json({ok:true});}
  if(command.kind==='im-chats')return json({data:{items:[{chat_id:chatId,name:'Generated sync group',chat_mode:'group'}],has_more:false}});
  if(command.kind==='im-send'){state.sent++;return json({data:{message_id:'om_generated_sent_'+state.sent,create_time:String(Date.now()),body:{content:JSON.stringify({text:command.text})}}});}
  if(!isPage(command))throw Error('Unexpected generated Feishu command '+command.kind);
  await api.beforePage?.(command);
  if(options.signal?.aborted)throw Object.assign(Error('cancelled'),{code:'lark_operation_cancelled',statusCode:409});
  const raw=command.kind==='im-messages'?state.messages:threads.get(command.threadId)??[];
  const entries=raw.filter(value=>command.kind==='im-thread-messages'||Number(value.create_time)/1000>=Number(command.startTime??0)&&Number(value.create_time)/1000<Number(command.endTime??Infinity)).sort((a,b)=>Number(a.create_time)-Number(b.create_time));
  const offset=Number(command.pageToken?.replace('offset-','')??0),items=entries.slice(offset,offset+Math.min(command.pageSize??50,state.providerPageSize));
  const next=offset+items.length<entries.length?'offset-'+(offset+items.length):undefined;
  const body={items,has_more:Boolean(next),...(next?{page_token:next}:{})};
  // v1.0.98's generic api command decodes RawBody into a map and emits the
  // business data in this envelope; it does not marshal ListMessageRespData.
  // https://github.com/larksuite/cli/blob/v1.0.98/internal/client/response.go
  return json({ok:true,identity:'user',data:api.pageResult?.(command,body)??body});
 };
 return api;
}
async function fixture(t:TestContext,transport=fakeLark()){
 const root=mkdtempSync(join(tmpdir(),'mote-feishu-sync-')),owner='generated-owner-'+randomUUID(),headers={authorization:'Bearer '+owner};
 const config:Config={dataDir:root,token:owner,tokenPath:join(root,'owner'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxExportBytes:1024*1024,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(root,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
 let binding=createLarkBinding({runner:transport.runner});
 const boot=()=>buildApp(config,{backgroundWorker:false,connectorTesting:{lark:transport.runner,larkBinding:binding,fetch:async()=>{throw Error('No external network in Feishu sync fixture');}},agent:{configured:false,async query(){throw Error('No model in Feishu sync fixture');},async close(){}}});
 let node=await boot();
 t.after(async()=>{await node.app.close();rmSync(root,{recursive:true,force:true});});
 const wait=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+12000;while(!await check()){if(Date.now()>end)throw Error('Feishu package lifecycle did not settle');await new Promise(resolve=>setTimeout(resolve,10));}};
 const request=async(path:string,payload?:unknown,status=200)=>{const result=await node.app.inject({url:path,headers,...(payload===undefined?{}:{method:'POST' as const,payload})});assert.equal(result.statusCode,status,result.body);return result.json();};
 const preview=await request('/api/plugins/resolve',{repository:'mote/official-feishu-session-connector',tag:'v0.1.0'});
 await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.view().packages[0]?.state==='installed');
 const instance=await request('/api/plugin-instances',{packageId:node.pluginCenter.view().packages[0]!.id,name:'Generated Feishu sync',scope:'default',configuration:{},expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await request('/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');
 await request('/api/plugin-instances/'+instance.id+'/enable',{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready');
 await wait(async()=>(await node.app.inject({url:'/api/connectors/feishu-session',headers})).statusCode===200);
 const authorize=async()=>{await request('/api/connectors/feishu-session/archive/start',{});await wait(async()=>{const status=await request('/api/connectors/feishu-session');return status.archiveAuthorized&&status.job?.state==='completed';});};
 await authorize();
 const select=()=>request('/api/connectors/feishu-session/select',{selected:[{id:chatId,type:'group'}]});await select();
 const scan=()=>{const row=node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='feishu-session.scan.0'").get();return row?JSON.parse(String(row.json)):undefined;};
 return {get node(){return node;},get binding(){return binding;},instance,transport,headers,request,scan,select,authorize,wait,
  source:()=>node.sources.listSources().find(value=>value.kind==='mote.official.feishu-session'&&value.enabled)!,
  async sync(status=200){const before=transport.calls.filter(({command})=>isPage(command)).length;try{return await request('/api/connectors/feishu-session/sync',{},status);}finally{const count=transport.calls.filter(({command})=>isPage(command)).length-before;assert.ok(count<=20,'chat and thread pages share the actual 20-request budget: '+count);}},
  async restart(){await node.app.close();binding=createLarkBinding({runner:transport.runner});node=await boot();await wait(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');},
 };
}

async function materialBody(f:Awaited<ReturnType<typeof fixture>>,externalId:string){
 const id=f.source().id;
 // The real organizer discovers at most 500 changes per tick. Its admitted
 // worker can already be running after intake, so allow it to settle between
 // bounded ticks rather than polling only resolved no-op promises.
 const until=Date.now()+30000;
 for(;;){
  await f.node.materialOrganizer.tick(1000);const record=f.node.materials.get(materialId(id,externalId)),head=f.node.sources.getItem(id,externalId);
  if(record&&record.coverage.reason!=='source_evidence_changed'&&f.node.materials.members(record.ref).items.some(member=>member.ref==='capture:'+head?.captureId))break;
  assert.ok(Date.now()<until,'the actual source Material must finish the bounded generated batches: '+JSON.stringify({record,groups:f.node.store.db.prepare('SELECT * FROM material_organizer_groups WHERE material_id=?').all(materialId(id,externalId)),steps:f.node.store.db.prepare("SELECT state,error,COUNT(*) n FROM execution_steps GROUP BY state,error").all()}));
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 const record=await f.request('/api/materials/'+materialId(id,externalId));
 const model=await f.request('/api/agent-view/material-read?ref='+encodeURIComponent(record.ref)+'&length=4000');
 assert.deepEqual(model.material.coverage,record.coverage);
 return {record,model};
}

async function confirmedSend(f:Awaited<ReturnType<typeof fixture>>){
 await f.request('/api/connectors/feishu-session/send/start',{});await f.wait(async()=>{const value=await f.request('/api/connectors/feishu-session');return value.sendAuthorized&&value.job?.state==='completed';});
 const inventory=await f.request('/api/action-capabilities'),choice=inventory.centralConnectors.find((value:any)=>value.capability.id==='message.send'),provider=inventory.providers.find((value:any)=>value.capability.id==='message.send'),source=f.source();
 const put=async(url:string,payload:unknown)=>{const result=await f.node.app.inject({method:'PUT',url,headers:f.headers,payload});assert.equal(result.statusCode,200,result.body);return result.json();};
 const draft=await put('/api/action-capability-drafts',{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:{id:'message.send',version:1},target:choice.target,inputs:{sources:[{sourceId:source.id,kind:source.kind,deviceId:source.deviceId,platform:source.platform}],existingArchived:true,futureInputs:true}});
 await put('/api/action-capability-grants',{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:provider.identity,acknowledgeMessageSends:true});
 const actions=await f.request('/api/actions'),proposal=await f.request('/api/actions/messages',{operationId:randomUUID(),expectedRevision:actions.messageRevision,target:choice.target,message:{conversationId:chatId,conversationName:'Generated sync group',text:'Generated acknowledged send during unfinished history'}});
 await f.request('/api/actions/'+proposal.proposal.id+'/confirm',{version:proposal.proposal.version,target:choice.target,message:proposal.proposal.message});await f.wait(()=>f.node.actions.get(proposal.proposal.id).status==='succeeded');
 assert.equal(f.transport.state.sent,1);return f.node.sources.getItem(source.id,'om_generated_sent_1')!;
}

test('installed Feishu all persists over twenty same-second pages and resumes its fixed window after restart',async t=>{
 const f=await fixture(t);f.transport.state.messages=Array.from({length:1105},(_,i)=>message(i,{create_time:at()}));
 await f.sync();const id=f.source().id;
 assert.ok(f.node.sources.getItem(id,'om_generated_0'),'all archives history older than thirty days');
 const first=f.scan();assert.equal(first.processed,1000);assert.equal(first.complete,false);assert.equal(first.history.token,'offset-1000');assert.equal(first.completeThrough,undefined);
 const coverage=(await f.request('/api/sources')).items.find((source:any)=>source.id===id).status.coverage;assert.equal(coverage.state,'partial');assert.equal(coverage.remaining,null);assert.deepEqual(coverage.limitations,['pagination_pending']);
 const calls=f.transport.calls.filter(({command})=>command.kind==='im-messages');assert.equal(calls.length,20);assert.ok(calls.every(({command})=>command.kind==='im-messages'&&command.startTime==='0'&&command.pageSize===50));assert.equal(new Set(calls.map(({command})=>command.kind==='im-messages'&&command.endTime)).size,1);
 const sent=await confirmedSend(f);assert.match(sent.text,/acknowledged send during unfinished history/);assert.deepEqual(f.scan(),first,'a real Actions send archive cannot advance an unfinished scan or completion watermark');
 const later=String(Date.parse(first.window.to)+1);f.transport.state.messages.push(message(1105,{create_time:later}));
 await f.restart();await f.sync();assert.deepEqual(f.scan().window,first.window);assert.equal(f.scan().processed,1105);assert.equal(f.scan().complete,true);assert.equal(f.scan().completeThrough,first.window.to);assert.equal(f.node.sources.getItem(id,'om_generated_1105'),undefined);assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM source_heads WHERE source_id=?').get(id)!.n,1106,'1105 scanned historical messages plus the separately acknowledged send');assert.equal(f.node.sources.history(id,'om_generated_1000').length,1);
 const sizes=f.node.store.db.prepare('SELECT COUNT(*) n,MAX(bytes) maximum,SUM(bytes) total FROM plugin_instance_state').get()!;assert.equal(sizes.n,2);assert.ok(Number(sizes.maximum)<65536);assert.ok(Number(sizes.total)<1024*1024);
});

test('Feishu thread paging retains full replies and replays a failed checkpoint without losing the current chat page',async t=>{
 const f=await fixture(t),root=message(0,{thread_id:'omt_generated_0'}),tail='Generated full Feishu reply tail';
 f.transport.state.messages=[root,message(2000)];
 f.transport.threads.set('omt_generated_0',[root,...Array.from({length:1005},(_,i)=>message(i+1,{thread_id:'omt_generated_0',root_id:root.message_id,parent_id:root.message_id,body:{content:JSON.stringify({text:i===1004?'x'.repeat(210000)+tail:'Generated thread reply '+i})}}))]);
 // The former aggregate remains in this source's real revision chain.
 await f.node.sources.upsert(f.source().id,{externalId:root.message_id,revision:'generated-old-merged',observedAt:new Date().toISOString(),kind:'message',layer:'snapshot',text:'Generated former root and reply aggregate'});
 f.node.store.db.exec("CREATE TRIGGER generated_feishu_checkpoint BEFORE UPDATE ON plugin_instance_state WHEN new.key='feishu-session.scan.0' AND json_extract(new.json,'$.processed')=50 BEGIN SELECT RAISE(ABORT,'generated checkpoint failure'); END");
 await f.sync(502);assert.equal(f.scan().processed,1);assert.equal(f.scan().thread.token,'');assert.equal(f.scan().history.done.length,0);assert.equal(f.scan().failed,1);assert.equal(f.node.sources.history(f.source().id,root.message_id).length,2);
 f.node.store.db.exec('DROP TRIGGER generated_feishu_checkpoint');await f.restart();const resumed=await f.sync();assert.equal(resumed.duplicates,49);assert.equal(f.scan().processed,1000);assert.equal(f.scan().complete,false);assert.equal(f.scan().thread.token,'offset-1000');const fixed=f.scan().window;
 const previous=f.transport.beforePage;f.transport.beforePage=async command=>{if(command.kind==='im-thread-messages')throw Object.assign(Error('generated reply failure'),{code:'lark_command_failed',statusCode:503});await previous?.(command);};
 await f.sync(503);assert.equal(f.scan().thread.token,'offset-1000');assert.equal(f.scan().failed,1);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'partial');f.transport.beforePage=previous;
 await f.restart();await f.sync();assert.equal(f.scan().processed,1007);assert.equal(f.scan().complete,true);assert.deepEqual(f.scan().window,fixed);assert.equal(f.scan().thread,undefined);
 const item=f.node.sources.getItem(f.source().id,'om_generated_1005')!;assert.ok(item.text.endsWith(tail));assert.ok(item.text.length>200000);assert.equal(item.document?.originalMetadata?.rootExternalId,root.message_id);assert.equal(item.document?.originalMetadata?.parentExternalId,root.message_id);assert.equal(item.document?.originalMetadata?.threadRootExternalId,root.message_id);assert.equal(item.document?.originalMetadata?.chatId,chatId);assert.equal(item.document?.originalMetadata?.authorId,'ou_generated_author');assert.equal(item.document?.recordedAt,new Date(Number(at(1005))).toISOString());assert.deepEqual(item.document?.bodyCoverage,{state:'complete'});
 const material=await materialBody(f,item.externalId),read=await f.request('/api/materials/'+material.record.id+'/read?offset=209900&length=1000');assert.match(read.text,/Generated full Feishu reply tail/);assert.equal(read.material.coverage.state,'complete');assert.equal(f.node.sources.history(f.source().id,item.externalId).length,1);
 assert.ok(f.transport.calls.filter(({command})=>command.kind==='im-thread-messages').every(({command})=>command.kind==='im-thread-messages'&&command.pageSize===50&&!('startTime'in command)&&!('endTime'in command)));
});

test('Feishu new-only skips old root bodies but discovers their new replies on subsequent full root sweeps',async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});
 const f=await fixture(t),root=message(0,{thread_id:'omt_generated_old'});f.transport.state.messages=[root];f.transport.threads.set('omt_generated_old',[root]);const id=f.source().id;
 const patch=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(patch.statusCode,200,patch.body);
 await f.sync();const first=f.scan();assert.equal(first.processed,0);assert.equal(f.node.sources.getItem(id,root.message_id),undefined);
 const reply=message(1,{create_time:String(clock+1000),thread_id:'omt_generated_old',root_id:root.message_id,parent_id:root.message_id});f.transport.threads.set('omt_generated_old',[root,reply]);
 t.mock.timers.tick(2000);await f.restart();await f.sync();assert.equal(f.scan().baselineAt,first.baselineAt);assert.equal(f.scan().processed,1);assert.equal(f.scan().complete,true);assert.equal(f.node.sources.getItem(id,root.message_id),undefined);const item=f.node.sources.getItem(id,reply.message_id)!;assert.match(item.text,/historical message 1/);assert.doesNotMatch(item.text,/historical message 0/);assert.equal(item.document?.originalMetadata?.threadRootExternalId,root.message_id);
});

test('Feishu multiple root threads persist the current page when the common request budget expires',async t=>{
 const f=await fixture(t);f.transport.state.messages=Array.from({length:40},(_,i)=>message(i,{thread_id:'omt_generated_'+i}));
 for(const root of f.transport.state.messages)f.transport.threads.set(String(root.thread_id),[root,message(1000+Number(root.message_id.replace('om_generated_','')),{thread_id:root.thread_id,root_id:root.message_id,parent_id:root.message_id})]);
 await f.sync();const first=f.scan();assert.equal(first.complete,false);assert.equal(first.processed,39);assert.equal(first.thread.id,'omt_generated_19');assert.equal(first.history.done.length,19);const window=first.window;
 for(let round=0;round<3&&!f.scan().complete;round++){await f.restart();await f.sync();assert.deepEqual(f.scan().window,window);}
 assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,80);assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM source_heads WHERE source_id=?').get(f.source().id)!.n,80);for(const root of f.transport.state.messages)assert.equal(f.node.sources.history(f.source().id,root.message_id).length,1);
});

for(const failed of [false,true])test(`Feishu owner mode ABA rejects a late ${failed?'failed':'successful'} page without old archive, checkpoint or coverage`,async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);let armed=true;
 f.transport.beforePage=async()=>{if(armed){armed=false;enter();await gate;if(failed)throw Object.assign(Error('generated late failure'),{code:'lark_command_failed',statusCode:503});}};
 let running:Promise<unknown>|undefined;
 try{running=f.sync(409);await entered;const checkpoint=f.scan(),source=f.source();for(const initialSync of ['new_only','all']){const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(response.statusCode,200,response.body);}release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.getItem(source.id,'om_generated_0'),undefined);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,2);}
 finally{release();await running?.catch(()=>{});}
});

test('Feishu actual host conditional CAS rejects owner range changes after the plugin precheck',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];const source=f.source();
 const probe=createInstanceState(f.node.store,{identity:{packageId:'generated-probe',installationId:'generated',instanceId:'generated'}} as never),prototype=Object.getPrototypeOf(probe),cas=prototype.compareAndSet;
 let armed=true,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 t.mock.method(prototype,'compareAndSet',async function(key:string,revision:number|null,value:any,condition:any){if(armed&&key==='feishu-session.scan.0'&&value.processed===1){armed=false;assert.deepEqual(condition,{sourceId:source.id,syncScopeVersion:source.syncScopeVersion??0});enter();await gate;}return cas.call(this,key,revision,value,condition);});
 let running:Promise<unknown>|undefined;
 try{running=f.sync(409);await entered;const checkpoint=f.scan();assert.ok(f.node.sources.getItem(source.id,'om_generated_0'),'already committed evidence is preserved');for(const initialSync of ['new_only','all']){const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(changed.statusCode,200,changed.body);}release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.history(source.id,'om_generated_0').length,1);}
 finally{release();await running?.catch(()=>{});}
});

for(const phase of ['chat','thread'])for(const shape of ['omitted','null','empty'])test(`Feishu ${phase} accepts a legal ${shape} terminal page token`,async t=>{
 const f=await fixture(t),root=message(0,{...(phase==='thread'?{thread_id:'omt_generated_terminal'}:{})});f.transport.state.messages=[root];if(phase==='thread')f.transport.threads.set('omt_generated_terminal',[root,message(1,{thread_id:'omt_generated_terminal',root_id:root.message_id,parent_id:root.message_id})]);
 f.transport.pageResult=(command,body)=>{if((phase==='chat'?command.kind==='im-messages':command.kind==='im-thread-messages')&&body.has_more===false){if(shape==='omitted')delete body.page_token;else body.page_token=shape==='null'?null:'';}return body;};
 await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,phase==='thread'?2:1);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'complete');
});

for(const phase of ['chat','thread'])test(`Feishu ${phase} completes an explicit false terminal page with items [] through the fixed CLI map envelope`,async t=>{
 const f=await fixture(t);
 if(phase==='thread'){const root=message(0,{thread_id:'omt_generated_empty'});f.transport.state.messages=[root];f.transport.threads.set('omt_generated_empty',[]);}
 let empty=false;f.transport.pageResult=(command,body)=>{if(phase==='chat'?command.kind==='im-messages':command.kind==='im-thread-messages'){assert.deepEqual(body,{items:[],has_more:false});empty=true;}return body;};
 await f.sync();assert.equal(empty,true);assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,phase==='thread'?1:0);assert.equal(f.scan().completeThrough,f.scan().window.to);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'complete');
});

for(const failure of ['missing_items','missing_more','missing_token','bad_token','conflict','repeat','cycle'])test(`Feishu ${failure} stays partial with a bounded recovery position`,async t=>{
 const f=await fixture(t);f.transport.state.messages=Array.from({length:101},(_,i)=>message(i));let broken=true;
 f.transport.pageResult=(command,body)=>{
  if(!broken)return body;
  if(failure==='missing_items')delete body.items;else if(failure==='missing_more')delete body.has_more;else if(failure==='missing_token')delete body.page_token;else if(failure==='bad_token')body.page_token=0;else if(failure==='conflict'){body.has_more=false;body.page_token='offset-50';}else if(failure==='repeat'){body.has_more=true;body.page_token='offset-0';}else {body.has_more=true;body.page_token=command.pageToken==='offset-50'?'offset-0':'offset-50';}
  return body;
 };
 await f.sync(502);const brokenScan=f.scan();assert.equal(brokenScan.complete,false);assert.equal(brokenScan.completeThrough,undefined);assert.equal(brokenScan.failed,1);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'partial');
 broken=false;await f.restart();await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM source_heads WHERE source_id=?').get(f.source().id)!.n,101);assert.equal(f.node.sources.history(f.source().id,'om_generated_0').length,1);
});

test('Feishu unsupported bodies retain raw evidence and reach Material as partial without bounded metadata overflow',async t=>{
 const f=await fixture(t),raw=JSON.stringify({image_key:'generated_image','data':'x'.repeat(210000),caption:'Generated raw media tail'});f.transport.state.messages=[message(0,{msg_type:'image',body:{content:raw}})];
 await f.sync();const id=f.source().id,item=f.node.sources.getItem(id,'om_generated_0')!;assert.equal(item.text,raw);assert.deepEqual(item.document?.bodyCoverage,{state:'partial',reason:'unsupported_content'});assert.ok(JSON.stringify(item.document?.originalMetadata).length<32000);assert.equal(f.scan().complete,true);assert.equal(f.scan().completeThrough,undefined);assert.deepEqual(f.node.sources.getSource(id).status?.coverage?.limitations,['content_partial']);const material=await materialBody(f,item.externalId);assert.equal(material.record.coverage.state,'partial');assert.equal(material.model.material.coverage.reason,'source_body_unsupported_content');
});

test('Feishu missing original timestamps fail uncovered instead of manufacturing an authored time',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];let broken=true;f.transport.pageResult=(_command,body)=>{if(broken)(body.items as any[])[0]={...message(0),create_time:undefined};return body;};
 await f.sync(502);assert.equal(f.node.sources.getItem(f.source().id,'om_generated_0'),undefined);assert.equal(f.scan().processed,0);assert.equal(f.scan().complete,false);assert.equal(f.scan().failed,1);
 broken=false;await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.node.sources.getItem(f.source().id,'om_generated_0')?.document?.recordedAt,new Date(Number(at())).toISOString());
});

for(const change of ['account','permission'])test(`Feishu observed ${change} withdrawal during a page fences results even after restoration`,async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];const source=f.source(),originalScopes=[...f.transport.state.scopes];let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);let armed=true;
 f.transport.beforePage=async()=>{if(armed){armed=false;enter();await gate;}};let running:Promise<unknown>|undefined;
 try{
  running=f.sync(409);await entered;const checkpoint=f.scan();
  if(change==='account')f.transport.state.account='ou_generated_B';else f.transport.state.scopes=originalScopes.filter(scope=>scope!=='im:message.group_msg:get_as_user');
  await f.binding.status();const withdrawn=f.node.sources.getSource(source.id);assert.equal(withdrawn.enabled,false);assert.equal(withdrawn.syncScopeVersion,(source.syncScopeVersion??0)+1);assert.equal(withdrawn.syncPolicyVersion,source.syncPolicyVersion);
  f.transport.state.account='ou_generated_A';f.transport.state.scopes=originalScopes;await f.binding.status();const enable=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{enabled:true}});assert.equal(enable.statusCode,200,enable.body);
  release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getItem(source.id,'om_generated_0'),undefined);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);
  const observed=f.transport.calls.filter(({command})=>command.kind==='status'||isPage(command));assert.ok(observed.some(call=>isPage(call.command)&&call.account==='ou_generated_A'));assert.ok(observed.some(call=>call.command.kind==='status'&&(change==='account'?call.account==='ou_generated_B':!call.scopes.includes('im:message.group_msg:get_as_user'))));
  await f.sync();assert.equal(f.scan().complete,true);assert.ok(f.node.sources.getItem(source.id,'om_generated_0'));
 }finally{release();await running?.catch(()=>{});}
});

test('Feishu queued SourceStore intake rechecks the same observed binding lease at actual commit',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];await f.sync();const source=f.source(),prior=f.node.sources.getItem(source.id,'om_generated_0')!,version=source.syncScopeVersion??0;
 const {captureId,sourceId,receivedAt,current,...entry}=prior;let enter!:()=>void,release!:()=>void,queued!:()=>void,hold=true;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>queued=resolve),prepare=f.node.store.prepare.bind(f.node.store),upsert=f.node.sources.upsert.bind(f.node.sources);
 t.mock.method(f.node.store,'prepare',async(raw:unknown)=>{if(hold){hold=false;enter();await gate;}return prepare(raw);});
 const blocker=upsert(source.id,{...entry,revision:'generated-blocking-write'},()=>{f.node.sources.assertSyncScope(source.id,version);}).then(()=>{throw Error('The withdrawn queued write must fail');},error=>assert.equal(error.statusCode,409));
 let running:Promise<unknown>|undefined;
 try{
  await entered;f.transport.state.messages=[message(0,{body:{content:JSON.stringify({text:'Generated forbidden queued edit'})}})];t.mock.method(f.node.sources,'upsert',(...args:Parameters<typeof upsert>)=>{queued();return upsert(...args);});running=f.sync(409);await waiting;const checkpoint=f.scan();
  f.transport.state.account='ou_generated_B';await f.binding.status();f.transport.state.account='ou_generated_A';await f.binding.status();const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{enabled:true}});assert.equal(changed.statusCode,200,changed.body);
  release();await blocker;await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.history(source.id,entry.externalId).length,1);assert.equal(f.node.sources.getItem(source.id,entry.externalId)!.captureId,prior.captureId);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);
 }finally{release();await blocker;await running?.catch(()=>{});}
});

test('Feishu failed deselection restores read observation and retains its approved new-only range through reauthorization',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];await f.sync();const source=f.source(),id=source.id;
 const patched=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(patched.statusCode,200,patched.body);await f.sync();const checkpoint=f.scan(),policy=f.node.sources.getSource(id).syncPolicyVersion;
 f.node.store.db.exec(`CREATE TRIGGER generated_removed_pause_failure BEFORE UPDATE ON source_connections WHEN new.id='${id}' AND json_extract(new.json,'$.enabled')=0 BEGIN SELECT RAISE(ABORT,'generated removed source pause failure');END;`);
 await f.request('/api/connectors/feishu-session/select',{selected:[]},502);
 const failed=f.node.sources.getSource(id),status=await f.request('/api/connectors/feishu-session');assert.equal(failed.enabled,true);assert.equal(failed.initialSync,'new_only');assert.equal(status.selected.length,1);assert.equal(status.selected[0].sourceId,id);assert.equal(status.archiveAuthorized,true);assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.history(id,'om_generated_0').length,1);
 f.node.store.db.exec('DROP TRIGGER generated_removed_pause_failure');
 // Observe the existing shared binding directly, without a plugin check/sync
 // that could independently reinstall its watches and hide the failure path.
 const scopes=[...f.transport.state.scopes];f.transport.state.scopes=scopes.filter(scope=>scope!=='im:message:readonly');await f.binding.status();
 const withdrawn=f.node.sources.getSource(id);assert.equal(withdrawn.enabled,false,'the retained durable selection still observes grant withdrawal after a failed pause');assert.equal(withdrawn.syncScopeVersion,(failed.syncScopeVersion??0)+1);assert.equal(withdrawn.syncPolicyVersion,policy);assert.equal(withdrawn.status?.coverage,undefined);assert.equal(f.scan().baselineAt,checkpoint.baselineAt);assert.equal(f.scan().range,checkpoint.range);
 await f.sync(403);assert.equal(f.node.sources.history(id,'om_generated_0').length,1);
 f.transport.state.scopes=scopes;await f.binding.status();assert.equal(f.node.sources.getSource(id).enabled,false,'grant observation alone does not enable the paused source');await f.authorize();await f.sync();
 const restored=f.node.sources.getSource(id);assert.equal(restored.enabled,true);assert.equal(restored.initialSync,'new_only');assert.equal(restored.syncPolicyVersion,policy);assert.equal(f.scan().baselineAt,checkpoint.baselineAt);assert.equal(f.scan().range,checkpoint.range);assert.equal(f.scan().complete,true);assert.equal(f.node.sources.history(id,'om_generated_0').length,1);
});

test('Feishu confirmed read withdrawal fences already-admitted real CAS independently of owner policy',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];const source=f.source(),originalScopes=[...f.transport.state.scopes];
 const probe=createInstanceState(f.node.store,{identity:{packageId:'generated-probe',installationId:'generated',instanceId:'generated'}} as never),prototype=Object.getPrototypeOf(probe),cas=prototype.compareAndSet;
 let armed=true,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 t.mock.method(prototype,'compareAndSet',async function(key:string,revision:number|null,value:any,condition:any){if(armed&&key==='feishu-session.scan.0'&&value.processed===1){armed=false;assert.deepEqual(condition,{sourceId:source.id,syncScopeVersion:source.syncScopeVersion??0});enter();await gate;}return cas.call(this,key,revision,value,condition);});
 let running:Promise<unknown>|undefined;
 try{running=f.sync(409);await entered;const checkpoint=f.scan();assert.ok(f.node.sources.getItem(source.id,'om_generated_0'));f.transport.state.scopes=originalScopes.filter(scope=>scope!=='im:message.group_msg:get_as_user');await f.binding.status();assert.equal(f.node.sources.getSource(source.id).enabled,false);f.transport.state.scopes=originalScopes;await f.binding.status();const enable=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{enabled:true}});assert.equal(enable.statusCode,200,enable.body);release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,0);await f.sync();assert.equal(f.scan().processed,1);assert.equal(f.node.sources.history(source.id,'om_generated_0').length,1);}
 finally{release();await running?.catch(()=>{});}
});

test('Feishu reauthorization and restart preserve approved unread new-only messages while mode ABA creates a fresh baseline',async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});const f=await fixture(t),source=f.source();
 const patch=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(patch.statusCode,200,patch.body);await f.sync();const baseline=f.scan().baselineAt,range=f.scan().range;
 t.mock.timers.tick(2000);f.transport.state.messages=Array.from({length:1105},(_,i)=>message(i,{create_time:String(clock+1000)}));await f.sync();assert.equal(f.scan().processed,1000);assert.equal(f.scan().complete,false);const policy=f.node.sources.getSource(source.id).syncPolicyVersion;
 const scopes=[...f.transport.state.scopes];f.transport.state.scopes=scopes.filter(scope=>scope!=='im:message.group_msg:get_as_user');await f.binding.status();assert.equal(f.node.sources.getSource(source.id).enabled,false);await f.restart();t.mock.timers.tick(100000);await f.authorize();await f.sync();assert.equal(f.scan().baselineAt,baseline);assert.equal(f.scan().range,range);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,policy);assert.equal(f.scan().processed,1000);await f.restart();await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,1105);assert.ok(f.node.sources.getItem(source.id,'om_generated_1104'),'approved but unread messages must survive authorization-only resets');
 for(const initialSync of ['all','new_only']){const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(changed.statusCode,200,changed.body);}
 t.mock.timers.tick(1000);f.transport.state.messages=[message(2000,{create_time:String(clock+5000)})];await f.sync();assert.notEqual(f.scan().range,range);assert.notEqual(f.scan().baselineAt,baseline);assert.equal(f.node.sources.getItem(source.id,'om_generated_2000'),undefined,'a new owner policy must not inherit an older new-only baseline');
});

test('Feishu unrelated scopes and temporary status failures keep selection and the persistent new-only baseline',async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});const f=await fixture(t),source=f.source();let result=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(result.statusCode,200,result.body);await f.sync();const baseline=f.scan().baselineAt,scope=f.node.sources.getSource(source.id).syncScopeVersion;
 f.transport.state.scopes.push('calendar:calendar:readonly');await f.binding.status();assert.equal(f.node.sources.getSource(source.id).enabled,true);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,scope);
 f.transport.state.failStatus=true;const failed=await f.request('/api/connectors/feishu-session/check',{});assert.equal(failed.connected,false);assert.equal(failed.selected.length,1);assert.equal(f.node.sources.getSource(source.id).enabled,true);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,scope);assert.equal(f.scan().baselineAt,baseline);
 f.transport.state.failStatus=false;t.mock.timers.tick(1000);await f.restart();await f.sync();assert.equal(f.scan().baselineAt,baseline);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,1);
 f.transport.statusResult=()=>({appId:'cli_generated_sync',identities:{user:{available:true,openId:f.transport.state.account}}});assert.equal((await f.binding.status()).error,'lark_status_invalid');assert.equal(f.node.sources.getSource(source.id).enabled,true);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,scope);assert.equal(f.scan().baselineAt,baseline);f.transport.statusResult=undefined;
 result=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{syncPolicyVersion:500}});assert.equal(result.statusCode,400,result.body);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,1,'owner HTTP input cannot forge the host policy identity');
 result=await f.node.app.inject({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:'generated-forged-policy',name:'Generated denied source',kind:source.kind,deviceId:source.deviceId,platform:source.platform,syncPolicyVersion:500}});assert.equal(result.statusCode,403,result.body);assert.ok(!f.node.sources.listSources().some(value=>value.id==='generated-forged-policy'));
});

test('Feishu same-chat account changes retain distinct original source identities and histories',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0,{body:{content:JSON.stringify({text:'Generated A original'})}})];await f.sync();const old=f.source();f.transport.state.account='ou_generated_B';await f.request('/api/connectors/feishu-session/check',{});assert.equal(f.node.sources.getSource(old.id).enabled,false);const checked=await f.request('/api/connectors/feishu-session');assert.equal(checked.archiveAuthorized,false);assert.equal(checked.selected.length,0);await f.authorize();await f.select();f.transport.state.messages=[message(0,{body:{content:JSON.stringify({text:'Generated B original'})}})];await f.sync();const current=f.source();assert.notEqual(current.id,old.id);assert.match(f.node.sources.getItem(old.id,'om_generated_0')!.text,/A original/);assert.match(f.node.sources.getItem(current.id,'om_generated_0')!.text,/B original/);assert.equal(f.node.sources.history(old.id,'om_generated_0').length,1);assert.equal(f.node.sources.history(current.id,'om_generated_0').length,1);
});

test('Feishu short provider pages still consume all twenty requests before durable continuation',async t=>{
 const f=await fixture(t);f.transport.state.providerPageSize=1;f.transport.state.messages=Array.from({length:25},(_,i)=>message(i,{create_time:at()}));await f.sync();const first=f.scan();assert.equal(first.processed,20);assert.equal(first.complete,false);assert.equal(first.history.token,'offset-20');assert.equal(f.transport.calls.filter(({command})=>isPage(command)).length,20);assert.ok(f.transport.calls.filter(({command})=>isPage(command)).every(({command})=>isPage(command)&&command.pageSize===50));await f.restart();await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,25);assert.deepEqual(f.scan().window,first.window);
});

test('Feishu thread client filtering stops at the fixed millisecond upper bound without sending unsupported time parameters',async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});const f=await fixture(t),root=message(0,{thread_id:'omt_generated_upper'});f.transport.state.messages=[root];f.transport.threads.set('omt_generated_upper',[root,message(1,{create_time:String(clock-1),thread_id:'omt_generated_upper',root_id:root.message_id,parent_id:root.message_id}),...Array.from({length:100},(_,i)=>message(i+2,{create_time:String(clock+1+i),thread_id:'omt_generated_upper',root_id:root.message_id,parent_id:root.message_id}))]);
 await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,2);assert.equal(f.node.sources.getItem(f.source().id,'om_generated_2'),undefined);assert.ok(f.node.sources.getItem(f.source().id,'om_generated_1'));assert.equal(f.transport.calls.filter(({command})=>command.kind==='im-thread-messages').length,1,'ascending future replies are outside this window, even if more pages exist');
});

test('Feishu plugin stop fences an in-flight page and restart continues the unchanged checkpoint',async t=>{
 const f=await fixture(t);f.transport.state.messages=[message(0)];let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);let armed=true;
 f.transport.beforePage=async()=>{if(armed){armed=false;enter();await gate;}};
 let running:Promise<unknown>|undefined;
 try{running=f.sync(409);await entered;const source=f.source(),checkpoint=f.scan();await f.request('/api/plugin-instances/'+f.instance.id+'/disable',{expectedRevision:f.node.pluginCenter.instanceView(f.instance.id).revision,operationId:randomUUID()});await f.wait(()=>!f.node.pluginCenter.instanceView(f.instance.id).desired);release();await running;await f.wait(()=>f.node.pluginCenter.instanceView(f.instance.id).observed==='disabled');assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getItem(source.id,'om_generated_0'),undefined);
  await f.request('/api/plugin-instances/'+f.instance.id+'/enable',{expectedRevision:f.node.pluginCenter.instanceView(f.instance.id).revision,operationId:randomUUID()});await f.wait(()=>f.node.pluginCenter.instanceView(f.instance.id).observed==='ready');await f.sync();assert.deepEqual(f.scan().window,checkpoint.window);assert.equal(f.scan().complete,true);assert.ok(f.node.sources.getItem(source.id,'om_generated_0'));
 }finally{release();await running?.catch(()=>{});}
});

for(const scope of ['im:message.group_msg:get_as_user','im:message:readonly'])for(const mode of ['all','new_only'])test(`Feishu cold restore withdraws ${scope} before ${mode==='all'?'check then sync':'the first direct sync'} without changing the ${mode} range`,async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});const f=await fixture(t),source=f.source();
 if(mode==='new_only'){
  const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync:mode}});assert.equal(changed.statusCode,200,changed.body);await f.sync();t.mock.timers.tick(2000);
 }
 const original=message(0,{...(mode==='new_only'?{create_time:String(clock+1000)}:{})});f.transport.state.messages=[original];await f.sync();
 const before=f.node.sources.getSource(source.id),checkpoint=f.scan(),selection=(await f.request('/api/connectors/feishu-session')).selected;
 assert.equal(before.status?.coverage?.state,'complete');assert.equal(before.status?.coverage?.processed,1);
 await f.restart();f.transport.state.scopes=f.transport.state.scopes.filter(value=>value!==scope);
 f.transport.state.messages=[{...original,body:{content:JSON.stringify({text:'Generated forbidden cold-restore edit'})}}];
 const pageCalls=f.transport.calls.filter(({command})=>isPage(command)).length;
 if(mode==='all')await f.request('/api/connectors/feishu-session/check',{});
 await f.sync(403);
 const withdrawn=(await f.request('/api/sources')).items.find((value:any)=>value.id===source.id);
 assert.equal(withdrawn.enabled,false,'the first confirmed observation withdraws the restored source');assert.equal(withdrawn.syncScopeVersion,(before.syncScopeVersion??0)+1);assert.equal(withdrawn.syncPolicyVersion,before.syncPolicyVersion);assert.equal(withdrawn.status?.coverage,undefined);assert.equal(withdrawn.status?.state,'permission_required');assert.deepEqual(f.scan(),checkpoint);assert.equal(f.transport.calls.filter(({command})=>isPage(command)).length,pageCalls,'a denied first sync makes no message request');assert.equal(f.node.sources.getItem(source.id,original.message_id)?.text,'Generated historical message 0');assert.equal(f.node.sources.history(source.id,original.message_id).length,1);
 for(let check=0;check<2;check++){const checked=await f.request('/api/connectors/feishu-session/check',{});assert.deepEqual(checked.selected,selection);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,withdrawn.syncScopeVersion);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,before.syncPolicyVersion);assert.deepEqual(f.scan(),checkpoint);}
 await f.restart();await f.request('/api/connectors/feishu-session/check',{});assert.equal(f.node.sources.getSource(source.id).enabled,false);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,withdrawn.syncScopeVersion,'a repeated confirmed withdrawal after another restart does not fence the same stopped range again');assert.equal(f.scan().baselineAt,checkpoint.baselineAt);assert.deepEqual(f.scan(),checkpoint);
});

test('Feishu cold restore keeps an authorized source paused, then observes real withdrawal without losing its new-only baseline',async t=>{
 const f=await fixture(t),source=f.source();let changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(changed.statusCode,200,changed.body);await f.sync();const checkpoint=f.scan();
 changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{enabled:false}});assert.equal(changed.statusCode,200,changed.body);const paused=f.node.sources.getSource(source.id),pages=f.transport.calls.filter(({command})=>isPage(command)).length;
 await f.restart();assert.deepEqual(f.node.sources.getSource(source.id),paused,'restoring observation must not register or enable the saved source');await f.request('/api/connectors/feishu-session/check',{});assert.deepEqual(f.node.sources.getSource(source.id),paused);await f.sync();const after=f.node.sources.getSource(source.id);assert.equal(after.enabled,false);assert.equal(after.syncScopeVersion,paused.syncScopeVersion);assert.equal(after.syncPolicyVersion,paused.syncPolicyVersion);assert.deepEqual(after.status?.coverage,paused.status?.coverage);assert.deepEqual(f.scan(),checkpoint);assert.equal(f.transport.calls.filter(({command})=>isPage(command)).length,pages);
 f.transport.state.scopes=f.transport.state.scopes.filter(value=>value!=='im:message.group_msg:get_as_user');await f.request('/api/connectors/feishu-session/check',{});const withdrawn=f.node.sources.getSource(source.id);assert.equal(withdrawn.enabled,false);assert.equal(withdrawn.syncScopeVersion,(paused.syncScopeVersion??0)+1);assert.equal(withdrawn.syncPolicyVersion,paused.syncPolicyVersion);assert.equal(withdrawn.status?.coverage,undefined);assert.deepEqual(f.scan(),checkpoint);
});

test('Feishu first cold status failure keeps the restored selection, enabled source and new-only baseline',async t=>{
 const f=await fixture(t),source=f.source();const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(changed.statusCode,200,changed.body);await f.sync();const checkpoint=f.scan(),before=f.node.sources.getSource(source.id),selection=(await f.request('/api/connectors/feishu-session')).selected;
 await f.restart();f.transport.state.failStatus=true;const checked=await f.request('/api/connectors/feishu-session/check',{});assert.equal(checked.connected,false);assert.deepEqual(checked.selected,selection);assert.deepEqual(f.node.sources.getSource(source.id),before);assert.deepEqual(f.scan(),checkpoint);
 f.transport.state.failStatus=false;await f.sync();assert.equal(f.scan().baselineAt,checkpoint.baselineAt);assert.equal(f.node.sources.getSource(source.id).enabled,true);assert.equal(f.node.sources.getSource(source.id).syncScopeVersion,before.syncScopeVersion);assert.equal(f.node.sources.getSource(source.id).syncPolicyVersion,before.syncPolicyVersion);
});
