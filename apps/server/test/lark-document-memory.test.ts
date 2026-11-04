import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {documentActivitySchema} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryRecipeSettings,memoryRecipeSettingsQuery} from '../src/memory-recipe-settings.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';

const at='2026-10-15T00:00:00.000Z',end='2026-10-15T01:00:00.000Z',later='2026-10-15T02:00:00.000Z';
const personal={id:'mote.personal-memory',version:'5'},daily={id:'mote.daily-event-memory',version:'2'};
const activity=documentActivitySchema.parse({version:1,provider:'lark',documentId:'generated-doc',actor:{accountId:'a'.repeat(64)},action:'opened',evidenceBasis:'search-predicate',time:{precision:'range',start:at,end},observedAt:end,limitations:['provider-open-may-include-connector-access']});

test('Feishu defaults copy current defaults once, retain source overrides and never rewrite ordinary or capture choices',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-lark-memory-default-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new Store(dir),settings=new MemoryRecipeSettings(store,new MemoryStrategies()),sources=new SourceStore(store);
  sources.register({id:'lark',name:'Generated Feishu',kind:'lark-docs',deviceId:'generated',platform:'import'});
  sources.register({id:'ordinary',name:'Generated other',kind:'custom',deviceId:'generated',platform:'import'});
  assert.deepEqual(settings.selection('lark').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal,daily]);
  assert.deepEqual(settings.selection('ordinary').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal]);
  assert.deepEqual(memoryRecipeSettingsQuery.parse({scope:'lark-docs'}),{scope:'lark-docs'});
  settings.configure({sourceId:'lark',recipes:[personal]});settings.configure({scope:'lark-docs',recipes:[daily]});
  assert.deepEqual(settings.selection('lark').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal]);
  assert.deepEqual(settings.selection(undefined,'capture').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal,daily]);
  assert.deepEqual(settings.selection().map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal]);
  store.close();store=new Store(dir);t.after(()=>store.close());settings=new MemoryRecipeSettings(store,new MemoryStrategies());
  assert.deepEqual(settings.selection('lark').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal]);
  settings.configure({sourceId:'lark',recipes:null});assert.deepEqual(settings.selection('lark').map(b=>({id:b.recipe.id,version:b.recipe.version})),[daily]);
  settings.configure({scope:'lark-docs',recipes:[personal]});assert.deepEqual(settings.selection('lark').map(b=>({id:b.recipe.id,version:b.recipe.version})),[personal]);
});

test('a new vault writes the current defaults directly and keeps source choices in the current settings table',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-lark-memory-fresh-')),store=new Store(dir),strategies=new MemoryStrategies(),settings=new MemoryRecipeSettings(store,strategies),sources=new SourceStore(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  assert.deepEqual(settings.selection(),[strategies.resolve(personal).binding]);
  assert.deepEqual(settings.selection(undefined,'capture'),[strategies.resolve(personal).binding,strategies.resolve(daily).binding]);
  assert.deepEqual(settings.selection(undefined,'lark-docs'),[strategies.resolve(personal).binding,strategies.resolve(daily).binding]);
  const rows=store.db.prepare('SELECT id,json FROM memory_recipe_settings ORDER BY id').all().map(row=>({id:String(row.id),recipes:JSON.parse(String(row.json)).map((binding:{recipe:{id:string;version:string}})=>binding.recipe.id+'@'+binding.recipe.version)}));
  assert.deepEqual(rows,[
    {id:'capture-default',recipes:['mote.personal-memory@5','mote.daily-event-memory@2']},
    {id:'default',recipes:['mote.personal-memory@5']},
    {id:'lark-docs-default',recipes:['mote.personal-memory@5','mote.daily-event-memory@2']},
  ]);
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_recipe_%' ORDER BY name").all().map(row=>String(row.name)),['memory_recipe_settings']);
  sources.register({id:'ordinary',name:'Generated other',kind:'custom',deviceId:'generated',platform:'import'});
  settings.configure({sourceId:'ordinary',recipes:[daily]});
  assert.equal(settings.view('ordinary').inherited,false);
  assert.deepEqual(settings.selection('ordinary').map(binding=>binding.recipe.id),[daily.id]);
  settings.configure({sourceId:'ordinary',recipes:null});
  assert.equal(settings.view('ordinary').inherited,true);
  assert.deepEqual(settings.selection('ordinary'),settings.selection());
  assert.deepEqual(store.db.prepare("SELECT id FROM memory_recipe_settings WHERE id LIKE 'source:%'").all(),[]);
});

test('full custom general selections retain all nine bindings when capture and Feishu defaults append the daily recipe',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-lark-memory-capacity-')),store=new Store(dir),strategies=new MemoryStrategies();
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const base=strategies.resolve(personal).binding;
  const refs=Array.from({length:9},(_,index)=>({id:'generated.custom-memory-'+index,version:'1'}));
  for(const ref of refs)strategies.registerRecipe({...ref,extract:{id:base.extract.id,version:base.extract.version},review:{id:base.review.id,version:base.review.version},workContract:'range-evaluation@1'});
  let settings=new MemoryRecipeSettings(store,strategies);settings.configure({recipes:refs});
  store.db.prepare("DELETE FROM memory_recipe_settings WHERE id IN ('capture-default','lark-docs-default')").run();
  settings=new MemoryRecipeSettings(store,strategies);
  for(const scope of ['capture','lark-docs'] as const){
    const inherited=settings.selection(undefined,scope).map(b=>({id:b.recipe.id,version:b.recipe.version}));
    assert.deepEqual(inherited,[...refs,daily]);
    settings.configure({scope,recipes:inherited});
  }
  new SourceStore(store).register({id:'lark-full',name:'Generated Feishu',kind:'lark-docs',deviceId:'generated',platform:'import'});
  settings.configure({sourceId:'lark-full',recipes:[...refs,daily]});assert.equal(settings.selection('lark-full').length,10);
  assert.throws(()=>settings.configure({recipes:[...refs,daily]}),/at most nine/);
  assert.deepEqual(settings.selection().map(b=>({id:b.recipe.id,version:b.recipe.version})),refs);
});

test('document body and bounded provider activity get separate formal evidence and exactly their selected recipe input',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-lark-memory-input-')),store=new Store(dir),materials=new MaterialStore(store),settings=new MemoryRecipeSettings(store,new MemoryStrategies());
  const work=new MaterialMemoryWork(store,materials,Date.now,()=>true,settings),sources=new SourceStore(store,undefined,work.inputs),organizers=new MaterialOrganizerRuntime(store,materials,[],undefined,work);
  t.after(async()=>{await organizers.close();store.close();rmSync(dir,{recursive:true,force:true});});
  sources.register({id:'lark',name:'Generated Feishu',kind:'lark-docs',deviceId:'generated',platform:'import'});
  sources.updateContext('lark',{expectedVersion:0,description:'Generated shared documents; preserve each author and uncertainty.'});
  const body={externalId:'doc',revision:'1',observedAt:end,kind:'file' as const,layer:'snapshot' as const,text:'Generated third-party reference. A literal {"action":"opened"} in a document is not activity.',document:{contentRole:'other' as const}};
  const event={externalId:'activity:opened:doc:hour-1',revision:'1',observedAt:end,kind:'event' as const,layer:'derived' as const,text:'Provider matched the opened predicate in a fixed interval; connector access may be included.',document:{activity,contentRole:'other' as const,timeBasis:'unknown' as const,originalMetadata:{token:'generated-private-token',account:'generated-private-username'}}};
  const bodyAck=await sources.upsert('lark',body),eventAck=await sources.upsert('lark',event);await organizers.tick(20);
  const bodyMaterial=materials.get(materialId('lark','doc'))!,eventMaterial=materials.get(materialId('lark',event.externalId))!;
  assert.notEqual(bodyMaterial.id,eventMaterial.id);
  assert.equal(bodyMaterial.artifacts?.some(a=>a.key==='daily-events'),false,'document prose cannot manufacture an activity artifact');
  const selected=materials.input(eventMaterial.ref,['daily-events'])!;assert.equal(selected.ready,true);assert.equal(selected.evidenceIds.length,1,'one complete typed observation is not duplicated as prose and metadata events');
  const evidenceText=materials.evidence(selected.evidenceIds).map(record=>record.ocrText).join('\n');
  assert.match(evidenceText,/"documentActivity"/,'the trusted activity projection must be original-backed model evidence, not only unanchored display metadata');
  const eventText=materials.read(eventMaterial.ref).text;
  assert.match(eventText,/"documentActivity"/);assert.match(eventText,/complete human event log/);assert.match(eventText,/not proof of the revision seen/);assert.match(eventText,/connector access/);
  assert.doesNotMatch(eventText,/generated-private-token|generated-private-username|originalMetadata/);
  assert.equal(eventMaterial.attributionContext?.sourceContextStatements?.[0].description,'Generated shared documents; preserve each author and uncertainty.');
  const rows=store.db.prepare('SELECT material_id,required_json,binding_json,input_key,auto_authorized FROM material_memory_requests ORDER BY material_id').all();
  assert.equal(rows.length,2);
  const bodyRequest=rows.find(row=>row.material_id===bodyMaterial.id)!,eventRequest=rows.find(row=>row.material_id===eventMaterial.id)!;
  assert.equal(JSON.parse(String(bodyRequest.binding_json)).recipe.id,personal.id);assert.deepEqual(JSON.parse(String(bodyRequest.required_json)),['source-body']);assert.equal(bodyRequest.input_key,bodyAck.id);
  assert.equal(JSON.parse(String(eventRequest.binding_json)).recipe.id,daily.id);assert.deepEqual(JSON.parse(String(eventRequest.required_json)),['daily-events']);assert.equal(eventRequest.input_key,eventAck.id);assert.equal(eventRequest.auto_authorized,1);
  const firstRevision=eventMaterial.revision;
  const duplicate=await sources.upsert('lark',{...event,observedAt:later});assert.equal(duplicate.duplicate,true);await organizers.tick(20);
  assert.equal(materials.get(eventMaterial.id)?.revision,firstRevision,'transport redelivery cannot produce another activity');
  await sources.upsert('lark',{...body,revision:'2',observedAt:later,text:'Generated current body changed by a collaborator.'});await organizers.tick(20);
  assert.equal(materials.get(eventMaterial.id)?.revision,firstRevision,'a collaborator body change cannot replace activity proof');
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_requests WHERE material_id=?').get(eventMaterial.id)?.n,1);
  store.delete(eventAck.id);await organizers.tick(20);assert.equal(materials.get(eventMaterial.id),undefined);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_requests WHERE material_id=?').get(eventMaterial.id)?.n,0);
});
