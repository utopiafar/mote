import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
import sharp from 'sharp';
import type {ImportJob} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,StoreError,sha256} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {SourceStore} from '../src/sources.js';
import {ImportStore} from '../src/imports.js';
import {ServerFeatureScope} from '../src/feature-host.js';
import {materialId} from '../src/materials.js';
import {ImportIntakeRegistry,installImportIntake} from '../src/import-intake.js';
import {FileRecipeRegistry,FileOutputRegistry,installFileRecipes} from '../src/file-recipes.js';

async function fixture(t:import('node:test').TestContext,modules:string[]=[],seed?:(directory:string)=>Promise<void>){
  // Advance durable workers explicitly, so wall-clock load cannot race assertions.
  t.mock.method(ServerFeatureScope.prototype,'every',()=>{});
  const directory=mkdtempSync(join(tmpdir(),'mote-media-import-'));
  await seed?.(directory);
  const config:Config={dataDir:directory,token:'generated-media-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,backendPluginModules:modules};
  const calls:string[]=[],modelCalls:string[]=[],failed=new Set<string>();
  let node:Awaited<ReturnType<typeof buildApp>>;
  const start=async()=>{
    node=await buildApp(config,{backgroundWorker:false,transcriptionProvider:{transcribe:async input=>{
      const parts:Buffer[]=[];for await(const part of input.body)parts.push(part);const key=Buffer.concat(parts).toString();calls.push(key);
      if(failed.has(key))throw new StoreError('Generated unsupported response',422);
      return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated participant described a plan; its outcome is unknown.'}]};
    }},agent:{configured:true,close:async()=>{},query:async input=>{
      modelCalls.push(input.traceContext?.phase??'query');const evidence=node.memories.readEvidence(input.evidenceIds!)[0];
      return {answer:JSON.stringify({memories:[]}),citations:evidence?[{id:evidence.id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}]:[],trace:[],runId:'generated-media-model'};
    }}});await node.app.ready();
  };
  await start();node.processing.update({revision:node.processing.view().revision,settings:{...node.processing.view().settings,enabled:true,audioProcessor:'audio.http',summarize:false}});
  const headers={authorization:'Bearer '+config.token};
  const create=async(files:{name:string;dataBase64:string}[],processing:'automatic'|'preview'='automatic')=>{
    const result=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files,processing}});assert.equal(result.statusCode,202,result.body);let job=result.json<ImportJob>();
    for(let attempt=0;attempt<500&&['queued','preparing','importing'].includes(job.status);attempt++){await new Promise(r=>setTimeout(r,10));job=node.imports.get(job.id);}
    return job;
  };
  const organize=async()=>{for(let attempt=0;attempt<20;attempt++)if(await node.materialOrganizer.tick(200)===0)return;throw Error('Generated organizer did not settle');};
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  return {get node(){return node;},calls,modelCalls,failed,create,organize,headers,async restart(){await node.app.close();await start();}};
}
const entry=(name:string,bytes:Buffer|string)=>({name,dataBase64:Buffer.from(bytes).toString('base64')});

test('61 generated MP3 container members use the Android file pipeline without model import or invented dates',async t=>{
  const f=await fixture(t),zip=Buffer.from(zipSync(Object.fromEntries(Array.from({length:61},(_,i)=>[`2020-01-01-call-${i}.mp3`,Buffer.from('ID3-generated-'+i)]))));
  const job=await f.create([entry('calls.zip',zip)]);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.files.length,62);assert.equal(job.media?.length,61);
  assert.equal(job.dispositions?.counts.processing,61);assert.equal(job.dispositions?.counts.container,1);assert.equal(job.dispositions?.counts.parsed,0);
  assert.equal(job.progress.imported,61);assert.equal(f.calls.length,0);assert.equal(f.modelCalls.length,0);
  assert.ok(job.media!.every(item=>item.format.mimeType==='audio/mpeg'&&!item.searchable&&item.processing?.state==='waiting'));
  for(const item of job.media!){const record=f.node.files.detail(item.captureId!).item;assert.equal(record.observedAt,job.createdAt);assert.equal(record.document?.recordedAt,undefined);assert.equal(record.document?.occurredAt,undefined);}
  await f.organize();f.node.sourcePipelines.drainMemory(f.node.memoryPipeline,true,100);assert.equal(f.node.memoryPipeline.list().length,0,'Memory waits for extracted text');
  await f.node.processing.tick();await f.organize();const ready=f.node.imports.get(job.id);assert.equal(f.calls.length,61);assert.ok(ready.media!.every(item=>item.searchable&&item.processing?.state==='succeeded'));
  assert.equal(f.node.files.search({query:'Generated participant',limit:100}).length,61);
  const imported=job.media![0].captureId!,receipt=f.node.processing.explain(imported).snapshots[0] as any;assert.equal(receipt.recipe.id,'mote.file-extraction');assert.equal(receipt.stagePins[0].id,'mote.extract');
  const before=f.calls.length;const duplicate=await f.create([entry('calls.zip',zip)]);assert.equal(duplicate.progress.duplicates,61);assert.deepEqual(duplicate.media!.map(item=>item.captureId),job.media!.map(item=>item.captureId));await f.node.processing.tick();assert.equal(f.calls.length,before);
  await f.restart();await f.node.processing.tick();assert.equal(f.calls.length,before);assert.ok(f.node.imports.get(job.id).media!.every(item=>item.searchable));
});

test('one failed extraction is isolated, retries without reupload, then enters automatic Memory',async t=>{
  const f=await fixture(t);f.failed.add('ID3-generated-fail');const job=await f.create([entry('bad.mp3','ID3-generated-fail'),entry('good.mp3','ID3-generated-good')]);
  await f.node.processing.tick();await f.organize();const first=f.node.imports.get(job.id);assert.equal(first.media![0].processing?.state,'failed');assert.equal(first.media![1].searchable,true);
  assert.equal(f.node.materials.input(materialId(job.sourceId,'file:bad.mp3'),['extracted-text'])?.ready,false);
  const count=f.calls.length;f.failed.clear();f.node.processing.retry(first.media![0].captureId!,'transcribe');await f.node.processing.tick();await f.organize();assert.equal(f.calls.length,count+1);
  f.node.sourcePipelines.drainMemory(f.node.memoryPipeline,true,100);await Promise.all(f.node.memoryPipeline.list().map(item=>f.node.memoryPipeline.run(item.id)));
  assert.equal(f.node.memoryPipeline.list().length,2);assert.ok(f.node.memoryPipeline.list().every(item=>item.status==='completed'));assert.ok(f.modelCalls.length>0);
  assert.ok(f.node.imports.get(job.id).media!.every(item=>item.memory?.state==='completed'),'zero admitted memories still have completed processing receipts');
  const memoryId=f.node.imports.get(job.id).media![0].memory!.jobIds[0];
  f.node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','waiting_for_model') WHERE id=?").run(memoryId);
  assert.equal(f.node.imports.get(job.id).media![0].memory?.state,'waiting_for_model','a model configuration wait is not reported as disabled Memory');
  f.node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE id=?").run(memoryId);
  assert.equal(f.node.imports.get(job.id).media![0].memory?.state,'paused');
});

test('mixed image and text import uses separate native extraction and preserves original text',async t=>{
  const f=await fixture(t),image=await sharp({create:{width:8,height:8,channels:3,background:'#abc'}}).png().toBuffer();let ocr=0;
  f.node.processing.runtime.registry.get('image.http').process=async()=>{ocr++;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated image text'}]};};
  f.node.processing.update({revision:f.node.processing.view().revision,settings:{...f.node.processing.view().settings,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:9008/fixture'}});
  const job=await f.create([entry('note.txt','Generated original note'),entry('image.png',image)]);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.media?.length,1);assert.equal(job.progress.imported,2);
  await f.node.processing.tick();assert.equal(ocr,1);assert.equal(f.modelCalls.length,0);assert.equal(f.node.files.chunks(job.media![0].captureId!)[0].ocrText,'Generated image text');
  assert.equal(f.node.store.search({query:'Generated original note'}).length,1);
});

test('a deployment plugin extends format, output schema and DAG without changing import or file hosts',async t=>{
  const path=fileURLToPath(new URL('../../../examples/plugins/media-intake.mjs',import.meta.url)),f=await fixture(t,[path]);
  f.node.processing.update({revision:f.node.processing.view().revision,settings:{...f.node.processing.view().settings,typeProfiles:{'application/vnd.mote.text':'community.text-extract'}}});
  const job=await f.create([entry('unknown.custom','MOTE-TEXT\nGenerated first\r\nGenerated second')]);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.media![0].format.id,'community.text-format');
  await f.node.processing.tick();const id=job.media![0].captureId!;assert.equal(f.node.files.chunks(id)[0].ocrText,'Generated first\nGenerated second');assert.equal(f.calls.length,0);assert.equal(f.modelCalls.length,0);
  const receipt=f.node.processing.explain(id).snapshots[0] as any;assert.equal(receipt.recipe.id,'community.text-pipeline');assert.equal(receipt.stagePins[1].id,'community.normalize-lines');
  const artifact=f.node.store.db.prepare("SELECT json FROM file_artifacts WHERE capture_id=? AND current=1 AND kind='text'").get(id)!;
  assert.equal(JSON.parse(String(artifact.json)).output.type.id,'community.located-text');assert.equal(JSON.parse(String(artifact.json)).output.payload.body,'Generated first\nGenerated second');
  assert.equal(sha256(f.node.archivedFiles.read(job.media![0].fileId)),job.files[0].hash);
});

test('capability conflicts and cyclic recipes fail explicitly; install and uninstall schedule no work',()=>{
  const intake=new ImportIntakeRegistry(),stop=installImportIntake(intake),file={id:'fixture',hash:'',name:'x.mp3',relativePath:'x.mp3',mimeType:'application/octet-stream',sizeBytes:1,createdAt:''};
  const unregister=intake.registerFormat({id:'fixture.conflict',version:'1',probe:()=>({mimeType:'audio/mpeg',reason:'Declared format'})});assert.throws(()=>intake.format({file,prefix:Buffer.from('ID3')}),/Ambiguous/);unregister();assert.equal(intake.format({file,prefix:Buffer.from('ID3')})?.mimeType,'audio/mpeg');stop();assert.equal(intake.format({file,prefix:Buffer.from('ID3')}),undefined);
  const recipes=new FileRecipeRegistry(),outputs=new FileOutputRegistry(),dispose=installFileRecipes(recipes,outputs);
  assert.throws(()=>recipes.registerRecipe({id:'fixture.cycle',version:'1',output:'a',steps:[{name:'a',stage:{id:'mote.extract',version:'1'},dependsOn:['a']}]}),/cyclic/);dispose();assert.throws(()=>recipes.resolve({id:'mote.file-extraction',version:'1'},{semanticTurns:false}),/unavailable/);
});

test('retry recovers a retained zero-record import through media intake without reupload',async t=>{
  let legacyId='',originalId='';
  const f=await fixture(t,[],async directory=>{
    const store=new Store(directory),files=new ArchivedFileStore(store);
    try{
      const imports=new ImportStore(store,files,new SourceStore(store),{prepare:async input=>{
        writeFileSync(join(input.workspace,'records.jsonl'),'');
        return {summary:'Generated legacy parser cannot transcribe audio'};
      }});
      const job=await imports.create({files:[entry('2020-01-01-old.mp3','ID3-generated-legacy')],processing:'automatic'});legacyId=job.id;originalId=job.files[0].id;
      assert.equal((await imports.prepare(job.id)).status,'unsupported');assert.equal(store.list().items.length,0);
    }finally{store.close();}
  });
  assert.equal(f.node.imports.get(legacyId).status,'unsupported');
  const admitted=await f.node.imports.retry(legacyId);assert.equal(admitted.status,'completed');assert.equal(admitted.media![0].fileId,originalId);
  await f.node.processing.tick();assert.equal(f.calls.length,1);assert.equal(f.node.imports.get(legacyId).media![0].searchable,true);
});
