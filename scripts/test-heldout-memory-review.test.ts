/** Independent generated metadata/answers only; no frozen corpus or provider is opened. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {exportBlindReview,ReviewFailure} from './test-heldout-memory-review.js';

const directory=process.env.MOTE_REVIEW_TEST_OUTPUT?resolve(process.env.MOTE_REVIEW_TEST_OUTPUT):await mkdtemp(join(tmpdir(),'mote-generated-review-'));
await mkdir(directory,{recursive:true});
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),objectHash=(v:unknown)=>hash(JSON.stringify(v)),json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const zeros='0'.repeat(64),canonical='b'.repeat(64),supervisorHash='c'.repeat(64);
const runtime={nodeExecutable:'/generated/node',nodeVersion:'generated',nodeExecutableSha256:zeros};
const rootMetadata={schema:'mote-heldout-first-batch-manifest@1',kind:'mechanical',runtime,corpusFreeze:zeros,evaluationFreeze:zeros,codeHashes:{'apps/server/src/generated.ts':zeros,'scripts/generated.ts':zeros},model:{provider:'generated'},bindingsHash:zeros,seedTreeHash:canonical,batchPlan:[],experimentPlan:{generated:true}};
const experiment=objectHash({corpus:rootMetadata.corpusFreeze,evaluation:rootMetadata.evaluationFreeze,production:{'apps/server/src/generated.ts':zeros},model:rootMetadata.model,runtime,bindings:rootMetadata.bindingsHash,initialSeed:rootMetadata.seedTreeHash,initialBatchPlan:rootMetadata.batchPlan,plan:rootMetadata.experimentPlan});
const limits={stageOuter:2,perOuterMs:300000,stageProcessMs:720000,cumulativePlanningCap:124,automaticOuterRetries:0,concurrency:1};
const checks:Array<Record<string,unknown>>=[];
async function save(path:string,value:unknown){await writeFile(path,json(value),{mode:0o600});return {path,sha256:hash(await readFile(path))};}
async function fixture(name:string,mutate?:(state:any)=>void,history=false,rebind=false){
  const root=join(directory,name);await mkdir(root);const ledgerDirectory=join(root,'ledger');await mkdir(ledgerDirectory);
  const rootRef=await save(join(root,'root.json'),{...rootMetadata,experimentHash:experiment});
  const pairs=[2,3,4,5,6,6,6,6].map((wave,i)=>({questionId:'generated-'+i,scenario:'generated-scenario',question:'  Literal generated question '+i+'\r\n末尾。',checkpointWave:wave,contextTime:'2026-01-01T00:00:00+08:00',slots:[{id:randomUUID(),label:'Response 2',removeMemory:i%2===0},{id:randomUUID(),label:'Response 1',removeMemory:i%2!==0}]}));
  const plan={schema:'mote-heldout-ask-plan@1',experimentHash:experiment,questionsHash:objectHash(pairs.map(({slots,...q})=>q)),pairs};
  const planRef=await save(join(root,'ask-plan.json'),plan),commitment=await save(join(ledgerDirectory,'ask-plan-commitment.json'),{schema:'mote-heldout-ask-plan-commitment@1',experimentHash:experiment,plan:planRef});
  const events:any[]=[],add=(kind:string,data:any)=>{const body={index:events.length,at:'2026-01-01T00:00:00Z',previous:events.at(-1)?.sha256??'genesis',kind,data};const event={...body,sha256:objectHash(body)};events.push(event);return event;};
  add('manifest',{manifestHash:experiment,cumulativeCap:124});
  if(history){add('stage-open',{stage:'generated-background-failure',parentHash:canonical,maxCalls:2});add('admit',{stage:'generated-background-failure',callId:'old-call',receiptId:'old-receipt',logicalKey:'old'});add('terminal',{callId:'old-call',status:'failed'});add('receipt',{id:'old-receipt',status:'failed',tokens:{total:19,complete:false}});const stop=add('stop',{code:'outer_deadline_exceeded'});add('stage-close',{stage:'generated-background-failure',succeeded:false,snapshotHash:canonical,phase:{kind:'extraction'}});const recovery=await save(join(root,'generated-recovery.json'),{experimentHash:experiment,stoppedHeadHash:events.at(-1).sha256,stopHashes:[stop.sha256]});add('recovery-authorized',{plan:recovery});}
  const rows:any[]=[];
  for(const [i,pair] of pairs.entries()){
    const phaseIndex=i<4?0:i-4,stageId=`wave${pair.checkpointWave}-pair-${phaseIndex}-${planRef.sha256}`;
    const stageDirectory=join(root,'stage-'+i);await mkdir(stageDirectory);await mkdir(join(stageDirectory,'DO_NOT_OPEN'));
    const recovery=events.find(e=>e.kind==='recovery-authorized');
    const manifest={...(recovery?{recoveryLineage:{plan:recovery.data.plan,eventHash:recovery.sha256}}:{}),schema:'mote-heldout-phase-manifest@1',kind:'mechanical',experimentHash:experiment,rootManifest:rootRef,runtime,limits,executor:{supervisorPath:'/generated/supervisor.py',supervisorHash},parent:{treeHash:canonical,ledgerHeadHash:events.at(-1).sha256},task:{kind:'evaluation',wave:pair.checkpointWave,index:phaseIndex,contextTime:pair.contextTime,plan:planRef,commitment}};
    const manifestRef=await save(join(root,'manifest-'+i+'.json'),manifest);add('executor-freeze',{manifestHash:manifestRef.sha256});add('stage-open',{stage:stageId,parentHash:canonical,maxCalls:2});
    const result={question:pair.question,results:pair.slots.map((slot,j)=>{
      const callId='call-'+i+'-'+j,receiptId='receipt-'+i+'-'+j;add('admit',{stage:stageId,callId,receiptId,logicalKey:slot.id});add('terminal',{callId,status:'completed',modelRunStarts:1,repairs:0});add('receipt',{id:receiptId,status:'completed',tokens:{input:100+i,output:20,complete:true},durationMs:17});
      return {label:slot.label,slotId:slot.id,callId,closedTreeHash:canonical,answer:{answer:('Generated complete answer. “字” 😀\r\n').repeat(900)+i+'/'+j+' END',citations:[{id:'memory:visible-'+i,capturedAt:'2025-01-01',appName:'Visible source',excerpt:'Keep this full quote \r\n “usage” is visible content.'},{id:'source:'+i,capturedAt:'literal date',appName:'第二引用',excerpt:'末尾'+j}],usage:{secret:'INTERNAL_COST_SECRET'},trace:[{secret:'INTERNAL_TRACE_SECRET'}],runId:'INTERNAL_RUN_SECRET',configuration:{secret:'INTERNAL_CONFIG_SECRET'},modelSelection:{secret:'INTERNAL_MODEL_SECRET'},snapshot:{secret:'INTERNAL_SNAPSHOT_SECRET'},evidenceDependencies:{secret:'INTERNAL_DEP_SECRET'}}};})};
    const resultRef=await save(join(stageDirectory,'DO_NOT_OPEN','paired-results.json'),result);const closure=add('stage-close',{stage:stageId,succeeded:true,snapshotHash:resultRef.sha256,phase:{kind:'evaluation',wave:pair.checkpointWave,evaluatedPairs:phaseIndex+1,archiveHeadHash:canonical}});
    const stage={schema:'mote-heldout-ask-stage@1',status:'paired-success',phase:'evaluation',wave:pair.checkpointWave,pairOrdinal:phaseIndex,manifestHash:manifestRef.sha256,experimentHash:experiment,planHash:planRef.sha256,completedCalls:2,realModelCalls:0,stubModelCalls:2,limits,cumulative:{headHash:closure.sha256,unknown:0,unreconciledReceipts:0,terminalReceiptConflicts:0,stopped:false},pairedResultHash:resultRef.sha256,archiveHeadHash:canonical};
    const supervision={schema:'mote-heldout-phase-supervision@2',phase:'evaluation',mode:'stage-ask-live',status:'process-closed',exitCode:0,terminationRequested:false,interrupted:false,remainingProcessGroupAfterParentExit:false,processGroupClosed:true,frozenControlsUnchangedAfterClose:true,ledgerPrefixUnchangedAfterClose:true,limits,manifestPath:manifestRef.path,manifestSha256:manifestRef.sha256,stageOutput:stageDirectory,ledgerPath:ledgerDirectory,supervisorPath:manifest.executor.supervisorPath,supervisorSha256:supervisorHash};
    rows.push({stageId,manifest,result,stage,supervision,manifestRef,resultRef,stageDirectory});
  }
  const fingerprints=()=>{for(const row of rows){const open=events.find(e=>e.kind==='stage-open'&&e.data.stage===row.stageId),close=events.find(e=>e.kind==='stage-close'&&e.data.stage===row.stageId);for(const [field,index] of [['ledgerBefore',open.index-2],['ledgerAfter',close.index]] as const){const bytes=events.slice(0,index+1).map(e=>JSON.stringify(e)).join('\n')+'\n';row.supervision[field]={bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};}}};
  fingerprints();const state={root,pairs,rows,events,add,plan,planRef,commitment};mutate?.(state);
  // Deep negative cases rebuild every cryptographic binding around intentionally
  // wrong generated content, ensuring the semantic-free shape guards are reached.
  if(rebind)for(const [i,event] of events.entries()){
    if(event.kind==='executor-freeze'){const row=rows.find(r=>r.manifestRef.sha256===event.data.manifestHash);if(row){row.manifest.parent.ledgerHeadHash=events[i-1].sha256;row.manifestRef=await save(row.manifestRef.path,row.manifest);event.data.manifestHash=row.manifestRef.sha256;row.stage.manifestHash=row.manifestRef.sha256;row.supervision.manifestSha256=row.manifestRef.sha256;}}
    const row=event.kind==='stage-close'?rows.find(r=>r.stageId===event.data.stage):undefined;
    if(row){row.resultRef=await save(row.resultRef.path,row.result);event.data.snapshotHash=row.resultRef.sha256;row.stage.pairedResultHash=row.resultRef.sha256;}
    event.index=i;event.previous=events[i-1]?.sha256??'genesis';const {sha256,...body}=event;event.sha256=objectHash(body);if(row)row.stage.cumulative.headHash=event.sha256;
  }
  if(rebind)fingerprints();
  // Mutation fixtures refresh outer file references but not execution bindings,
  // so the checks must reject internally inconsistent evidence, not only bad input pins.
  const files=[];for(const [i,row] of rows.entries())files.push({manifest:await save(join(root,'manifest-'+i+'.json'),row.manifest),stage:await save(join(row.stageDirectory,'ROOT_SAFE_stage.json'),row.stage),supervision:await save(join(root,'supervision-'+i+'.json'),row.supervision),result:await save(join(row.stageDirectory,'DO_NOT_OPEN','paired-results.json'),row.result)});
  const ledgerPath=join(ledgerDirectory,'admissions.ndjson');await writeFile(ledgerPath,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const input={schema:'mote-heldout-review-input@1',kind:'mechanical',experimentHash:experiment,rootManifest:rootRef,ledger:{path:ledgerPath,sha256:hash(await readFile(ledgerPath))},commitment,pairs:files.reverse()};
  const inputPath=join(root,'input.json');await save(inputPath,input);return {...state,input,inputPath,output:join(root,'export')};
}
async function unchanged(f:any){return {ledger:hash(await readFile(f.input.ledger.path)),commitment:hash(await readFile(f.commitment.path)),results:await Promise.all(f.input.pairs.map(async(p:any)=>hash(await readFile(p.result.path))))};}
async function refuses(name:string,change:(state:any)=>void,code:string,rebind=false){const f=await fixture(name,change,false,rebind),before=await unchanged(f);await assert.rejects(exportBlindReview(f.inputPath,f.output),e=>e instanceof ReviewFailure&&e.code===code);assert.deepEqual(await unchanged(f),before);assert.ok(!(await readdir(f.root)).includes('export'));checks.push({name,status:'passed',rejection:code});}

test('exports all eight pairs in fixed label order without rewriting long answers or visible Memory citations',async()=>{
  const f=await fixture('complete'),before=await unchanged(f),report=await exportBlindReview(f.inputPath,f.output);
  const bytes=await readFile(join(f.output,'DO_NOT_OPEN','blind-review.json'),'utf8'),pack=JSON.parse(bytes);
  assert.equal(pack.questions.length,8);assert.equal(report.responses,16);assert.equal(hash(bytes),report.packageSha256);
  for(const [i,q] of pack.questions.entries()){assert.equal(q.question,f.pairs[i].question);assert.deepEqual(q.responses.map((r:any)=>r.label),['Response 1','Response 2']);for(const r of q.responses){const original=f.rows[i].result.results.find((v:any)=>v.label===r.label);assert.deepEqual(r,{label:r.label,answer:original.answer.answer,citations:original.answer.citations});}}
  for(const secret of ['INTERNAL_','slotId','callId','closedTreeHash','removeMemory','runId'])assert.ok(!bytes.includes(secret));
  const safe=await readFile(join(f.output,'ROOT_SAFE_review-export.json'),'utf8');assert.ok(!safe.includes('Generated complete answer')&&!safe.includes('Literal generated question')&&!safe.includes('memory:visible'));
  assert.deepEqual(await unchanged(f),before);await assert.rejects(exportBlindReview(f.inputPath,f.output),/review_output_exists/);checks.push({name:'complete-fixed-order-full-content',status:'passed',pairs:8,responses:16});
});
test('historical failed/incomplete usage remains intact after an already bound recovery event',async()=>{const f=await fixture('history',undefined,true),before=await unchanged(f);await exportBlindReview(f.inputPath,f.output);assert.deepEqual(await unchanged(f),before);checks.push({name:'historical-failure-preserved',status:'passed'});});
test('all enriched public citation time, source, file location and attribution fields survive unchanged',async()=>{
  const f=await fixture('enriched-citations',s=>{for(const row of s.rows)for(const result of row.result.results){Object.assign(result.answer.citations[0],{contentAt:'2025-01-02T03:04:05Z',
    provenance:{sourceId:'generated',externalId:'generated-original',revision:'v1',layer:'snapshot',deleted:false,modifiedAt:'2025-01-03T00:00:00Z',originalAvailable:true,
      calendar:{start:'2025-01-02T00:00:00Z',end:'2025-01-02T01:00:00Z',allDay:false},metadata:{version:1,provider:{createdAt:'2025-01-01T00:00:00Z',updatedAt:'2025-01-03T00:00:00Z'}},
      document:{fileId:'generated-file',path:'generated/location',recordedAt:'2025-01-02T03:04:05Z',occurredAt:'2025-01-02T00:00:00Z',timeBasis:'recorded',contentRole:'authored',attachments:[{id:'generated-child',name:'full original name',mimeType:'image/png'}],originalMetadata:{usage:'Visible original source metadata; keep verbatim.',nested:{note:'Full provenance, not run accounting.'}}}},
    fileEvidence:{captureId:randomUUID(),revision:'v1',artifactId:randomUUID(),chunkId:randomUUID(),startMs:25,endMs:105,speaker:'Generated speaker',speakerAttribution:{name:'Generated owner',confirmedBy:'owner',confirmationId:randomUUID(),confirmedAt:'2025-01-04T00:00:00Z'},uncertain:true,overlap:false,documentLocation:{pageNumber:2,sheetName:'Generated sheet',rowNumber:3,offset:7,length:9},imageLocation:{width:400,height:300,polygon:[[0,0],[20,0],[20,20],[0,20]]}}});}},false,true);
  await exportBlindReview(f.inputPath,f.output);const pack=JSON.parse(await readFile(join(f.output,'DO_NOT_OPEN','blind-review.json'),'utf8'));
  for(const [i,q] of pack.questions.entries())for(const r of q.responses){const original=f.rows[i].result.results.find((v:any)=>v.label===r.label);assert.deepEqual(r.citations,original.answer.citations);assert.equal(r.citations[0].provenance.calendar.status,undefined);}
  checks.push({name:'public-api-enriched-citations-preserved',status:'passed'});
});
test('wrong file hash is rejected before output',async()=>{const f=await fixture('wrong-hash');f.input.pairs[0].result.sha256=zeros;await save(f.inputPath,f.input);await assert.rejects(exportBlindReview(f.inputPath,f.output),/review_result_binding_changed|review_source_hash_changed/);checks.push({name:'wrong-hash',status:'passed'});});
test('missing pair cannot be selected as a smaller review',async()=>{const f=await fixture('missing');f.input.pairs.pop();await save(f.inputPath,f.input);await assert.rejects(exportBlindReview(f.inputPath,f.output));checks.push({name:'missing-pair',status:'passed'});});
test('duplicate pair cannot replace another pair',async()=>{const f=await fixture('duplicate');f.input.pairs[1]=f.input.pairs[0];await save(f.inputPath,f.input);await assert.rejects(exportBlindReview(f.inputPath,f.output),/review_duplicate_pair/);checks.push({name:'duplicate-pair',status:'passed'});});
test('failed stage is rejected',()=>refuses('failed',s=>{s.rows[3].stage.status='stopped';},'review_stage_not_successful'));
test('unknown accounting is rejected',()=>refuses('unknown',s=>{s.rows[2].stage.cumulative.unknown=1;},'review_stage_accounting_unclosed'));
test('running or orphaned process is rejected',()=>refuses('orphan',s=>{s.rows[0].supervision.processGroupClosed=false;},'review_process_not_closed'));
test('modified question is rejected even with all hash and execution bindings rebuilt',()=>refuses('question-changed',s=>{s.rows[4].result.question+='changed';},'review_question_changed',true));
test('incorrect fixed label mapping is rejected with cryptographically consistent evidence',()=>refuses('labels-changed',s=>{s.rows[1].result.results[0].label='Response 1';},'review_result_slot_changed',true));
test('manifest experiment change is rejected',()=>refuses('experiment-changed',s=>{s.rows[5].manifest.experimentHash=zeros;},'review_manifest_invalid'));
test('ledger chain tampering is rejected',()=>refuses('chain-tampered',s=>{s.events[2].data.maxCalls=100;},'review_ledger_chain_invalid'));
test('extra pending stage cannot be ignored',()=>refuses('pending-stage',s=>{s.add('stage-open',{stage:'unfinished',maxCalls:2,parentHash:canonical});},'review_stage_closure_ambiguous'));
test('missing terminal receipt cannot hide behind a rebuilt ledger hash',()=>refuses('missing-receipt',s=>{s.events.splice(s.events.findIndex((e:any)=>e.kind==='receipt'),1);},'review_receipt_count_invalid',true));
test('a failed terminal/receipt cannot be reported as paired success',()=>refuses('failed-receipt',s=>{s.events.find((e:any)=>e.kind==='terminal').data.status='failed';s.events.find((e:any)=>e.kind==='receipt').data.status='failed';},'review_failed_call_in_successful_stage',true));
test('unknown completed phase cannot be ignored',()=>refuses('unknown-phase',s=>{s.add('stage-open',{stage:'unknown',maxCalls:0,parentHash:canonical});s.add('stage-close',{stage:'unknown',succeeded:true,snapshotHash:canonical,phase:{kind:'unknown'}});},'review_stage_phase_unknown'));
test('an absent phase is accepted only for the known legacy wave-one stage name',()=>refuses('unknown-legacy-phase',s=>{s.add('stage-open',{stage:'unknown',maxCalls:0,parentHash:canonical});s.add('stage-close',{stage:'unknown',succeeded:true,snapshotHash:canonical});},'review_stage_phase_unknown'));
test('supervisor ledger bytes must bind the same closed stage prefix',()=>refuses('wrong-supervisor-ledger',s=>{s.rows[0].supervision.ledgerAfter={bytes:1,sha256:zeros};},'review_supervision_ledger_changed'));
test('an unknown host rejection receipt cannot be hidden by sixteen completed admissions',()=>refuses('unknown-host-receipt',s=>{s.events.splice(3,0,{kind:'host-rejection-receipt',at:'2026-01-01T00:00:00Z',data:{id:'generated-rejection',status:'running'}});},'review_host_receipt_unknown',true));
test('implementation usage inserted as an unknown citation field is rejected rather than silently stripped',()=>refuses('citation-extra-usage',s=>{s.rows[0].result.results[0].answer.citations[0].usage={total:123};},'review_result_shape_invalid',true));
test('actual CLI emits only a fixed safe failure and does not create rejected output',async()=>{const f=await fixture('cli-invalid');f.input.pairs.pop();await save(f.inputPath,f.input);const r=spawnSync(process.execPath,['--import','tsx','scripts/test-heldout-memory-review.ts','--input',f.inputPath,'--output',f.output],{cwd:process.cwd(),encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stdout,'');const error=JSON.parse(r.stderr);assert.equal(error.code,'review_invalid_input_or_io');assert.equal(error.semanticContentExposed,false);checks.push({name:'cli-safe-rejection',status:'passed'});});
test('actual CLI exports generated evidence with only safe metadata on stdout',async()=>{const f=await fixture('cli-complete');const r=spawnSync(process.execPath,['--import','tsx','scripts/test-heldout-memory-review.ts','--input',f.inputPath,'--output',f.output],{cwd:process.cwd(),encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).responses,16);assert.ok(!r.stdout.includes('Generated complete answer')&&!r.stdout.includes('INTERNAL_'));checks.push({name:'cli-safe-success',status:'passed'});});
after(async()=>{await writeFile(join(directory,'ROOT_SAFE_review-tests.json'),json({schema:'mote-heldout-review-validation@1',status:checks.length===23?'passed':'incomplete',checks,realModelCalls:0,stubModelCalls:0,heldoutSemanticInputsRead:false,privateSourcesRead:false,scope:'Independent generated fixtures only; no real export or grading.'}));});
