import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uiPageText,type UiPageV2} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/config.js';
import type {MaterialMemoryObservation} from '../src/material-memory-work.js';

const at=(second:number)=>new Date(Date.parse('2026-10-10T00:00:00Z')+second*1000).toISOString();
const token='generated-backfill-owner-token-000000';
const headers={authorization:`Bearer ${token}`};
const agent={configured:false,query:async()=>{throw Error('No live model in generated fixtures');},close:async()=>{}};
function config(dataDir:string):Config{return {dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,dataKey:'32'.repeat(32),maxStorageBytes:30_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};}
function record(source:'screen'|'ui_page',second:number){
  const page:UiPageV2={version:2,scope:'visible_window',adapterId:'generated.fields',adapterVersion:'1',appVersion:'1',activity:'fixture.ArticleActivity',status:'ok',truncated:false,
    observations:{firstAt:at(second),lastAt:at(second),count:1},objects:[{kind:'article',title:'Generated article',body:[{text:'Generated retained paragraph'}],
      url:'https://fixture.invalid/article/1',identity:{type:'url',value:'https://fixture.invalid/article/1'}}]};
  return {id:randomUUID(),deviceId:'fixture-backfill-phone',deviceName:'Generated phone',platform:'android',source,appId:'fixture.app',appName:'Generated App',capturedAt:at(second),durationMs:0,
    ocrText:source==='ui_page'?uiPageText(page):'Generated screenshot transcription',privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},
    ...(source==='ui_page'?{metadata:{version:1,observedAt:at(second),collector:{method:'accessibility'},uiPage:page}}:{})};
}

test('durable screen version upgrade and field-page backfill preserve rebuild status; new intake remains a source change',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-field-backfill-')),settings=config(directory);
  let application:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{await application?.app.close();rmSync(directory,{recursive:true,force:true});});
  application=await buildApp(settings,{agent,backgroundWorker:false});
  const observe=(runtime:Awaited<ReturnType<typeof buildApp>>)=>{
    const changes:{kind:string;change:MaterialMemoryObservation['change']}[]=[];
    const original=runtime.materialMemoryWork.observe.bind(runtime.materialMemoryWork);
    runtime.materialMemoryWork.observe=(id,required,observation,settle)=>{
      changes.push({kind:runtime.materials.get(id)!.kind,change:observation.change});
      original(id,required,observation,settle);
    };
    return changes;
  };
  const initial=observe(application);
  for(const source of ['screen','ui_page'] as const){
    const response=await application.app.inject({method:'POST',url:'/api/captures',headers,payload:record(source,0)});
    assert.equal(response.statusCode,201,response.body);
  }
  await application.materialOrganizer.tick(100);
  assert.deepEqual(initial.map(item=>item.change).sort(),['source','source']);
  await application.app.close();application=undefined;

  // Persist prior organizer versions, then reopen through the product startup path.
  // No new captures or raw receipts are issued by this deterministic migration.
  const previous=new Store(directory);
  previous.db.prepare("UPDATE material_organizer_backfills SET version='3' WHERE organizer_id='mote.screen-segment'").run();
  previous.db.prepare("UPDATE material_organizer_groups SET version='3' WHERE organizer_id='mote.screen-segment'").run();
  previous.db.prepare("UPDATE material_organizer_backfills SET version='0' WHERE organizer_id='mote.ui-page-object'").run();
  previous.db.prepare("UPDATE material_organizer_groups SET version='0' WHERE organizer_id='mote.ui-page-object'").run();
  previous.close();

  application=await buildApp(settings,{agent,backgroundWorker:false});
  const rebuilt=observe(application);
  for(let pass=0;pass<10&&application.materialOrganizer.status().backfills.some(item=>!item.complete);pass++)await application.materialOrganizer.tick(100);
  assert.ok(application.materialOrganizer.status().backfills.every(item=>item.complete));
  assert.deepEqual([...new Set(rebuilt.map(item=>item.kind))].sort(),['mote.screen-segment','mote.ui-page-object']);
  assert.ok(rebuilt.every(item=>item.change==='rebuild'),'every repeated backfill publication remains deterministic rebuilding');
  assert.equal(application.store.db.prepare('SELECT count(*) AS n FROM memory_input_authorizations').get()?.n,0,'backfill cannot mint automatic raw receipts');
  assert.equal(application.store.db.prepare('SELECT count(*) AS n FROM material_memory_requests WHERE auto_authorized=1').get()?.n,0);

  rebuilt.length=0;
  for(const source of ['screen','ui_page'] as const){
    const response=await application.app.inject({method:'POST',url:'/api/captures',headers,payload:record(source,30)});
    assert.equal(response.statusCode,201,response.body);
  }
  await application.materialOrganizer.tick(100);
  assert.deepEqual(rebuilt.map(item=>item.change).sort(),['source','source']);
});

test('legacy queued pages and field pages share the mechanical window group but retain separate materials',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-field-legacy-group-'));
  const runtime=await buildApp(config(directory),{agent,backgroundWorker:false});
  t.after(async()=>{await runtime.app.close();rmSync(directory,{recursive:true,force:true});});
  const current=record('ui_page',30),generatedLegacy=record('ui_page',0);
  const legacy={...generatedLegacy,ocrText:'Generated legacy selected-node original',metadata:{version:1,observedAt:at(0),collector:{method:'accessibility'},uiPage:{
    version:1,scope:'visible_window',adapterId:'generated.legacy',adapterVersion:'1',appVersion:'1',activity:'fixture.ArticleActivity',status:'partial',truncated:false,
    nodes:[{id:'fixture-title',resourceId:'fixture:id/title',role:'android.widget.TextView',text:'Generated legacy selected-node original',bounds:{x:0,y:0,width:100,height:40}}],
  }}};
  for(const payload of [legacy,current]){
    const response=await runtime.app.inject({method:'POST',url:'/api/captures',headers,payload});
    assert.equal(response.statusCode,201,response.body);
  }
  const groups=runtime.store.db.prepare('SELECT group_key FROM context_observations WHERE id IN (?,?)').all(legacy.id,current.id);
  assert.equal(groups.length,2);assert.equal(groups[0]?.group_key,groups[1]?.group_key,'fixture exercises the same UI-page five-minute group');
  await runtime.materialOrganizer.tick(100);
  const screen=runtime.materials.list({kind:'mote.screen-segment'}).items[0]!,field=runtime.materials.list({kind:'mote.ui-page-object'}).items[0]!;
  assert.ok(screen);assert.ok(field);
  assert.deepEqual(runtime.materials.members(screen.id).items.map(item=>item.id),[legacy.id]);
  assert.deepEqual(runtime.materials.members(field.id).items.map(item=>item.id),[current.id]);
  assert.match(runtime.materials.read(screen.id).text,/Generated legacy selected-node original/);
  assert.doesNotMatch(runtime.materials.read(screen.id).text,/Generated retained paragraph/,'field originals never enter compressed legacy screen materials');
  assert.match(runtime.materials.read(field.id).text,/Generated retained paragraph/);
});

test('a long repeated article group keeps newest bounded material text while every original remains pageable',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-field-text-budget-'));
  const runtime=await buildApp({...config(directory),maxStorageBytes:100_000_000},{agent,backgroundWorker:false});
  t.after(async()=>{await runtime.app.close();rmSync(directory,{recursive:true,force:true});});
  const originals:ReturnType<typeof record>[]=[];
  for(let index=0;index<80;index++){
    const value=record('ui_page',index),page=value.metadata!.uiPage;
    page.objects[0]!.body=Array.from({length:3},(_,paragraph)=>({text:`Generated observation ${index}, paragraph ${paragraph}. `.padEnd(21000,'x')}));
    value.ocrText=uiPageText(page);
    originals.push(value);
    const response=await runtime.app.inject({method:'POST',url:'/api/captures',headers,payload:value});
    assert.equal(response.statusCode,201,response.body);
  }
  await runtime.materialOrganizer.tick(100);
  const material=runtime.materials.list({kind:'mote.ui-page-object'}).items[0]!;
  assert.ok(material);assert.equal(material.coverage.state,'partial');assert.equal(material.coverage.reason,'ui_page_group_limit');
  assert.ok(material.memberCount>0&&material.memberCount<originals.length);
  const members=runtime.materials.members(material.id,{limit:200}).items.map(item=>item.id);
  assert.ok(members.includes(originals.at(-1)!.id),'newest full original participates');
  assert.ok(!members.includes(originals[0]!.id),'older originals remain outside the bounded material');
  let text='',offset=0;
  do{const page=runtime.materials.read(material.id,{offset,length:12000});text+=page.text;offset=page.textRange.nextOffset??-1;}while(offset>=0);
  assert.ok(text.length<=4_000_000);assert.match(text,/Generated observation 79, paragraph 2\./);
  assert.equal(runtime.store.db.prepare("SELECT count(*) AS n FROM captures WHERE json_extract(json,'$.source')='ui_page'").get()?.n,80);
  for(const value of [originals[0]!,originals.at(-1)!]){
    const response=await runtime.app.inject({url:`/api/capture-browser/${value.id}`,headers});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().ocrText,value.ocrText);
  }
});
