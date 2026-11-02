import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtempSync,readdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentNotConfiguredError,type ContextReader,type QueryInput} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import {AgentRuntimeHost,type AgentRuntimeHostDependencies} from '../src/agent-runtime-host.js';
import {buildApp} from '../src/app.js';
import {documentFromConfig,registerBuiltinDomains,type Config} from '../src/config.js';
import {ConfigService} from '../src/config-service.js';
import {ConcurrencyGate} from '../src/concurrency.js';
import {Store,StoreError} from '../src/store.js';
import type {QueryAgent} from '../src/query-agent.js';
import {modelConfiguration} from '../src/model-configuration.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

const manual=process.env.MOTE_TEST_AGENT_STARTUP_JOURNEY==='1';
const settings:ModelSettings={provider:'custom',protocol:'deepseek',model:'generated-startup-model',baseUrl:'http://127.0.0.1:1',apiKey:'generated-local-only-key',headers:{},extraBody:{},reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:10000,agentTimeoutMs:20000,allowUnauthenticatedLocal:false};
const identity={kind:'profile' as const,id:'generated-profile'};
const reader:ContextReader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null,totalCount:0}),evidence:async()=>[],activity:async()=>({captures:0}),devices:async()=>[]};
function unitHost(factory:NonNullable<AgentRuntimeHostDependencies['createModelAgent']>,gate=new ConcurrencyGate(1)){
  const host=new AgentRuntimeHost({codex:undefined,createModelAgent:factory,
    authorization:{assertCurrent(){}},admission:{check(){},run:async(_settings,task)=>task()},
    runModelFor:()=>async task=>task(),authorizeModelRequest(){},assertPurpose(){},assertEvidence(){},assertEvidenceAsync:async()=>{},pinEvidence:input=>input,
    agentGate:gate,interactiveGate:gate,modelContext:new AsyncLocalStorage<QueryInput>(),modelOperation:new AsyncLocalStorage<string>(),
    archiveImagesEnabled:()=>false,retainSnapshot(){},releaseSnapshot(){},agentStarted(){},recordTiming(){},
  });
  return host;
}

test('runtime host rejects missing identity, unconfigured adapters and work after close without starting work',async()=>{
  let created=0,queried=0,closed=0;
  const host=unitHost(async()=>{created++;return {configured:false,query:async()=>{queried++;throw Error('Unreachable');},close:async()=>{closed++;}};});
  assert.throws(()=>host.factory(settings,reader),{statusCode:409});
  const adapter=await host.factory(settings,reader,undefined,identity);
  await assert.rejects(adapter.query({question:'Generated unavailable request'}),AgentNotConfiguredError);
  await host.close();await host.close();
  assert.throws(()=>host.factory(settings,reader,undefined,identity),{statusCode:503});
  await assert.rejects(adapter.query({question:'Generated closed request'}),{statusCode:503});
  assert.deepEqual({created,queried,closed},{created:1,queried:0,closed:1});
});

test('closing during runtime assembly drains the unpublished candidate and retains cleanup failures',async()=>{
  for(const failCleanup of [false,true]){
    let resolve!:(agent:QueryAgent)=>void,closed=0;
    const host=unitHost(()=>new Promise<QueryAgent>(done=>{resolve=done;}));
    const candidate=host.factory(settings,reader,undefined,identity);
    const rejected=assert.rejects(candidate,error=>failCleanup?error instanceof AggregateError&&error.cause instanceof StoreError:error instanceof StoreError&&error.statusCode===503);
    const closing=host.close(),drained=failCleanup?assert.rejects(closing,AggregateError):closing;
    resolve({configured:true,query:async()=>{throw Error('Unreachable');},close:async()=>{closed++;if(failCleanup)throw Error('Generated cleanup failure');}});
    await rejected;await drained;assert.equal(closed,1);
  }
});

test('closing fences a controlled late adapter result instead of publishing success',async()=>{
  let release!:(result:any)=>void,entered!:()=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const host=unitHost(async()=>({configured:true,close:async()=>{},query:()=>{entered();return new Promise(done=>{release=done;});}}));
  const adapter=await host.factory(settings,reader,undefined,identity),query=adapter.query({question:'Generated pending query'});
  const rejected=assert.rejects(query,{statusCode:503});await started;const closing=host.close();
  release({answer:'Generated late answer',citations:[],trace:[]});await rejected;await closing;
});

test('host shutdown cancels queued runtime work without waiting for an unrelated gate occupant',async()=>{
  const gate=new ConcurrencyGate(1);let release!:()=>void,entered!:()=>void,calls=0;
  const occupied=new Promise<void>(done=>{entered=done;});
  const unrelated=gate.run(()=>{entered();return new Promise<void>(done=>{release=done;});});await occupied;
  const host=unitHost(async()=>({configured:true,query:async()=>{calls++;throw Error('Unreachable');},close:async()=>{}}),gate);
  const adapter=await host.factory(settings,reader,undefined,identity);
  let queued!:()=>void;const started=new Promise<void>(done=>{queued=done;});
  const query=adapter.query({question:'Generated queued query',onProgress:()=>queued()}),rejected=assert.rejects(query,{statusCode:503});
  try{await started;assert.equal(gate.snapshot().waiting,1);await host.close();await rejected;assert.equal(calls,0);}
  finally{release();await unrelated;gate.close();}
});

function profile(t:TestContext,overrides:Partial<Config>={}){
  const root=mkdtempSync(join(tmpdir(),'mote-agent-startup-'));
  const config:Config={dataDir:join(root,'data'),token:'generated-startup-owner-token',tokenPath:join(root,'owner.token'),host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',...overrides};
  const configService=new ConfigService({path:join(root,'mote.yaml'),initialDocument:documentFromConfig(config),watch:false});registerBuiltinDomains(configService,config);
  const cleanup:Array<()=>unknown|Promise<unknown>>=[];
  t.after(async()=>{try{for(const close of cleanup)await close();}finally{await configService.close();rmSync(root,{recursive:true,force:true});}});
  return {root,config,configService,own:(close:()=>unknown|Promise<unknown>)=>cleanup.unshift(close),headers:{authorization:`Bearer ${config.token}`}};
}

test('normal buildApp rejects unauthenticated and unconfigured queries without publishing an empty success',async t=>{
  const f=profile(t),node=await buildApp(f.config,{configService:f.configService,backgroundWorker:false});f.own(()=>node.app.close());
  const payload={question:'Generated unavailable model question'};
  assert.equal((await node.app.inject({method:'POST',url:'/api/query',payload})).statusCode,401);
  const unavailable=await node.app.inject({method:'POST',url:'/api/query',headers:f.headers,payload});
  assert.equal(unavailable.statusCode,503,unavailable.body);
  const history=(await node.app.inject({url:'/api/conversations',headers:f.headers})).json();
  for(const summary of history.items){const conversation=(await node.app.inject({url:'/api/conversations/'+summary.id,headers:f.headers})).json();assert.ok(conversation.turns.every((turn:any)=>!turn.result),'failure records are allowed; successful empty answers are not');}
});

test('runtime adapter startup failure rolls back buildApp resources and never publishes a running app',async t=>{
  const f=profile(t,{model:settings.model,modelProvider:'custom',modelProtocol:'deepseek',modelBaseUrl:settings.baseUrl,apiKey:settings.apiKey}),primary=Error('Generated private adapter startup failure');
  await assert.rejects(buildApp(f.config,{configService:f.configService,backgroundWorker:false,createModelAgent:async()=>{throw primary;}}));
  const reopened=new Store(f.config.dataDir);
  try{assert.equal(reopened.stats().captures,0);if(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_turns'").get())assert.equal(reopened.db.prepare("SELECT count(*) n FROM conversation_turns WHERE json_extract(json,'$.result') IS NOT NULL").get()!.n,0);}
  finally{reopened.close();}
});

test('selected A06 journey: owner HTTP query traverses default Host and real DSH, then saves cited output and configuration receipts', {skip:!manual,timeout:60000},async t=>{
  const id=randomUUID(),fixtureModel=`generated-startup-${id}`,original='Generated observatory release was approved on Sunday.',requests:any[]=[],children=new Map<number,string>(),privateRoots=new Set<string>();
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw),stage=requests.length;requests.push(body);
    for(const line of execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n')){
      const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if(match&&Number(match[2])===process.pid&&match[3].includes('dsh'))children.set(Number(match[1]),match[3]);
    }
    // Bind private roots to this generated model's exact adapter settings.
    for(const name of readdirSync(tmpdir()).filter(name=>name.startsWith('mote-dsh-runtime-'))){
      const root=join(tmpdir(),name),patch=join(root,'runtime.patch.json');
      if(existsSync(patch)&&readFileSync(patch,'utf8').includes(fixtureModel))privateRoots.add(root);
    }
    const tool=stage===0?{name:'search_context',args:{query:'generated observatory release'}}:stage===1?{name:'evidence',args:{ids:[id]}}:undefined;
    writeMessagesResponse(res,{stage,tool,reasoning:true,text:JSON.stringify({answer:`${original} [${id}]`,citationIds:[id]})});
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));});
  const f=profile(t,{model:fixtureModel,modelProvider:'custom',modelProtocol:'deepseek',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}`,apiKey:settings.apiKey,modelRequestTimeoutMs:10000,agentTimeoutMs:20000});
  // No QueryAgent/factory override: use actual production build defaults.
  const node=await buildApp(f.config,{configService:f.configService,backgroundWorker:false});f.own(()=>node.app.close());
  await node.app.listen({host:'127.0.0.1',port:0});const url=`http://127.0.0.1:${(node.app.server.address() as AddressInfo).port}`;
  const post=(path:string,payload:unknown,authenticated=true)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...(authenticated?f.headers:{})},body:JSON.stringify(payload)});
  const note=await post('/api/notes',{id,deviceId:'generated-a06-device',deviceName:'Generated fixture',platform:'android',capturedAt:'2026-11-01T12:00:00.000Z',text:original});assert.equal(note.status,201,await note.text());
  const runId=randomUUID(),input={question:'When was the generated observatory release approved?',evidenceIds:[id]};
  const denied=await post('/api/query-runs',{id:randomUUID(),input},false);assert.equal(denied.status,401);assert.equal(requests.length,0);assert.ok(!(await denied.text()).includes(original));
  const invalid=await post('/api/query',{...input,modelProfileId:'generated-missing-profile'});
  assert.equal(invalid.status,400,await invalid.text());assert.equal(requests.length,0,'invalid profile pairing never reaches the model');
  const accepted=await post('/api/query-runs',{id:runId,input});assert.equal(accepted.status,202,await accepted.text());
  let run:any;const deadline=Date.now()+30000;
  do{const response=await fetch(url+'/api/query-runs/'+runId,{headers:f.headers});assert.equal(response.status,200);run=await response.json();if(run.status!=='running')break;await delay(25);}while(Date.now()<deadline);
  assert.equal(run.status,'completed',JSON.stringify(run));assert.ok(run.conversationId&&run.turnId);assert.ok(run.evidenceDependencies.complete);assert.ok(run.evidenceDependencies.ids.includes(id));
  const conversation=await (await fetch(url+'/api/conversations/'+run.conversationId,{headers:f.headers})).json() as any,turn=conversation.turns.find((turn:any)=>turn.id===run.turnId);
  assert.ok(turn,JSON.stringify(conversation));assert.equal(turn.result.answer,`${original} [${id}]`);assert.equal(turn.result.citations[0].id,id);assert.ok(turn.result.citations[0].excerpt.includes(original));assert.ok(turn.result.evidenceDependencies.ids.includes(id));
  const saved=node.featureServices.delegation.journal.payload<any>('query:'+runId),models=node.modelSettings;
  const selected=models.select('chat');assert.equal(saved.configurationFingerprint,modelConfiguration(selected.id,selected.settings,models.view().revision).fingerprint);
  assert.equal(turn.result.modelSelection.profileId,selected.id);assert.equal(turn.result.modelSelection.model,fixtureModel);
  assert.equal(requests.length,3);assert.ok(JSON.stringify(requests[2]).includes(original),'the actual tool delivery reaches the following model request');
  assert.ok(children.size>0,'actual DSH subprocess observed at model boundary');assert.ok(privateRoots.size>0,'actual private generated runtime observed');
  await node.app.close();
  for(const pid of children.keys())assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  for(const root of privateRoots)assert.equal(existsSync(root),false,'private runtime removed after Host cleanup');
  t.diagnostic(JSON.stringify({dshPids:[...children.keys()],privateRoots:[...privateRoots],requests:requests.length,runId,turnId:run.turnId}));
});
