import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentYieldError,type QueryInput} from '@mote/agent';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {assertSourceContextDependencies} from '../src/source-context-lineage.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime,registerQueryDelegation} from '../src/delegation-runtime.js';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../../../packages/agent/dist/bridge.js';

const answer=(text='Generated source-only answer')=>({answer:text,citations:[],trace:[],runId:'generated-fixture'});
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-delegation-source-context-')),store=new Store(directory),sources=new SourceStore(store),engine=new ExecutionEngine(store);
  sources.register({id:'generated-calls',name:'Generated calls',deviceId:'generated-device',platform:'android',kind:'local-files'});sources.updateContext('generated-calls',{expectedVersion:0,description:'Generated owner description of phone calls'});
  const options={autoPump:false,concurrency:()=>1,validateSourceContextDependencies:(pins:Parameters<typeof assertSourceContextDependencies>[1])=>assertSourceContextDependencies(sources.contexts,pins)},runtime=new DelegationRuntime(store,engine,options);
  t.after(async()=>{await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,engine,runtime,options,pin:sources.contexts.identity('generated-calls')!};
}
async function settle(runtime:DelegationRuntime,id:string){for(let i=0;i<80;i++){await runtime.tick();const work=runtime.get(id);if(['succeeded','failed','cancelled','stale'].includes(work.status))return work;await new Promise(resolve=>setImmediate(resolve));}throw Error('Generated source-context work did not settle');}
const submit=async(input:QueryInput,question='Generated worker question')=>{
  await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'worker',capabilityId:'context.research',title:'Generated metadata check',goal:'Read generated description',input:{question}}]});
  await input.hostControlChannel!.execute('delegation_yield',{});throw new AgentYieldError();
};

test('source-only coordinator disclosures persist independently of payload replacements and fence completed results',async t=>{
  const {runtime,sources,pin,store}=fixture(t);
  registerQueryDelegation(runtime,{query:async input=>{assert.equal(input.hostControlChannel!==undefined,true);input.onSourceContextDependencies?.([pin]);return answer();}});
  runtime.start({id:'source-only-work',profileId:'query',goal:'Generated question',input:{question:'Generated source-only question'},allowedCapabilities:['context.research']});
  assert.equal((await settle(runtime,'source-only-work')).status,'succeeded');assert.deepEqual(runtime.sourceContextDependencies('source-only-work'),[pin]);
  assert.deepEqual(runtime.result<{sourceContextDependencies:unknown}>('source-only-work')?.sourceContextDependencies,[pin]);
  runtime.journal.savePayload('source-only-work',{question:'Generated replacement preparation'});assert.deepEqual(runtime.sourceContextDependencies('source-only-work'),[pin]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM delegation_dependencies WHERE work_id=?').get('source-only-work')!.n,0,'source metadata is not synthetic original evidence');
  sources.updateContext(pin.sourceId,{expectedVersion:pin.version,description:'Generated corrected source context'});
  assert.equal(runtime.get('source-only-work').status,'stale');assert.equal(runtime.get('source-only-work').error,'source_context_changed');assert.equal(runtime.result('source-only-work'),undefined);
});

test('unread worker source disclosures belong only to that worker and do not stale an independent coordinator answer',async t=>{
  const {runtime,sources,pin}=fixture(t);let fragments=0,workers=0;
  registerQueryDelegation(runtime,{query:async input=>{
    if(!input.hostControlChannel){workers++;assert.equal(input.contextSourceContextDependencies,undefined);input.onSourceContextDependencies?.([pin]);return {...answer('Generated worker interpretation'),sourceContextDependencies:[pin]};}
    fragments++;if(fragments===1)return submit(input);
    assert.equal(runtime.sourceContextDependencies('unread-work').length,0);assert.deepEqual(runtime.sourceContextDependencies('unread-work','unread-work:unit:worker'),[pin]);
    sources.updateContext(pin.sourceId,{expectedVersion:pin.version,description:'Generated revised owner description'});
    await assert.rejects(input.hostControlChannel.execute('delegation_read',{artifactId:runtime.unit('unread-work:unit:worker').artifactId}),/outside this work or no longer valid/);
    return answer('Generated independent coordinator answer');
  }});
  runtime.start({id:'unread-work',profileId:'query',goal:'Generated question',input:{question:'Generated question'},allowedCapabilities:['context.research']});
  assert.equal((await settle(runtime,'unread-work')).status,'succeeded');assert.equal(workers,1);assert.equal(fragments,2);assert.equal(runtime.unit('unread-work:unit:worker').status,'stale');
  assert.deepEqual(runtime.sourceContextDependencies('unread-work'),[]);assert.equal(runtime.result<{answer:string}>('unread-work')?.answer,'Generated independent coordinator answer');
});

test('opening a worker source-only product transfers fixed pins and rejects a coordinator late commit after correction',async t=>{
  const {runtime,sources,pin}=fixture(t);let fragments=0,commits=0;
  registerQueryDelegation(runtime,{query:async input=>{
    if(!input.hostControlChannel){input.onSourceContextDependencies?.([pin]);return {...answer('Generated worker source interpretation'),sourceContextDependencies:[pin]};}
    if(++fragments===1)return submit(input);
    const product=await input.hostControlChannel.execute('delegation_read',{artifactId:runtime.unit('read-work:unit:worker').artifactId});
    assert.deepEqual(product.sourceContextDependencies,[pin]);assert.deepEqual(product.evidence,[]);assert.deepEqual(runtime.sourceContextDependencies('read-work'),[pin]);
    sources.updateContext(pin.sourceId,{expectedVersion:pin.version,description:'Generated replacement source description'});return answer('Obsolete generated coordinator answer');
  },commit:()=>{commits++;}});
  runtime.start({id:'read-work',profileId:'query',goal:'Generated question',input:{question:'Generated question'},allowedCapabilities:['context.research']});
  const work=await settle(runtime,'read-work');assert.equal(work.status,'stale');assert.equal(work.error,'source_context_changed');assert.equal(commits,0);assert.equal(runtime.result(work.id),undefined);
});

test('a source-only disclosure before yield survives restart and prevents resuming a stale saved fragment',async t=>{
  const {runtime,sources,pin,store,engine,options}=fixture(t);let fragments=0;
  const query=async(input:QueryInput)=>{if(!input.hostControlChannel)return answer('Generated child answer');fragments++;if(fragments===1){input.onSourceContextDependencies?.([pin]);return submit(input);}return answer('Generated resumed answer');};
  registerQueryDelegation(runtime,{query});runtime.start({id:'restart-source-work',profileId:'query',goal:'Generated source-only request',input:{question:'Generated source-only request'},allowedCapabilities:['context.research']});
  assert.equal((await settle(runtime,'restart-source-work')).status,'succeeded');assert.equal(fragments,2);assert.deepEqual(runtime.sourceContextDependencies('restart-source-work'),[pin]);
  store.db.prepare("UPDATE delegation_works SET json=json_set(json,'$.status','waiting','$.revision',2,'$.planningComplete',false) WHERE id='restart-source-work'").run();
  store.db.prepare("UPDATE execution_steps SET state='waiting',available_at=0 WHERE id='restart-source-work:coordinator:2'").run();await runtime.close();
  sources.updateContext(pin.sourceId,{expectedVersion:pin.version,description:''});
  const replacement=new DelegationRuntime(store,engine,options);t.after(()=>replacement.close());registerQueryDelegation(replacement,{query});
  const work=await settle(replacement,'restart-source-work');assert.equal(work.status,'stale');assert.equal(fragments,2,'no resumed model invocation with obsolete source context');
  assert.equal(replacement.result(work.id),undefined);assert.equal(replacement.journal.payload<{question:string}>(work.id).question,'Generated source-only request','owner request remains available');
});

test('worker source-context changes fence a late product before it can be handed to the coordinator',async t=>{
  const {runtime,sources,pin}=fixture(t);let fragments=0;
  registerQueryDelegation(runtime,{query:async input=>{
    if(!input.hostControlChannel){input.onSourceContextDependencies?.([pin]);sources.updateContext(pin.sourceId,{expectedVersion:pin.version,description:'Generated newer description during worker model'});return {...answer('Obsolete worker product'),sourceContextDependencies:[pin]};}
    if(++fragments===1)return submit(input);assert.equal(runtime.artifactMetadata('late-worker-work').length,0);return answer('Generated coordinator reports the stale worker');
  }});
  runtime.start({id:'late-worker-work',profileId:'query',goal:'Generated question',input:{question:'Generated question'},allowedCapabilities:['context.research']});
  assert.equal((await settle(runtime,'late-worker-work')).status,'succeeded');assert.equal(runtime.unit('late-worker-work:unit:worker').status,'stale');assert.equal(runtime.artifactMetadata('late-worker-work').length,0);
});

for(const correctWhileWaiting of [false,true])test(`HTTP source-only query opens real metadata tools and ${correctWhileWaiting?'fences yielded work after an owner edit':'persists declared versions across its worker and completion'}`,async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-http-delegated-source-context-')),token='generated-source-metadata-owner',headers={authorization:'Bearer '+token};
  const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1,llmConcurrency:1};
  let node:Awaited<ReturnType<typeof buildApp>>,fragments=0,workerStarted=false,fixtureFailure:unknown,workerEntered!:()=>void,releaseWorker!:()=>void;
  const entered=new Promise<void>(resolve=>workerEntered=resolve),held=new Promise<void>(resolve=>releaseWorker=resolve);
  const query:QueryAgent['query']=async input=>{
    if(!input.hostControlChannel){workerStarted=true;workerEntered();if(correctWhileWaiting)await held;return answer('Generated independent worker reply');}
    fragments++;const bridge=await startBridge(node.featureServices.archiveReader,input,20);
    try{
      if(fragments===1){
        const call=async(tool:string,args:Record<string,unknown>)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
        const capability=await call('capability_discover',{name:'sources'});
        const found=await call('capability_execute',{name:'sources',version:capability.data.version,argumentsJson:JSON.stringify({query:'Generated metadata phone'})});assert.equal(found.data.items.length,1);assert.ok(found.data.items[0].sourceContextRef);
        const opened=await call('attribution_context',{sourceContextRef:found.data.items[0].sourceContextRef,length:12000}),context=JSON.parse(opened.data.text);
        assert.equal(context.sourceContextStatements[0].description,'Generated phone calls; the anonymous speaker identity remains unknown.');assert.equal(bridge.records.size,0);
        assert.equal(node.featureServices.delegation.sourceContextDependencies('query:'+runId).length,1,'actual tool disclosure is durable before yield');
        return submit(input,'Generated independent worker check');
      }
      assert.equal(correctWhileWaiting,false,'stale saved context must not invoke a resumed model fragment');
      assert.equal(input.contextSourceContextDependencies?.length,1);return {...answer(),sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){fixtureFailure=error;throw error;}finally{await bridge.close();}
  };
  node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query,close:async()=>releaseWorker()}});t.after(async()=>{releaseWorker();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const registered=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'generated-http-metadata',name:'Generated metadata phone',deviceId:'generated-device',platform:'android',kind:'local-files'}});assert.equal(registered.statusCode,200);
  const contextUrl='/api/sources/generated-http-metadata/context',declared=await node.app.inject({method:'PATCH',url:contextUrl,headers,payload:{expectedVersion:0,description:'Generated phone calls; the anonymous speaker identity remains unknown.'}});assert.equal(declared.statusCode,200);
  const runId=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:runId,input:{question:'Generated owner metadata question'}}});assert.equal(accepted.statusCode,202);
  for(let i=0;i<100&&!workerStarted;i++){await new Promise(resolve=>setTimeout(resolve,20));const pending=(await node.app.inject({url:'/api/query-runs/'+runId,headers})).json();if(fixtureFailure)throw fixtureFailure;assert.equal(pending.status==='running'||workerStarted,true,JSON.stringify(pending));}
  assert.equal(workerStarted,true);await entered;
  if(correctWhileWaiting){const changed=await node.app.inject({method:'PATCH',url:contextUrl,headers,payload:{expectedVersion:1,description:'Generated calls from a shared phone; neither speaker is identified as me.'}});assert.equal(changed.statusCode,200);releaseWorker();}
  let run:any;
  for(let i=0;i<120;i++){await new Promise(resolve=>setTimeout(resolve,20));run=(await node.app.inject({url:'/api/query-runs/'+runId,headers})).json();if(run.status!=='running')break;}
  assert.equal(run.status,correctWhileWaiting?'failed':'completed');assert.equal(run.sourceContextDependencies.length,1);assert.equal(run.sourceContextDependencies[0].version,1);assert.ok(run.conversationId);
  const conversation=(await node.app.inject({url:'/api/conversations/'+run.conversationId,headers})).json();assert.equal(conversation.turns[0].question,'Generated owner metadata question');
  if(correctWhileWaiting){assert.equal(fragments,1);assert.equal(conversation.turns[0].status,'failed');assert.equal(node.featureServices.delegation.result('query:'+runId),undefined);}
  else{assert.equal(fragments,2);assert.deepEqual(conversation.turns[0].result.sourceContextDependencies,run.sourceContextDependencies);assert.deepEqual(conversation.turns[0].result.citations,[]);}
});
