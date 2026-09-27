import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {materialSourcePin,materialSourceCurrent} from '../src/material-source-pin.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';

async function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'mote-manual-selection-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const at='2026-09-20T00:00:00.000Z',id=(await sources.upsert('generated',{externalId:'note',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated note with an unfinished transcript.'})).id;
  const draft:MaterialDraft={id:materialId('generated','note'),kind:'mote.message',schemaVersion:1,title:'Generated composed note',
    origin:{sourceId:'generated',externalId:'note',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated note.',memberIds:[id]}],members:[{id,kind:'capture',ref:'capture:'+id}],
    coverage:{state:'pending'},artifacts:[{key:'source-body',state:'ready',blockIds:['body']},{key:'transcript',state:'pending'}],
    fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
  const material=materials.publish(draft),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),strategies=new MemoryStrategies();
  const bindings=[{...strategies.resolve({id:'mote.personal-memory',version:'2'}).binding,requires:['source-body']},{...strategies.resolve({id:'mote.coding-memory',version:'2'}).binding,requires:['transcript']}];
  return {store,sources,materials,reader,at,id,draft,material,bindings};
}

test('manual range keeps independently pending plans while exact IDs keep their original allow list',async t=>{
  const f=await fixture(t),scope={deviceId:'generated-device'};
  const selected=f.reader.memoryPlanSelection(scope,f.bindings);
  assert.equal(selected.manualPlans.length,2);assert.deepEqual(selected.evidenceIds,[]);
  assert.deepEqual(selected.manualPlans.map(p=>p.required),[['source-body'],['transcript']]);
  assert.equal(selected.manualPlans.every(p=>p.sourcePin.kind==='source-item'&&p.sourcePin.captureId===f.id),true);
  const anchor=f.materials.input(f.material.ref,['source-body'])!.evidenceIds[0];
  const exact=f.reader.memoryPlanSelection(scope,f.bindings,undefined,[anchor]);
  assert.equal(exact.manualPlans.length,2);assert.equal(exact.manualPlans.every(p=>p.evidenceAllowList?.length===1&&p.evidenceAllowList[0]===anchor),true);
  assert.equal(f.reader.memoryPlanSelection({deviceId:'another-device'},f.bindings).manualPlans.length,0);
});

test('source pin permits derived readiness but rejects a replacement original before reconstruction',async t=>{
  const f=await fixture(t),pin=materialSourcePin(f.store,f.materials,f.material);
  const next=f.materials.publish({...f.draft,blocks:[...f.draft.blocks,{id:'speech',kind:'text',format:'transcript',text:'Generated completed speech.',memberIds:[f.id]}],coverage:{state:'complete'},artifacts:[f.draft.artifacts![0],{key:'transcript',state:'ready',blockIds:['speech']}]},{expectedRevision:f.material.revision});
  assert.notEqual(next.ref,f.material.ref);assert.equal(materialSourceCurrent(f.store,f.materials,pin,f.material.id),true);
  await f.sources.upsert('generated',{externalId:'note',revision:'2',observedAt:f.at,kind:'message',layer:'original',text:'A newly edited original must not enter the waiting selection.'});
  assert.equal(materialSourceCurrent(f.store,f.materials,pin,f.material.id),false);
});

test('unknown organizer cannot infer original continuity across Material revisions',async t=>{
  const f=await fixture(t),draft={...f.draft,id:materialId('generated','custom'),origin:{...f.draft.origin,externalId:'custom'}};
  const material=f.materials.publish(draft),pin=materialSourcePin(f.store,f.materials,material);
  assert.equal(pin.kind,'material-revision');assert.equal(materialSourceCurrent(f.store,f.materials,pin,material.id),true);
  f.materials.publish({...draft,title:'A new custom revision'},{expectedRevision:material.revision});
  assert.equal(materialSourceCurrent(f.store,f.materials,pin,material.id),false);
});

test('archive-backed selection pins original group contents before a late event is organized',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-manual-archive-')),store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
  await runtime.ready;const sources=new SourceStore(store,runtime);
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  const event=(i:number)=>({externalId:'event-'+i,revision:'1',observedAt:'2026-09-20T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated engineering observation '+i,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:String(i),role:'user',part:0,parts:1}}});
  await sources.upsert('coding',event(1));await runtime.tick();
  const material=materials.list().items[0],pin=materialSourcePin(store,materials,material,runtime.archive);
  assert.equal(pin.kind,'archive-group');assert.equal(materialSourceCurrent(store,materials,pin,material.id,runtime.archive),true);
  await sources.upsert('coding',event(2));
  assert.equal(materials.get(material.id)!.ref,material.ref,'new event has not been organized yet');
  assert.equal(materialSourceCurrent(store,materials,pin,material.id,runtime.archive),false);
  await runtime.tick();assert.equal(materialSourceCurrent(store,materials,pin,material.id,runtime.archive),false);
});
