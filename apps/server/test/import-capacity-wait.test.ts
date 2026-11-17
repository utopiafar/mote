import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure} from '@mote/shared';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportStore,type ImportRuntime} from '../src/imports.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {ProviderAdmission} from '../src/provider-admission.js';

const settings={protocol:'openai-completions' as const,provider:'custom',baseUrl:'http://127.0.0.1:1/v1',apiKey:'generated-unused',headers:{}};

test('archived import resumes confirmed capacity waits across prepare/commit restart without redoing published records',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const directory=mkdtempSync(join(tmpdir(),'mote-import-capacity-')),store=new Store(directory),files=new ArchivedFileStore(store),sources=new SourceStore(store),admission=new ProviderAdmission(store);let parses=0,notifications=0;
 const instances:{imports:ImportStore;engine:ExecutionEngine}[]=[];
 const runtime:ImportRuntime={prepare:async({workspace,inputPaths})=>{admission.check(settings);parses++;writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:{externalId:'generated-record',revision:'1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'Generated original',text:'Generated import evidence'},evidencePaths:[inputPaths[0]],attachments:[]})+'\n');return {summary:'Generated preview'};},onImported:async()=>{admission.check(settings);notifications++;return {};}};
 const open=()=>{const engine=new ExecutionEngine(store),imports=new ImportStore(store,files,sources,{...runtime,executor:engine});instances.push({imports,engine});return {imports,engine};};
 const close=async(instance:ReturnType<typeof open>)=>{await instance.engine.close();await instance.imports.stop();};
 t.after(async()=>{for(const instance of instances)await close(instance);store.close();rmSync(directory,{recursive:true,force:true});});
 const cool=async()=>{await assert.rejects(admission.run(settings,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false,retryAfterMs:5000});}));};
 const settled=async(engine:ExecutionEngine,kind:string)=>{const ids=engine.list({kind}).items.map(step=>step.id);assert.equal(ids.length,1);await engine.drain(ids);return engine.get(ids[0])!;};
 const waiting=async(engine:ExecutionEngine,kind:string)=>{const step=await settled(engine,kind);assert.equal(step.state,'waiting','Import persists its confirmed resource wait after the admitted execution settles');assert.equal(step.error,'rate_limited');return step;};
 let current=open();const job=await current.imports.create({instruction:'Generated parser fixture',files:[{name:'generated.custom',dataBase64:Buffer.from('Generated archived bytes').toString('base64')}]});
 await cool();const preparing=current.imports.prepare(job.id);const prepareWait=await waiting(current.engine,'imports.prepare');
 assert.equal(prepareWait.attempts,0);assert.equal(parses,0);assert.equal(current.imports.get(job.id).status,'queued');assert.equal(current.imports.get(job.id).execution?.status,'retry_wait');
 assert.equal(current.imports.get(job.id).execution?.failure?.retryAfterMs,5000);assert.equal(files.read(job.files[0].id).toString(),'Generated archived bytes');
 await close(current);await preparing;current=open();assert.equal((await current.imports.prepare(job.id)).status,'queued','startup observes the already scheduled wait');await current.engine.tick();assert.equal(parses,0,'restart retains the resource wait');
 t.mock.timers.tick(5001);await current.engine.tick();await settled(current.engine,'imports.prepare');assert.equal(current.imports.get(job.id).status,'awaiting_confirmation');assert.equal(parses,1);
 await cool();const committing=current.imports.confirm(job.id);const commitWait=await waiting(current.engine,'imports.commit');
 assert.equal(commitWait.attempts,0);assert.equal(current.imports.get(job.id).status,'importing');assert.equal(store.list().items.length,1);assert.equal(notifications,0);
 await close(current);await committing;current=open();await current.engine.tick();assert.equal(notifications,0);assert.equal(parses,1);
 t.mock.timers.tick(5001);await current.engine.tick();await settled(current.engine,'imports.commit');const completed=current.imports.get(job.id);
 assert.equal(completed.status,'completed');assert.equal(completed.progress.imported,1);assert.equal(completed.progress.duplicates,0);assert.equal(store.list().items.length,1);assert.equal(parses,1);assert.equal(notifications,1);
});

test('an ambiguous issued import failure remains terminal instead of taking known-not-started capacity recovery',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-unknown-')),store=new Store(directory),files=new ArchivedFileStore(store),sources=new SourceStore(store),engine=new ExecutionEngine(store);let calls=0;
 const imports=new ImportStore(store,files,sources,{executor:engine,prepare:async()=>{calls++;throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:1000});}});
 t.after(async()=>{await engine.close();await imports.stop();store.close();rmSync(directory,{recursive:true,force:true});});
 const job=await imports.create({files:[{name:'generated.custom',dataBase64:Buffer.from('Generated original').toString('base64')}]});
 assert.equal((await imports.prepare(job.id)).status,'failed');await engine.tick();assert.equal(calls,1);assert.equal(imports.get(job.id).execution?.status,'failed');
});
