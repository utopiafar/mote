import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {AgentYieldError} from '@mote/agent';
import {ContentStorageService} from '../src/content-storage.js';
import {Store} from '../src/store.js';
import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
import {DelegationRuntime,registerQueryDelegation,DELEGATION_CONTROL_DEFINITIONS,type DelegationCoordinatorContext} from '../src/delegation-runtime.js';

function fixture(t:any,concurrency=2,options:ConstructorParameters<typeof Store>[1]={}){const directory=mkdtempSync(join(tmpdir(),'mote-delegation-')),store=new Store(directory,options),engine=new ExecutionEngine(store),runtime=new DelegationRuntime(store,engine,{concurrency:()=>concurrency,autoPump:false});t.after(async()=>{await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,engine,runtime};}
const proposal=(id:string,capabilityId='fixture',extra:Record<string,unknown>={})=>({id,capabilityId,title:'Generated branch '+id,goal:'Inspect generated evidence',input:{id},...extra});
async function settle(runtime:DelegationRuntime,id:string){for(let i=0;i<50;i++){await runtime.tick();const work=runtime.get(id);if(['succeeded','failed','cancelled','stale'].includes(work.status))return work;await new Promise(resolve=>setImmediate(resolve));}throw Error('Generated work did not settle');}

test('coordinator submits a batch immediately, releases its only slot, and resumes from private artifacts',async t=>{
 const {runtime}=fixture(t,1),order:string[]=[],committed:unknown[]=[];
 runtime.register({id:'fixture',version:'1',description:'Generated fixture',execute:async unit=>{order.push(unit.id);return {value:{read:unit.input.id},summary:'Generated result'};}});
 runtime.registerCoordinator({id:'coordinator',execute:async({work,controls})=>{
  order.push('coordinator:'+work.revision);
  if(!work.units.length){const receipt=await controls.execute('delegation_submit',{units:[proposal('a'),proposal('b')]});assert.equal((receipt.data as {units:unknown[]}).units.length,2);assert.deepEqual(order,['coordinator:1']);await controls.execute('delegation_yield',{mode:'all'});throw new AgentYieldError();}
  assert.ok(work.units.every(unit=>unit.status==='succeeded'));
  const result=await controls.execute('delegation_read',{artifactId:work.units[0].artifactId});assert.equal(JSON.parse((result.data as {text:string}).text).read,'a');return 'Generated final answer';
 },commit:(_work,value)=>committed.push(value)});
 runtime.start({id:'fixture-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});
 const work=await settle(runtime,'fixture-work');assert.equal(work.status,'succeeded');assert.equal(work.revision,2);assert.deepEqual(order,['coordinator:1','fixture-work:unit:a','fixture-work:unit:b','coordinator:2']);assert.deepEqual(committed,['Generated final answer']);assert.equal(runtime.result('fixture-work'),'Generated final answer');assert.equal(runtime.artifactMetadata(work.id).length,2);
 assert.deepEqual(work.events.map(event=>event.type),['work.started','branch.started','branch.started','work.waiting','branch.completed','branch.completed','work.resumed','work.completed']);
});

test('one failed branch can retry without recreating the successful artifact',async t=>{
 const {runtime}=fixture(t),calls:Record<string,number>={};
 runtime.register({id:'fixture',version:'1',description:'Generated fixture',execute:async unit=>{const id=String(unit.input.id);calls[id]=(calls[id]??0)+1;if(id==='b'&&calls[id]===1)throw new ExecutionFailure('permanent','generated_failure');return {value:id};}});
 runtime.registerCoordinator({id:'coordinator',execute:async({work,controls})=>{
  if(!work.units.length){await controls.execute('delegation_submit',{units:[proposal('a'),proposal('b')]});await controls.execute('delegation_yield',{});throw new AgentYieldError();}
  const failed=work.units.find(unit=>unit.status==='failed');if(failed){await controls.execute('delegation_retry',{unitId:failed.id});await controls.execute('delegation_yield',{unitIds:[failed.id]});throw new AgentYieldError();}return 'Finished';
 }});
 runtime.start({id:'retry-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});const work=await settle(runtime,'retry-work');assert.equal(work.status,'succeeded');assert.deepEqual(calls,{a:1,b:2});assert.equal(runtime.artifactMetadata(work.id).length,2);assert.equal(work.units[1].attempts,1);
});

test('a terminal coordinator releases running child slots and retains local retry handles',async t=>{
 const {runtime,engine}=fixture(t,2),calls:Record<string,number>={};let childActive=0,aborted=false,enter!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve);
 runtime.register({id:'fixture',version:'1',description:'Generated work',execute:async(unit,{signal})=>{const id=String(unit.input.id);calls[id]=(calls[id]??0)+1;childActive++;
  try{if(id==='slow'&&calls[id]===1){enter();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {value:'late generated product'};}if(id==='fast')await entered;return {value:id};}finally{childActive--;}
 }});
 runtime.registerCoordinator({id:'coordinator',execute:async({work,controls})=>{
  if(!work.units.length){await controls.execute('delegation_submit',{units:[proposal('fast'),proposal('slow')]});await controls.execute('delegation_yield',{mode:'any'});throw new AgentYieldError();}
  if(work.revision===2)throw new ExecutionFailure('permanent','generated_coordinator_failure');
  const failed=work.units.find(unit=>unit.status==='failed');if(failed){await controls.execute('delegation_retry',{unitId:failed.id});await controls.execute('delegation_yield',{unitIds:[failed.id]});throw new AgentYieldError();}return 'Recovered generated answer';
 }});
 runtime.start({id:'failed-parent-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});const failed=await settle(runtime,'failed-parent-work');await engine.drain(['failed-parent-work:unit:slow']);
 assert.equal(failed.status,'failed');assert.equal(aborted,true);assert.equal(childActive,0);assert.equal(runtime.unit('failed-parent-work:unit:slow').status,'failed');assert.equal(runtime.unit('failed-parent-work:unit:slow').error,'parent_failed');assert.equal(runtime.artifactMetadata(failed.id).length,1);const successfulArtifact=runtime.unit('failed-parent-work:unit:fast').artifactId;
 runtime.retry(failed.id);const recovered=await settle(runtime,failed.id);assert.equal(recovered.status,'succeeded');assert.deepEqual(calls,{fast:1,slow:2});assert.equal(runtime.unit('failed-parent-work:unit:fast').artifactId,successfulArtifact);assert.equal(runtime.artifactMetadata(failed.id).length,2);
});

test('immutable unit IDs, scope narrowing and DAG validation reject forged submissions atomically',async t=>{
 const {runtime}=fixture(t);let captured!:DelegationCoordinatorContext;let finish!:()=>void;
 runtime.register({id:'fixture',version:'1',description:'Generated fixture',execute:async()=>({value:'fixture'})});
 runtime.registerCoordinator({id:'coordinator',execute:async context=>{captured=context;await new Promise<void>(resolve=>finish=resolve);return 'done';}});
 runtime.start({id:'bounded-work',profileId:'coordinator',goal:'Generated task',input:{},scope:{deviceId:'selected',after:'2026-01-02T00:00:00Z',before:'2026-02-01T00:00:00Z',evidenceIds:['authorized']},allowedCapabilities:['fixture']});await new Promise(resolve=>setImmediate(resolve));t.after(()=>finish?.());
 await assert.rejects(captured.controls.execute('delegation_submit',{units:[proposal('bad','fixture',{scope:{deviceId:'other'}})]}),/scope exceeds/);
 await assert.rejects(captured.controls.execute('delegation_submit',{units:[proposal('bad','fixture',{scope:{evidenceIds:['forged']}})]}),/evidence exceeds/);
 await assert.rejects(captured.controls.execute('delegation_submit',{units:[proposal('bad','fixture',{scope:{evidenceIds:null}})]}),/cannot remove/);
 await assert.rejects(captured.controls.execute('delegation_submit',{units:[proposal('a','fixture',{dependencies:['b']}),proposal('b','fixture',{dependencies:['a']})]}),/acyclic/);
 assert.equal(runtime.get('bounded-work').units.length,0);
 await captured.controls.execute('delegation_submit',{units:[proposal('a'),proposal('b','fixture',{dependencies:['a']})]});
 await captured.controls.execute('delegation_submit',{units:[proposal('a')]});assert.equal(runtime.get('bounded-work').units.length,2);
 await assert.rejects(captured.controls.execute('delegation_submit',{units:[proposal('a','fixture',{goal:'different'})]}),/another package/);
 await captured.controls.execute('delegation_cancel',{unitId:'bounded-work:unit:a'});await captured.controls.execute('delegation_cancel',{unitId:'bounded-work:unit:b'});finish();await settle(runtime,'bounded-work');
});

test('durable handles resume on a replacement harness without repeating completed child work',async t=>{
 const {store,engine,runtime}=fixture(t,1);let runs=0;
 const capability={id:'fixture',version:'1',description:'Generated fixture',execute:async()=>{runs++;return {value:'generated original result'};}};
 const profile={id:'coordinator',execute:async({work,controls}:DelegationCoordinatorContext)=>{if(!work.units.length){await controls.execute('delegation_submit',{units:[proposal('a')]});await controls.execute('delegation_yield',{});throw new AgentYieldError();}return 'resumed';}};
 runtime.register(capability);runtime.registerCoordinator(profile);runtime.start({id:'restart-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});await settle(runtime,'restart-work');assert.equal(runs,1);
 // Simulate a crash after the validated child commit and before the resumed fragment.
 store.db.prepare("UPDATE delegation_works SET json=json_set(json,'$.status','waiting','$.revision',2,'$.planningComplete',false) WHERE id='restart-work'").run();
 store.db.prepare("UPDATE execution_steps SET state='waiting',available_at=0 WHERE id='restart-work:coordinator:2'").run();await runtime.close();
 const replacement=new DelegationRuntime(store,engine,{autoPump:false,concurrency:()=>1});t.after(()=>replacement.close());replacement.register(capability);replacement.registerCoordinator(profile);
 const resumed=await settle(replacement,'restart-work');assert.equal(resumed.status,'succeeded');assert.equal(runs,1);assert.equal(replacement.artifactMetadata(resumed.id).length,1);
});

test('cancellation revokes the child commit even if its model returns late',async t=>{
 const {runtime,engine}=fixture(t);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 runtime.register({id:'fixture',version:'1',description:'Generated fixture',execute:async()=>{enter();await held;return {value:'late private result'};}});
 runtime.registerCoordinator({id:'coordinator',execute:async({controls})=>{await controls.execute('delegation_submit',{units:[proposal('a')]});await controls.execute('delegation_yield',{});throw new AgentYieldError();}});
 runtime.start({id:'cancel-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});await entered;runtime.cancel('cancel-work');release();await engine.drain(['cancel-work:unit:a']);assert.equal(runtime.get('cancel-work').status,'cancelled');assert.equal(runtime.artifactMetadata('cancel-work').length,0);
});

test('deleting a used original clears its products while an unrelated work keeps its receipt',async t=>{
 const {runtime,store}=fixture(t);
 runtime.registerCoordinator({id:'coordinator',execute:async()=>({answer:'Generated private result'})});
 runtime.start({id:'used-work',profileId:'coordinator',goal:'Generated private goal',input:{evidenceIds:['used-id'],conversation:{turns:[{question:'private prompt',answer:'private context'}]}},allowedCapabilities:[]});
 runtime.start({id:'other-work',profileId:'coordinator',goal:'Unrelated generated goal',input:{evidenceIds:['other-id']},allowedCapabilities:[]});await settle(runtime,'used-work');await settle(runtime,'other-work');
 store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'delete',?)").run('used-id',new Date().toISOString());
 assert.equal(runtime.get('used-work').status,'stale');assert.equal(runtime.get('used-work').goal,'');assert.equal(runtime.get('used-work').events.length,0);assert.throws(()=>runtime.journal.payload('used-work'),/no longer available/);assert.equal(runtime.result('used-work'),undefined);assert.equal(runtime.get('other-work').status,'succeeded');assert.deepEqual(runtime.result('other-work'),{answer:'Generated private result'});
});

test('a stable work cancellation alias fences a coordinator from another database connection',async t=>{
 const {runtime,store}=fixture(t),other=new Store(store.directory),external=new ExecutionEngine(other);t.after(async()=>{await external.close();other.close();});let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);let commits=0;
 runtime.registerCoordinator({id:'coordinator',execute:async()=>{enter();await held;return 'late result';},commit:()=>{commits++;}});runtime.start({id:'alias-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:[]});await entered;
 external.cancel('alias-work');assert.equal(runtime.get('alias-work').status,'cancelled');release();await settle(runtime,'alias-work');assert.equal(commits,0);assert.equal(runtime.result('alias-work'),undefined);
});

test('formal anchor invalidation removes private delegated replay context before original deletion',async t=>{
 const {runtime,store}=fixture(t);runtime.registerCoordinator({id:'coordinator',execute:async()=>({answer:'generated derived private prose'})});runtime.start({id:'anchor-work',profileId:'coordinator',goal:'Generated private anchor goal',input:{evidenceIds:['formal-anchor-id']},allowedCapabilities:[]});await settle(runtime,'anchor-work');store.invalidateConversationAnswers(['formal-anchor-id']);assert.equal(runtime.get('anchor-work').status,'stale');assert.throws(()=>runtime.journal.payload('anchor-work'),/no longer available/);assert.equal(runtime.result('anchor-work'),undefined);
});

test('query workers receive no controls and independent scoped contexts',async t=>{
 const {runtime}=fixture(t);const seen:Parameters<Parameters<typeof registerQueryDelegation>[1]['query']>[0][]=[],answer={answer:'Generated answer',citations:[],trace:[],runId:'fixture'};
 registerQueryDelegation(runtime,{query:async input=>{seen.push(input);if(input.hostControlChannel&&seen.length===1){await input.hostControlChannel.execute('delegation_submit',{units:[{...proposal('a','context.research'),input:{question:'Generated subquestion'}}]});await input.hostControlChannel.execute('delegation_yield',{});throw new AgentYieldError();}return answer;}});
 runtime.start({id:'query-work',profileId:'query',goal:'Generated task',input:{question:'Generated question',conversation:{turns:[],omittedTurns:0},taskContext:{turns:[]}},scope:{deviceId:'selected'},allowedCapabilities:['context.research']});await settle(runtime,'query-work');assert.equal(seen.length,3);assert.equal(seen[1].hostControlChannel,undefined);assert.equal(seen[1].conversation,undefined);assert.equal(seen[1].taskContext,undefined);assert.equal(seen[1].deviceId,'selected');assert.equal(seen[1].question,'Generated subquestion');
});

test('external product handoff remains waiting until its own fenced job writes a private artifact',async t=>{
 const {runtime,engine}=fixture(t);runtime.register({id:'fixture',version:'1',proposal:true,description:'Generated product proposal',execute:async()=>{throw Error('must not create duplicate executor');}});
 runtime.registerCoordinator({id:'coordinator',awaitExternal:true,execute:async({controls})=>{await controls.execute('delegation_submit',{units:[proposal('a')]});return 'plan ready';}});
 runtime.start({id:'external-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});const planned=await runtime.waitForPlan('external-work');assert.equal(planned.status,'waiting');
 engine.register({kind:'external-fixture',pool:'external-fixture',concurrency:()=>1,validate:()=>true,execute:async()=>({value:{checked:2},coverage:[{id:'generated-a',status:'no_candidates'}]}),commit:(_step,value)=>runtime.recordExternalArtifact('external-work',planned.units[0].id,value as any)});
 const step=engine.enqueue('product-work','external-fixture',{});runtime.linkExternalUnit('external-work',planned.units[0].id,step);await engine.drain([step]);const finished=await settle(runtime,'external-work');assert.equal(finished.status,'succeeded');assert.equal(runtime.artifactMetadata(finished.id).length,1);
});

for(const cancelAfterPlan of [false,true])test(`accepted external plans ${cancelAfterPlan?'retain later cancellation as an unfinished obligation':'exclude cancelled draft proposals after a complete replacement'}`,async t=>{
 const {runtime,engine}=fixture(t);runtime.register({id:'fixture',version:'1',proposal:true,description:'Generated product',execute:async()=>{throw Error('Product owns execution');}});
 runtime.registerCoordinator({id:'coordinator',awaitExternal:true,execute:async({controls})=>{if(!cancelAfterPlan){await controls.execute('delegation_submit',{units:[proposal('obsolete')]});await controls.execute('delegation_cancel',{unitId:'accepted-work:unit:obsolete'});}await controls.execute('delegation_submit',{units:[proposal('accepted')]});return 'Validated complete plan';},commit:owner=>({acceptedUnitIds:owner.units.filter(unit=>unit.status!=='cancelled').map(unit=>unit.id)})});
 runtime.start({id:'accepted-work',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});const planned=await runtime.waitForPlan('accepted-work');assert.equal(planned.status,'waiting');assert.deepEqual(planned.plannedUnitIds,['accepted-work:unit:accepted']);
 if(cancelAfterPlan){runtime.cancelUnit('accepted-work:unit:accepted');await runtime.tick();assert.equal(runtime.get('accepted-work').status,'failed');assert.equal(runtime.artifactMetadata('accepted-work').length,0);}
 else {engine.register({kind:'accepted-product',pool:'accepted-product',concurrency:()=>1,validate:()=>true,execute:async()=>({value:'Generated committed product'}),commit:(_step,product)=>runtime.recordExternalArtifact(planned.id,'accepted-work:unit:accepted',product as any)});const step=engine.enqueue('accepted-product','accepted-product',{});runtime.linkExternalUnit(planned.id,'accepted-work:unit:accepted',step);await engine.drain([step]);assert.equal((await settle(runtime,planned.id)).status,'succeeded');assert.equal(runtime.unit('accepted-work:unit:obsolete').status,'cancelled');assert.equal(runtime.artifactMetadata(planned.id).length,1);}
});

test('a product already failed before plan acceptance cannot be reported as a completed goal',async t=>{
 const {runtime,engine,store}=fixture(t);runtime.register({id:'fixture',version:'1',proposal:true,description:'Generated product',execute:async()=>({value:null})});
 runtime.registerCoordinator({id:'coordinator',awaitExternal:true,execute:async({controls})=>{await controls.execute('delegation_submit',{units:[proposal('failed')]});store.db.prepare("UPDATE delegation_units SET json=json_set(json,'$.status','failed','$.error','generated_product_failure') WHERE id='failed-at-plan:unit:failed'").run();return 'Plan receipt';},commit:owner=>({acceptedUnitIds:owner.units.map(unit=>unit.id)})});
 runtime.start({id:'failed-at-plan',profileId:'coordinator',goal:'Generated task',input:{},allowedCapabilities:['fixture']});await engine.drain(['failed-at-plan:coordinator:1']);const work=runtime.get('failed-at-plan');assert.equal(work.planningComplete,true);assert.equal(work.status,'failed');assert.deepEqual(work.plannedUnitIds,['failed-at-plan:unit:failed']);assert.equal(runtime.artifactMetadata(work.id).length,0);assert.ok(work.events.some(event=>event.type==='work.failed'));
});


test('private branch prose and replay metadata honor encryption and bulk key retirement',async t=>{
 const {runtime,store}=fixture(t,1,{contentEncryptionEnabled:true,dataKey:'a'.repeat(64)}),secret='Generated secret for encrypted delegation';
 runtime.register({id:'fixture',version:'1',description:'Generated fixture',execute:async()=>({value:{secret},summary:secret,coverage:{note:secret}})});
 runtime.registerCoordinator({id:'coordinator',execute:async({work,controls})=>{
  if(!work.units.length){await controls.execute('delegation_submit',{units:[{...proposal('a'),title:secret,goal:secret,input:{secret}}]});await controls.execute('delegation_yield',{message:secret});throw new AgentYieldError();}
  return {secret};
 }});runtime.start({id:'encrypted-work',profileId:'coordinator',goal:secret,input:{secret},allowedCapabilities:['fixture']});await settle(runtime,'encrypted-work');
 for(const table of ['delegation_works','delegation_units','delegation_artifacts','delegation_payloads','delegation_results','delegation_events'])assert.ok(!JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(secret),table+' stores no plaintext prose');
 assert.equal(runtime.get('encrypted-work').goal,secret);assert.equal(runtime.get('encrypted-work').units[0].input.secret,secret);assert.equal(runtime.artifactMetadata('encrypted-work')[0].summary,secret);
 store.contentEncryption.setEnabled(false);const objects=join(store.directory,'objects'),uploads=join(store.directory,'uploads');mkdirSync(objects);mkdirSync(uploads);
 const service=new ContentStorageService(store,{objects,uploads} as any,{directory:store.directory} as any);t.after(()=>service.close());service.start();for(let i=0;i<100&&service.snapshot().job.state==='running';i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(service.snapshot().job.state,'completed');assert.equal(service.snapshot().job.failed,0);
 assert.ok(JSON.stringify(store.db.prepare('SELECT * FROM delegation_payloads').all()).includes(secret));assert.equal(runtime.result<any>('encrypted-work').secret,secret);
 store.invalidateConversationAnswers();assert.equal(runtime.get('encrypted-work').goal,'');assert.deepEqual(runtime.get('encrypted-work').units[0].input,{});assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM delegation_units').all()).includes(secret));
});

test('artifact summaries stay behind dependency validation even when no original is requested',async t=>{
 const {store,engine}=fixture(t);let permitted=true;
 const runtime=new DelegationRuntime(store,engine,{autoPump:false,validateDependencies:ids=>{assert.deepEqual(ids,['generated-original']);if(!permitted)throw Error('Generated policy revoked');}});t.after(()=>runtime.close());
 runtime.register({id:'private',version:'1',description:'Generated private data',execute:async()=>({value:{private:'Generated private body'},summary:'Generated private summary',dependencyIds:['generated-original']})});
 runtime.registerCoordinator({id:'private',execute:async({work,controls})=>{if(!work.units.length){await controls.execute('delegation_submit',{units:[proposal('a','private')]});await controls.execute('delegation_yield',{});throw new AgentYieldError();}return 'Done';}});
 runtime.start({id:'private-work',profileId:'private',goal:'Generated task',input:{},allowedCapabilities:['private']});await settle(runtime,'private-work');store.db.prepare("UPDATE delegation_works SET json=json_set(json,'$.status','waiting') WHERE id='private-work'").run();const controls=runtime.controlChannel('private-work');
 const metadata=await controls.execute('delegation_results',{});assert.ok(!JSON.stringify(metadata.data).includes('Generated private summary'));permitted=false;
 await assert.rejects(controls.execute('delegation_read',{artifactId:runtime.get('private-work').units[0].artifactId,evidenceIds:[]}),/policy revoked/);
});


test('every durable host control contract compiles for the actual SDK and Codex adapters',()=>{for(const control of DELEGATION_CONTROL_DEFINITIONS)assert.doesNotThrow(()=>parameterSchemaSpecToJsonSchema(control.fields as any),control.name);});


test('older pending external work completes behind more than one history page and remains addressable',async t=>{
 const {runtime,engine,store}=fixture(t);let publish=false;
 runtime.register({id:'fixture',version:'1',proposal:true,description:'Generated package',execute:async()=>({value:null})});runtime.registerCoordinator({id:'external',awaitExternal:true,execute:async({controls})=>{await controls.execute('delegation_submit',{units:[proposal('a')]});return 'planned';}});
 runtime.registerCoordinator({id:'history',execute:async()=>null});runtime.start({id:'older-active',profileId:'external',goal:'Generated older task',input:{},allowedCapabilities:['fixture']});const planned=await runtime.waitForPlan('older-active');
 engine.register({kind:'older-external',pool:'generated-external',concurrency:()=>1,validate:()=>true,admit:()=>publish?undefined:new ExecutionFailure('waiting','generated_wait',1),execute:async()=>({value:'generated complete'}),commit:(_step,result)=>runtime.recordExternalArtifact('older-active',planned.units[0].id,result as any)});const stepId=engine.enqueue('older-product','older-external',{});runtime.linkExternalUnit('older-active',planned.units[0].id,stepId);
 for(let i=0;i<105;i++){const id='generated-history-'+i;runtime.start({id,profileId:'history',goal:'Generated history',input:{},allowedCapabilities:[]});store.db.prepare("UPDATE delegation_works SET json=json_set(json,'$.status','succeeded') WHERE id=?").run(id);engine.cancel(id);}
 assert.ok(!runtime.list().some(work=>work.id==='older-active'));const first=runtime.page({limit:100}),second=runtime.page({cursor:first.nextCursor!,limit:100});assert.ok(second.items.some(work=>work.id==='older-active'));
 publish=true;await new Promise(resolve=>setTimeout(resolve,2));await runtime.tick();await runtime.tick();assert.equal(runtime.get('older-active').status,'succeeded');assert.equal(runtime.artifactMetadata('older-active').length,1);
});

test('cancellation revokes every coordinator beyond a hundred-step operation page',async t=>{
 const {runtime,engine}=fixture(t);let release!:()=>void,enter!:()=>void;const held=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>enter=resolve);runtime.registerCoordinator({id:'held',execute:async()=>{enter();await held;return 'late';}});runtime.start({id:'many-step-work',profileId:'held',goal:'Generated task',input:{},allowedCapabilities:[]});await entered;
 engine.register({kind:'many-history',pool:'many-history',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});for(let i=0;i<110;i++)engine.enqueue('many-step-work','many-history',{i},{id:'many-history-'+i});
 runtime.cancel('many-step-work');assert.equal(engine.get('many-step-work:coordinator:1')?.state,'cancelled');assert.equal(engine.cancellationAliasRevoked('many-step-work'),true);assert.equal(runtime.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id='many-step-work' AND state IN ('waiting','running','blocked')").get()?.n,0);release();await engine.drain(['many-step-work:coordinator:1']);assert.equal(runtime.result('many-step-work'),undefined);
});


test('private durable payload history consumes the vault quota and a refused start rolls back',async t=>{
 const {runtime,store}=fixture(t,1,{maxStorageBytes:80000});runtime.registerCoordinator({id:'quota',execute:async()=>null});const initial=store.logicalBytes();runtime.start({id:'quota-one',profileId:'quota',goal:'Generated task',input:{generated:'x'.repeat(24000)},allowedCapabilities:[]});assert.ok(store.logicalBytes()>=initial+24000);runtime.start({id:'quota-two',profileId:'quota',goal:'Generated task',input:{generated:'x'.repeat(24000)},allowedCapabilities:[]});assert.throws(()=>runtime.start({id:'quota-refused',profileId:'quota',goal:'Generated task',input:{generated:'x'.repeat(40000)},allowedCapabilities:[]}),/storage limit/);assert.throws(()=>runtime.get('quota-refused'),/not found/);assert.equal(store.db.prepare("SELECT count(*) n FROM delegation_payloads WHERE work_id='quota-refused'").get()?.n,0);
});
