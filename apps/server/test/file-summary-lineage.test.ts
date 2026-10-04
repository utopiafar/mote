import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileReviews} from '../src/file-reviews.js';
import {fileSummaryInputFingerprint} from '../src/file-summary-lineage.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

async function fixture(t:import('node:test').TestContext,held=false,count=1){
  const directory=mkdtempSync(join(tmpdir(),'mote-summary-lineage-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources);
  sources.register({id:'generated',name:'Generated audio',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
  let start!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(resolve=>start=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const processing=new FileProcessing(files,{transcribe:async()=>({durationMs:count*1000,segments:Array.from({length:count},(_,i)=>({startMs:i*1000,endMs:(i+1)*1000,text:'Generated launch is complete '+i,speaker:'SPEAKER_0'}))})},async records=>{
    const first=calls++===0;if(held&&first){start();await gate;}
    return {answer:held&&first?'OBSOLETE_HELD_RESPONSE':'CURRENT '+records.map(r=>r.ocrText+' '+JSON.stringify(r.fileEvidence?.speakerAttribution??{})).join('\n'),citations:records.map(r=>({id:r.id}))};
  });
  t.after(async()=>{release();await processing.close();store.close();rmSync(directory,{recursive:true,force:true});});
  await processing.runtime.ready;const settings={...processing.view().settings,enabled:true,audioProcessor:'audio.http',summarize:true};
  processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
  const bytes=Buffer.from('Generated audio bytes'),upload=files.begin({sourceId:'generated',item:{externalId:'generated.wav',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:'Generated',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
  files.part(upload.uploadId,0,bytes,()=>{});const id=(await files.commit(upload.uploadId,()=>{})).id;
  const reviews=new FileReviews(files,processing);
  const correct=async(kind:'manual'|'review'|'speaker',offset=0)=>{
    const chunk=files.chunks(id,offset,1)[0],artifactId=chunk.fileEvidence!.artifactId;
    if(kind==='speaker'){reviews.nameSpeakers(id,{artifactId,names:{SPEAKER_0:'Generated participant'}});return;}
    const originalText=String(store.db.prepare('SELECT text FROM file_chunks WHERE id=?').get(chunk.id)!.text);
    if(kind==='manual'){reviews.correct(id,{artifactId,chunkId:chunk.id,originalText,correctedText:originalText.replace('is complete','is NOT complete')});return;}
    processing.analyze=async()=>({answer:JSON.stringify({suggestions:[{chunkId:chunk.id,original:'is complete',replacement:'is NOT complete',reason:'Generated exact correction'}]}),citations:[{id:chunk.id}]});
    const proposal=await reviews.propose(id,{kind:'terms',offset});reviews.confirm(id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});
  };
  return {store,files,processing,reviews,id,started,release,correct,calls:()=>calls};
}

for(const kind of ['manual','review','speaker'] as const){
  test(`saved summary retires immediately after ${kind} input change and reprocesses current evidence`,async t=>{
    const f=await fixture(t);await f.processing.tick();const previous=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='summary')!;assert.ok(previous);
    await f.correct(kind);assert.equal(f.files.detail(f.id).artifacts.some((a:any)=>a.kind==='summary'),false);assert.equal(f.files.detail(f.id).job.summary_state,'waiting');
    await f.processing.tick();const current=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='summary') as any;assert.ok(current);assert.notEqual(current.id,previous.id);
    assert.equal(current.inputFingerprint,fileSummaryInputFingerprint(f.files,f.id));assert.match(current.sections[0].answer,kind==='speaker'?/Generated participant/:/NOT complete/);
  });
  test(`held summary cannot commit after ${kind} input change; replacement uses current proof`,async t=>{
    const f=await fixture(t,true),running=f.processing.tick();await f.started;
    const old=f.processing.engine.list({operationId:'file:'+f.id,kind:'files.summary'}).items.find(step=>step.state==='running')!;
    await f.correct(kind);f.release();await running;await f.processing.tick();
    assert.notEqual(f.processing.engine.get(old.id)!.state,'succeeded');
    assert.equal(f.store.db.prepare("SELECT 1 FROM file_artifacts WHERE kind='summary' AND json LIKE '%OBSOLETE_HELD_RESPONSE%'").get(),undefined);
    const current=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='summary') as any;assert.equal(current.inputFingerprint,fileSummaryInputFingerprint(f.files,f.id));
    assert.match(current.sections[0].answer,kind==='speaker'?/Generated participant/:/NOT complete/);
  });
}

test('changing a later page while the first page is held never publishes a mixed-input summary',async t=>{
  const f=await fixture(t,true,25),running=f.processing.tick();await f.started;await f.correct('manual',24);f.release();await running;await f.processing.tick();
  const current=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='summary') as any;
  assert.equal(current.sections.length,2);assert.match(current.sections[1].answer,/NOT complete 24/);
  assert.equal(current.inputFingerprint,fileSummaryInputFingerprint(f.files,f.id));
  assert.equal(f.store.db.prepare("SELECT 1 FROM file_artifacts WHERE kind='summary' AND json LIKE '%OBSOLETE_HELD_RESPONSE%'").get(),undefined);
});

test('restart retires legacy summaries without pinned input lineage before exposing current completion',async t=>{
  const f=await fixture(t);await f.processing.tick();f.store.db.prepare("UPDATE file_artifacts SET json=json_remove(json,'$.inputFingerprint') WHERE kind='summary'").run();
  await f.processing.close();const restarted=new FileProcessing(f.files,undefined,async records=>({answer:'Generated replacement after restart',citations:records.map(record=>({id:record.id}))}));
  try{restarted.prepare();assert.equal(f.files.detail(f.id).artifacts.some((a:any)=>a.kind==='summary'),false);await restarted.tick();const current=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='summary') as any;assert.equal(current.inputFingerprint,fileSummaryInputFingerprint(f.files,f.id));}finally{await restarted.close();}
});
