import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../../src/app.js';
import {materialId} from '../../src/materials.js';
import {sha256} from '../../src/store.js';
import {authorizeFixtureModels,withFixtureOwnerModelWork} from './model-authorization.js';
import {generatedMemoryOutput} from './memory-planning.js';

// The parent's private profile contains only generated originals. Exercise the
// real organizers, Memory admission, extraction/review and publication fences;
// only the external provider is replaced with generated responses.
const directory=process.argv[2],recordings=8,segmentsPerRecording=296,notes=344;
const config={dataDir:directory,token:'generated-memory-health-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:200e6,maxExportBytes:1e6,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,memoryConcurrency:3};
let modelCalls=0;
const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  modelCalls++;process.send!({type:'model',modelCalls,phase:input.traceContext?.phase});await delay(100);
  return {answer:generatedMemoryOutput(input),citations:[],trace:[],runId:randomUUID()};
}}});
try{
  await node.app.listen({host:'127.0.0.1',port:0});await authorizeFixtureModels(node);
  const sourceId='generated-memory-health-source';
  node.sources.register({id:sourceId,name:'Generated originals',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  for(let recording=0;recording<recordings;recording++){
    const segments=Array.from({length:segmentsPerRecording},(_,index)=>({startMs:index*2000,endMs:(index+1)*2000,speaker:'Generated speaker',text:`Generated recording ${recording} segment ${index} with complete original text and exact timing.`}));
    await node.files.transcriptRevision(sourceId,{externalId:'recording-'+recording,kind:'file',title:'Generated recording '+recording,observedAt:'2026-10-01T00:00:00.000Z',document:{recordedAt:'2026-09-30T23:00:00.000Z',contentRole:'transcript'}},
      segments.map(segment=>segment.text).join('\n'),{durationMs:segmentsPerRecording*2000,coverage:'full',engine:'generated',segments},()=>{});
  }
  for(let index=0;index<notes;index++)await node.sources.upsert(sourceId,{externalId:'note-'+index,revision:'1',kind:'message',layer:'original',observedAt:'2026-10-01T00:00:00Z',text:`Generated independent note ${index} with exact owner provenance.`});
  while(await node.materialOrganizer.tick(500)){}
  const selections:string[][]=[];
  for(let recording=0;recording<recordings;recording++)selections.push(node.materials.input(materialId(sourceId,'recording-'+recording),['extracted-text'])!.evidenceIds);
  for(let group=0;group<notes/8;group++)selections.push(Array.from({length:8},(_,index)=>node.materials.evidenceIds(materialId(sourceId,'note-'+(group*8+index)))).flat());
  const jobs=[];
  for(const evidenceIds of selections)jobs.push(await withFixtureOwnerModelWork(node,()=>node.memoryPipeline.create({evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]})));
  const originals=()=>sha256(JSON.stringify({
    captures:node.store.db.prepare('SELECT id,json FROM captures ORDER BY id').all(),
    chunks:node.store.db.prepare('SELECT * FROM file_chunks ORDER BY id').all(),
    files:node.store.db.prepare('SELECT capture_id,manifest,object_hash FROM file_versions ORDER BY capture_id').all(),
    materials:node.store.db.prepare('SELECT id,revision FROM material_heads ORDER BY id').all(),
  })),saved=originals();
  assert.equal(jobs.length,51);assert.equal(selections.flat().length,2712);
  process.send!({type:'ready',port:(node.app.server.address() as {port:number}).port});
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  process.send!({type:'processing'});
  const began=performance.now(),running=jobs.map(job=>withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id)));
  process.send!({type:'queued',durationMs:performance.now()-began});
  const completed=await Promise.all(running);
  assert.ok(completed.every(job=>job.status==='completed'));
  const batches=completed.flatMap(job=>job.batches),coverage=batches.flatMap(batch=>batch.coverage??[]);
  assert.equal(batches.length,67);assert.equal(modelCalls,batches.length*2,'each batch extracts and independently reviews once');
  assert.ok(batches.every(batch=>batch.attempts===1));
  assert.equal(coverage.length,2712);assert.equal(new Set(coverage.map(member=>member.key)).size,2712);
  assert.ok(coverage.every(member=>member.state==='no_candidates'));
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2712);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.batch' AND (state!='succeeded' OR attempts!=1 OR error IS NOT NULL)").get()!.n,0);
  assert.equal(originals(),saved,'processing preserves every original, transcript segment, source time, file identity and Material revision');
  process.send!({type:'done',durationMs:performance.now()-began,jobs:completed.length,batches:batches.length,originals:coverage.length,modelCalls});
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
}finally{await node.app.close();}
process.disconnect();
