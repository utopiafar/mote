import {testScope} from './fixtures/plugin-scope.js';
import {test,after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CODING_DIALOGUE_SCHEMA_VERSION,sourceItemSchema,type SourceItem} from '@mote/shared';
import {scanCodingAgent,type CodingProvider,type CodingCheckpoint} from '../../desktop/src/coding-agents.js';
import {SourceSync} from '../../desktop/src/source-sync.js';
import {sourceDefinition} from '../../desktop/src/source-manager.js';
import {sourceWork} from '../../desktop/src/background.js';
import {DEFAULT_SOURCE_OPTIONS,type SourceRequest} from '../../desktop/src/source-types.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {MaterialStore} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {IngressService} from '../src/ingress.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

// Protocol-shaped generated sessions only: no provider, model, device or owner data.
const at='2001-01-01T10:00:00.000Z',ms=Date.parse(at),line=(row:unknown)=>JSON.stringify(row)+'\n';
const requestText='Generated owner request.',progress='Visible stage one.',final='Generated final answer.';
const denied=['PRIVATE_REASONING','PRIVATE_TOOL_BODY','PRIVATE_HOST','PRIVATE_SUBAGENT','PRIVATE_UNKNOWN','PRIVATE_ECHO'];
after(()=>sourceWork.close());

async function nativeSession(root:string,provider:CodingProvider,legacy=false){
 await mkdir(root,{recursive:true});const path=join(root,'main.jsonl');
 if(provider==='codex'){
  const message=(id:string,role:string,text:string,phase?:string)=>({type:'response_item',timestamp:at,payload:{id,type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
  const reply=message('final','assistant',final,'final_answer');
  await writeFile(path,[
   {type:'session_meta',payload:{id:'generated-session',cwd:'/generated/project'}},
   {type:'event_msg',payload:{type:'task_started',turn_id:'generated-turn'}},message('user','user',requestText),
   {type:'event_msg',payload:{type:'user_message',message:'PRIVATE_ECHO'}},
   {type:'response_item',payload:{type:'reasoning',summary:[{text:'PRIVATE_REASONING'}]}},
   message('host','user','<environment_context>PRIVATE_HOST</environment_context>'),
   message('unknown','assistant','PRIVATE_UNKNOWN'),message('unknown-phase','assistant','PRIVATE_UNKNOWN','final'),message('analysis','assistant','PRIVATE_REASONING','analysis'),
   message('commentary','assistant',progress,'commentary'),
   {type:'response_item',timestamp:at,payload:{type:'function_call_output',output:'PRIVATE_TOOL_BODY'}},
   message('partial','assistant','Visible partial answer.','partial_answer'),reply,reply,
   {type:'event_msg',timestamp:at,payload:{type:'task_complete',turn_id:'generated-turn',last_agent_message:final}},
  ].map(line).join(''));
  await writeFile(join(root,'child.jsonl'),line({type:'session_meta',payload:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'generated-session'}}}}})+line(message('child','assistant','PRIVATE_SUBAGENT','commentary')));
  return {path:root,expected:[requestText,progress,'Visible partial answer.',final],finish:async()=>{}};
 }
 if(provider==='claude'){
  const message=(uuid:string,type:string,content:unknown,extra={})=>({uuid,type,sessionId:'generated-session',timestamp:at,message:{content,...extra}});
  const reply=message('final','assistant',[{type:'text',text:final}],{stop_reason:'end_turn'});
  await writeFile(path,[message('user','user',requestText),
   {...message('host','assistant',[{type:'text',text:'PRIVATE_HOST'}]),isMeta:true},
   {type:'progress',message:{content:[{type:'text',text:'PRIVATE_UNKNOWN'}]}},
   message('commentary','assistant',[{type:'text',text:progress},{type:'input_text',text:'PRIVATE_UNKNOWN'},{type:'output_text',text:'PRIVATE_UNKNOWN'}],{stop_reason:null}),
   message('tool-step','assistant',[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'redacted_thinking',data:'PRIVATE_REASONING'},
    {type:'text',text:'Visible tool explanation.'},{type:'tool_use',id:'tool',name:'generated',input:{body:'PRIVATE_TOOL_BODY'}}],{stop_reason:'tool_use'}),
   message('result','user',[{type:'tool_result',tool_use_id:'tool',content:'PRIVATE_TOOL_BODY'}]),reply,reply,
  ].map(line).join(''));
  await mkdir(join(root,'subagents'));await writeFile(join(root,'subagents','child.jsonl'),line({...reply,agentId:'child',isSidechain:true,message:{content:[{type:'text',text:'PRIVATE_SUBAGENT'}]}}));
  return {path:root,expected:[requestText,progress,'Visible tool explanation.',final],finish:async()=>{}};
 }
 if(provider==='kimi'){
  const main=join(root,'workspace','generated-session',...(legacy?[]:['agents','main']));await mkdir(main,{recursive:true});const wire=join(main,'wire.jsonl');
  if(legacy){
   const row=(type:string,payload:unknown={})=>line({timestamp:ms,message:{type,payload}});
   await writeFile(wire,row('TurnBegin',{user_input:requestText})+row('StepBegin')+row('CompactionBegin')+
    row('ContentPart',{type:'text',text:'PRIVATE_HOST'})+row('CompactionEnd')+row('ContentPart',{type:'think',think:'PRIVATE_REASONING'})+
    row('ContentPart',{type:'text',text:'Visible stage '})+row('ContentPart',{type:'text',text:'one.'})+
    row('ToolCall',{id:'tool',function:{name:'generated',arguments:'PRIVATE_TOOL_BODY'}})+row('ToolResult',{tool_call_id:'tool',return_value:'PRIVATE_TOOL_BODY'})+
    row('StepBegin')+row('ContentPart',{type:'text',text:'Generated final '}));
   await mkdir(join(root,'workspace','generated-session','subagents','child'),{recursive:true});
   await writeFile(join(root,'workspace','generated-session','subagents','child','wire.jsonl'),row('TurnBegin',{user_input:'PRIVATE_SUBAGENT'}));
   return {path:root,expected:[requestText,progress,final],finish:()=>appendFile(wire,row('ContentPart',{type:'text',text:'answer.'})+row('TurnEnd')+row('TurnEnd'))};
  }
  const row=(type:string,extra:Record<string,unknown>={})=>line({type,time:ms,agentId:'main',...extra});
  const loop=(type:string,extra:Record<string,unknown>={})=>row('context.append_loop_event',{event:{type,...extra}});
  const first=loop('content.part',{stepUuid:'step-one',uuid:'part-one',part:{type:'text',text:'Visible stage '}});
  await writeFile(wire,row('turn.prompt',{turnId:1,origin:{kind:'user'},input:[{type:'text',text:requestText}]})+
   loop('step.begin',{uuid:'step-one',turnId:'1'})+first+first+
   loop('content.part',{stepUuid:'step-one',uuid:'part-two',part:{type:'text',text:'one.'}})+
   loop('content.part',{stepUuid:'step-one',part:{type:'think',think:'PRIVATE_REASONING'}})+
   row('context.append_message',{message:{role:'assistant',content:[{type:'text',text:'PRIVATE_ECHO'}]}})+
   loop('tool.call',{stepUuid:'step-one',toolCallId:'tool',name:'generated',args:{body:'PRIVATE_TOOL_BODY'}})+
   loop('tool.result',{toolCallId:'tool',result:{output:'PRIVATE_TOOL_BODY'}})+loop('step.end',{uuid:'step-one',finishReason:'tool_use'})+
   loop('step.begin',{uuid:'step-two',turnId:'1'})+
   loop('content.part',{stepUuid:'step-one',part:{type:'text',text:'PRIVATE_UNKNOWN'}})+
   loop('content.part',{stepUuid:'step-two',uuid:'final-one',part:{type:'text',text:'Generated final '}}));
  const child=join(root,'workspace','generated-session','agents','child');await mkdir(child,{recursive:true});
  await writeFile(join(child,'wire.jsonl'),row('turn.prompt',{origin:{kind:'user'},input:[{type:'text',text:'PRIVATE_SUBAGENT'}]}));
  return {path:root,expected:[requestText,progress,final],finish:()=>appendFile(wire,
   loop('content.part',{stepUuid:'step-two',uuid:'final-two',part:{type:'text',text:'answer.'}})+loop('step.end',{uuid:'step-two',finishReason:'end_turn'})+
   row('turn.ended',{turnId:1,reason:'completed'})+row('turn.ended',{turnId:1,reason:'completed'})+
   row('turn.prompt',{turnId:2,origin:{kind:'system_trigger'},input:[{type:'text',text:'PRIVATE_HOST'}]})+
   loop('step.begin',{uuid:'host-step',turnId:'2'})+loop('content.part',{stepUuid:'host-step',part:{type:'text',text:'PRIVATE_HOST'}})+row('turn.ended',{turnId:2,reason:'completed'}))};
 }
 const dbPath=join(root,'opencode.db'),db=new DatabaseSync(dbPath);
 try{
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT NOT NULL,title TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE credential (value TEXT);INSERT INTO credential VALUES ('PRIVATE_HOST');`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('generated-session',null,'/generated/project','Generated',ms,ms);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('child','generated-session','/generated/child','Generated child',ms,ms);
  const insert=db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const add=(id:string,type:string,seq:number,data:unknown,session='generated-session')=>insert.run(id,session,type,seq,ms,ms,JSON.stringify(data));
  add('user','user',1,{text:requestText});add('step','assistant',2,{time:{completed:ms},finish:'tool-calls',content:[
   {type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:progress},{type:'tool',id:'tool',name:'generated',state:{status:'completed',input:{body:'PRIVATE_TOOL_BODY'},content:[{type:'text',text:'PRIVATE_TOOL_BODY'}]}}]});
  add('final','assistant',3,{time:{completed:null},content:[{type:'text',text:'PRIVATE_UNKNOWN'}]});
  add('system','system',4,{text:'PRIVATE_HOST'});add('synthetic','synthetic',5,{text:'PRIVATE_HOST'});add('child','user',1,{text:'PRIVATE_SUBAGENT'},'child');
 }finally{db.close();}
 return {path:dbPath,expected:[requestText,progress,final],finish:async()=>{const writer=new DatabaseSync(dbPath);try{writer.prepare('UPDATE session_message SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({time:{completed:ms+1},finish:'stop',content:[{type:'text',text:final}]}),ms+1,'final');}finally{writer.close();}}};
}

async function fixture(t:TestContext,provider:CodingProvider,legacy=false){
 const directory=await mkdtemp(join(tmpdir(),'mote-visible-coding-'));
 const opened:{store?:Store;runtime?:SourcePipelineRuntime;diagnostics?:ServerDiagnostics;files?:FileStore}={};
 t.after(async()=>{await opened.runtime?.close();await opened.files?.close();await opened.diagnostics?.close();opened.store?.close();await rm(directory,{recursive:true,force:true});});
 const native=await nativeSession(join(directory,'native'),provider,legacy),store=opened.store=new Store(join(directory,'central')),materials=new MaterialStore(store),runtime=opened.runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],testScope(t));await runtime.ready;
 const sources=new SourceStore(store,runtime),source={...DEFAULT_SOURCE_OPTIONS,id:'generated-coding',name:'Generated Coding',kind:'coding-agent',agent:provider,path:native.path,deviceId:'generated-device',platform:'macos' as const,enabled:true};sources.register(sourceDefinition(source));
 const diagnostics=opened.diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
 const state=join(directory,'source.json');let engine=new SourceSync(state);await engine.initialize();let loseAck=true;const received:SourceItem[]=[];
 const ingress=new IngressService(store,sources,opened.files=new FileStore(store,sources));
 const request:SourceRequest=async(route,body)=>{
  if(route==='/api/sources')return sources.register(JSON.parse(JSON.stringify(body)));
  const wire=JSON.parse(JSON.stringify(body)),items=(wire.items??[wire]).map((item:unknown)=>sourceItemSchema.parse(item));received.push(...items);
  const accepted=wire.items?await ingress.sourceBatch(source.id,items):await ingress.sourceItem(source.id,items[0]);
  if(loseAck){loseAck=false;throw Error('Generated ACK loss after archive commit');}
  return accepted;
 };
 async function collect(){
  for(let n=0;n<100;n++){
   const scan=await scanCodingAgent(native.path,provider,source,engine.checkpoint() as CodingCheckpoint|undefined,undefined,{items:3,bytes:4096});assert.equal(scan.skipped,0);
   await engine.stage(scan,false,at);
   if(loseAck&&engine.status().pending){await assert.rejects(engine.flush(sourceDefinition(source),request),/Generated ACK loss/);const pending=JSON.stringify(engine.pendingContent());engine=new SourceSync(state);await engine.initialize();assert.equal(JSON.stringify(engine.pendingContent()),pending);}
   await engine.flush(sourceDefinition(source),request);await runtime.tick();
   // A running OpenCode row is deliberately pending until the next fixture phase.
   if(scan.complete||!scan.items.length)return;
  }
  assert.fail('Generated collector did not drain');
 }
 const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime),consumer=reader.agent({diagnostics});
 return {native,store,materials,runtime,sources,received,collect,consumer,async restartLocal(){engine=new SourceSync(state);await engine.initialize();}};
}

for(const [provider,legacy] of [['codex',false],['claude',false],['kimi',false],['kimi',true],['opencode',false]] as const){
 test(`${provider}${legacy?' legacy wire':''}: real collector, durable outbox and Material consumer retain visible explanations only`,async t=>{
  const f=await fixture(t,provider,legacy);await f.collect();
  if(provider==='kimi'||provider==='opencode')for(const material of f.materials.list().items)assert.ok(!f.materials.read(material.ref,{length:12000}).text.includes(final));
  await f.native.finish();await f.collect();await f.collect();
  const records=f.materials.list({kind:'mote.coding-session'}).items;assert.equal(records.length,1);const material=records[0];
  assert.equal(material.schemaVersion,CODING_DIALOGUE_SCHEMA_VERSION);assert.equal(material.origin.provider,provider);
  const page=await f.consumer.materialRead!({ref:material.ref,length:12000}),text=page.text;let previous=-1;
  for(const visible of f.native.expected){const index=text.indexOf(visible);assert.ok(index>previous,`${visible} follows the preceding native event`);assert.equal(text.split(visible).length-1,1,`${visible} appears once`);previous=index;}
  assert.match(text,/Attribution: human/);assert.match(text,/Attribution: agent · Channel: commentary/);assert.match(text,/Attribution: agent · Channel: final/);
  const evidence=await f.consumer.evidence({ids:f.materials.evidenceIds(material.ref)});assert.ok(evidence.length>0);
  const attributed=evidence.flatMap(record=>(record.provenance?.document?.codingMessages??[]).map(span=>({speaker:span.speaker,text:record.ocrText.slice(span.start,span.end)})));
  assert.ok(attributed.some(message=>message.speaker==='user'&&message.text===requestText));
  assert.ok(attributed.some(message=>message.speaker==='agent'&&message.text===final));
  for(const secret of denied){assert.ok(!text.includes(secret),secret);assert.ok(evidence.every(record=>!record.ocrText.includes(secret)),secret);assert.equal(f.materials.list({query:secret}).items.length,0,secret);}
  for(const item of f.received)assert.ok(item.document?.coding?.order,'native ordering survives serialization');
  const revision=material.revision;await f.sources.upsertBatch('generated-coding',[...new Map(f.received.map(item=>[JSON.stringify([item.externalId,item.revision]),item])).values()]);await f.runtime.tick();assert.equal(f.materials.get(material.id)!.revision,revision,'lost ACK and duplicate receipts cannot duplicate visible messages');
 });
}

test('Codex creation receipts connect an existing child to its parent turn when that journal arrives',async t=>{
 const f=await fixture(t,'codex'),root=f.native.path,child='c1558a13-087e-4530-825a-da3ffeb16451',parent='bc558a13-087e-4530-825a-da3ffeb16451',turn='d1558a13-087e-4530-825a-da3ffeb16451';
 const meta=(id:string)=>({type:'session_meta',payload:{id,cwd:'/generated/same-repository',thread_source:id===child?'agent_created_thread':'user'}});
 const start=(id:string)=>({type:'event_msg',payload:{type:'task_started',turn_id:id}});
 const message=(role:'user'|'assistant',text:string)=>({type:'response_item',timestamp:at,payload:{type:'message',role,phase:'final_answer',content:[{type:'text',text}]}});
 const receipt={type:'item_completed',thread_id:parent,turn_id:turn,item:{type:'McpToolCall',server:'codex_app',pluginId:'codex-app-tools@openai-bundled',
  tool:'create_thread',status:'completed',arguments:{prompt:'PRIVATE_LAUNCH_INSTRUCTIONS'},result:{isError:false,content:[{type:'text',text:JSON.stringify({threadId:child,hostId:'generated-host'})}]}}};
 await writeFile(join(root,'delegated.jsonl'),[meta(child),message('assistant','Generated delegated result.')].map(line).join(''));
 await writeFile(join(root,'unrelated.jsonl'),[meta('other'),message('user','Another request in the same repository.'),message('assistant',JSON.stringify(receipt))].map(line).join(''));
 await f.collect();await f.collect();
 const lookup=()=>f.materials.list({kind:'mote.coding-session'}).items.find(material=>material.origin.sessionId===child)!;
 assert.ok(lookup());const original=lookup().ref;assert.equal(f.materials.isCodingChild(lookup()),true);assert.equal(f.materials.codingContext(lookup()),undefined);
 await writeFile(join(root,'parent.jsonl'),[meta(parent),start('generated-other-turn'),message('user','Generated unrelated parent turn.'),
  start(turn),message('user','Generated original request for the delegated work.'),{type:'event_msg',timestamp:at,payload:receipt},
  message('user','Generated later steering.')].map(line).join(''));
 await f.collect();await f.collect();
 const context=f.materials.codingContext(lookup());
 assert.equal(lookup().ref,original);assert.ok(context);
 assert.deepEqual(context.requests.map(request=>request.quote),['Generated original request for the delegated work.']);
 const source=f.materials.get(context.ref)!;
 assert.equal(source.origin.sessionId,parent);
 assert.doesNotMatch(f.materials.read(source.ref,{length:12000}).text,/PRIVATE_LAUNCH_INSTRUCTIONS|create_thread/);
 f.materials.redactUntilRebuilt(source.id);
 assert.equal(f.materials.codingContext(lookup()),undefined);
});

test('Codex attachments use the native fork position and keep only the actual user input',async t=>{
 const f=await fixture(t,'codex'),root=f.native.path,parent=randomUUID(),child=randomUUID();
 const user=(text:string)=>({type:'response_item',timestamp:at,payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const original='Generated request before creating the side conversation.',correction='Generated direct user correction in the side conversation.';
 const parentHead=[{type:'session_meta',payload:{id:parent}},user(original)].map(line).join('');
 await writeFile(join(root,'attached-root.jsonl'),parentHead+line(user('Generated newer request in the same parent.')));
 const meta={type:'session_meta',payload:{id:child,attached_thread:true,forked_from_id:parent,history_base:{thread_id:parent,end_byte_offset:Buffer.byteLength(parentHead)}}};
 const injected=user('PRIVATE_BRANCH_SUMMARY'),message=user(correction);
 await writeFile(join(root,'attached-child.jsonl'),[meta,
  {...injected,payload:{...injected.payload,internal_chat_message_metadata_passthrough:{content_item_kinds:['unknown']}}},
  {type:'event_msg',payload:{type:'task_started',turn_id:randomUUID()}},
  {...message,payload:{...message.payload,content:[...message.payload.content,{type:'input_text',text:'PRIVATE_HARNESS_CONTENT'}],
   internal_chat_message_metadata_passthrough:{content_item_metadata:[{provenance:{type:'user'}},{provenance:{type:'harness'}}]}}},
 ].map(line).join(''));
 await f.collect();await f.collect();
 const attached=f.materials.list({kind:'mote.coding-session'}).items.find(material=>material.origin.sessionId===child)!;
 const context=f.materials.codingContext(attached);
 assert.deepEqual(context?.requests.map(request=>request.quote),[original]);
 const body=f.materials.read(attached.ref,{length:12000}).text;
 assert.match(body,new RegExp(correction));
 assert.doesNotMatch(body,/PRIVATE_BRANCH_SUMMARY|PRIVATE_HARNESS_CONTENT/);
});

test('same-time late native commentary rebuilds in native order and a later private revision keeps that exact projection',async t=>{
 const f=await fixture(t,'codex');await f.collect();const material=f.materials.list().items[0],all=[...new Map(f.received.map(item=>[item.externalId,item])).values()];
 const commentary=all.find(item=>item.text===progress)!;assert.ok(commentary);
 // Use a second generated source to receive the real collector output out of order.
 f.sources.register({id:'late-coding',name:'Generated late Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
 await f.sources.upsertBatch('late-coding',all.filter(item=>item.externalId!==commentary.externalId));await f.runtime.tick();
 const before=f.materials.list().items.find(item=>item.origin.sourceId==='late-coding')!;
 await f.sources.upsert('late-coding',commentary);await f.runtime.tick();const after=f.materials.get(before.id)!;
 assert.notEqual(after.revision,before.revision);assert.equal(f.materials.read(after.ref,{length:12000}).text,f.materials.read(material.ref,{length:12000}).text);
 const raw=all.find(item=>item.document?.coding?.role==='tool_result')!;
 await f.sources.upsert('late-coding',{...raw,revision:'generated-private-revision',text:'PRIVATE_TOOL_BODY updated'});await f.runtime.tick();
 assert.equal(f.materials.get(after.id)!.revision,after.revision,'full rebuild agrees with native append order and block locators');
});

test('mixed missing native order uses one conservative time/receipt order for full builds and appends',async t=>{
 const f=await fixture(t,'codex');await f.collect();
 const all=[...new Map(f.received.map(item=>[item.externalId,item])).values()],user=all.find(item=>item.text===requestText)!,commentary=all.find(item=>item.text===progress)!,reply=all.find(item=>item.text===final)!;
 const withoutOrder=(item:SourceItem):SourceItem=>{const {order:_,...coding}=item.document!.coding!;return {...item,document:{...item.document,coding}};};
 f.sources.register({id:'mixed-coding',name:'Generated mixed Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
 // Native order is user < commentary < reply, while receipt order is reply < user < commentary.
 await f.sources.upsertBatch('mixed-coding',[reply,withoutOrder(user),commentary]);await f.runtime.tick();
 const material=f.materials.list().items.find(item=>item.origin.sourceId==='mixed-coding')!;
 const body=f.materials.read(material.ref,{length:12000}).text;
 assert.ok(body.indexOf(final)<body.indexOf(requestText));assert.ok(body.indexOf(requestText)<body.indexOf(progress));
 assert.ok(material.fidelity.limitations?.includes('native_order_unknown'));
 assert.equal(f.materials.codingBase(material.id)!.lastBlock!.locator?.codingOrder,undefined,'a mixed group cannot claim a native-order append base');
 const later={...commentary,externalId:'generated-later',revision:'generated-later',text:'Later generated explanation.',document:{...commentary.document,coding:{...commentary.document!.coding!,eventId:'generated-later',order:{entry:Number.MAX_SAFE_INTEGER-1,event:0}}}};
 await f.sources.upsert('mixed-coding',later);await f.runtime.tick();
 const current=f.materials.get(material.id)!,text=f.materials.read(current.ref,{length:12000}).text;
 assert.ok(text.indexOf(progress)<text.indexOf(later.text));assert.ok(current.fidelity.limitations?.includes('native_order_unknown'));
 const raw=all.find(item=>item.document?.coding?.role==='tool_result')!;
 await f.sources.upsert('mixed-coding',raw);await f.runtime.tick();
 assert.equal(f.materials.get(material.id)!.revision,current.revision,'a private append cannot change conservative visible order');
 await f.sources.upsert('mixed-coding',{...raw,revision:'generated-mixed-private-revision',text:'PRIVATE_TOOL_BODY replacement'});await f.runtime.tick();
 assert.equal(f.materials.get(material.id)!.revision,current.revision,'a full rebuild must keep the same conservative order and locators');
});


test('Kimi Code closed steps reject late text across durable restarts while a closed final still awaits turn completion',async t=>{
 const f=await fixture(t,'kimi'),wire=join(f.native.path,'workspace','generated-session','agents','main','wire.jsonl');
 const row=(type:string,extra:Record<string,unknown>={})=>line({type,time:ms,agentId:'main',...extra});
 const loop=(type:string,extra:Record<string,unknown>={})=>row('context.append_loop_event',{event:{type,...extra}});
 const text=(step:string,body:string)=>loop('content.part',{uuid:'part-'+body,stepUuid:step,part:{type:'text',text:body}});
 await writeFile(wire,row('turn.prompt',{turnId:1,origin:{kind:'user'},input:[{type:'text',text:requestText}]})+
  loop('step.begin',{uuid:'failed-error',turnId:'1'})+text('failed-error','FAILED_BEFORE_CLOSE')+loop('step.end',{uuid:'failed-error',finishReason:'error'}));
 await f.collect();await f.restartLocal();
 await appendFile(wire,text('failed-error','FAILED_LATE_CLOSED_STEP')+
  loop('tool.call',{stepUuid:'failed-error',toolCallId:'late-tool',name:'generated',args:{body:'PRIVATE_LATE_TOOL'}})+
  loop('step.begin',{uuid:'failed-interrupted',turnId:'1'})+text('failed-interrupted','INTERRUPTED_BEFORE_CLOSE')+
  loop('step.end',{uuid:'failed-interrupted',finishReason:'interrupted'}));
 await f.collect();await f.restartLocal();
 await appendFile(wire,text('failed-interrupted','INTERRUPTED_LATE_CLOSED_STEP')+
  loop('step.begin',{uuid:'successful-tool',turnId:'1'})+text('successful-tool',progress)+
  loop('tool.call',{stepUuid:'successful-tool',toolCallId:'good-tool',name:'generated',args:{body:'PRIVATE_TOOL_BODY'}})+
  loop('step.end',{uuid:'successful-tool',finishReason:'tool_use'}));
 await f.collect();await f.restartLocal();
 await appendFile(wire,text('successful-tool','SUCCESSFUL_TOOL_LATE_CLOSED_STEP')+
  loop('step.begin',{uuid:'successful-final',turnId:'1'})+text('successful-final',final)+
  loop('step.end',{uuid:'successful-final',finishReason:'end_turn'}));
 await f.collect();await f.restartLocal();
 const before=f.materials.list().items[0];assert.ok(!f.materials.read(before.ref,{length:12000}).text.includes(final),'step close alone does not publish the terminal answer');
 await appendFile(wire,text('successful-final','FINAL_LATE_CLOSED_STEP')+
  loop('step.end',{uuid:'successful-final',finishReason:'error'})+row('turn.ended',{turnId:1,reason:'completed'}));await f.collect();
 const material=f.materials.list().items[0],page=await f.consumer.materialRead!({ref:material.ref,length:12000});
 const evidence=await f.consumer.evidence({ids:f.materials.evidenceIds(material.ref)});let previous=-1;
 for(const visible of [requestText,progress,final]){const index=page.text.indexOf(visible);assert.ok(index>previous);assert.equal(page.text.split(visible).length-1,1);previous=index;}
 for(const secret of ['FAILED_BEFORE_CLOSE','FAILED_LATE_CLOSED_STEP','INTERRUPTED_BEFORE_CLOSE','INTERRUPTED_LATE_CLOSED_STEP','SUCCESSFUL_TOOL_LATE_CLOSED_STEP','FINAL_LATE_CLOSED_STEP','PRIVATE_LATE_TOOL','PRIVATE_TOOL_BODY']){
  assert.ok(!page.text.includes(secret),secret);assert.ok(evidence.every(item=>!item.ocrText.includes(secret)),secret);assert.equal(f.materials.list({query:secret}).items.length,0,secret);
 }
});

test('Kimi CLI StepRetry discards only the failed attempt before the successful visible tool explanation',async t=>{
 const f=await fixture(t,'kimi',true),wire=join(f.native.path,'workspace','generated-session','wire.jsonl');
 const row=(type:string,payload:Record<string,unknown>={})=>line({timestamp:ms,message:{type,payload}});
 await writeFile(wire,row('TurnBegin',{user_input:requestText})+row('StepBegin',{n:1})+
  row('ContentPart',{type:'text',text:'FAILED_ATTEMPT_STREAM'})+
  row('StepRetry',{n:1,next_attempt:2,max_attempts:3,wait_s:0,error_type:'GeneratedTransientFailure',status_code:503}));
 await f.collect();await f.restartLocal();
 await appendFile(wire,row('ContentPart',{type:'text',text:progress})+
  row('ToolCall',{id:'retry-tool',function:{name:'generated',arguments:'PRIVATE_RETRY_TOOL'}})+
  row('ToolResult',{tool_call_id:'retry-tool',return_value:'PRIVATE_RETRY_TOOL'})+row('StepBegin',{n:2})+
  row('ContentPart',{type:'text',text:final})+row('TurnEnd'));await f.collect();
 const material=f.materials.list().items[0],page=await f.consumer.materialRead!({ref:material.ref,length:12000});
 const evidence=await f.consumer.evidence({ids:f.materials.evidenceIds(material.ref)});let previous=-1;
 for(const visible of [requestText,progress,final]){const index=page.text.indexOf(visible);assert.ok(index>previous);assert.equal(page.text.split(visible).length-1,1);previous=index;}
 for(const secret of ['FAILED_ATTEMPT_STREAM','PRIVATE_RETRY_TOOL']){
  assert.ok(!page.text.includes(secret),secret);assert.ok(evidence.every(item=>!item.ocrText.includes(secret)),secret);assert.equal(f.materials.list({query:secret}).items.length,0,secret);
 }
});
