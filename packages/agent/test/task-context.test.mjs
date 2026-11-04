import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {ARCHIVE_RECENCY_INSTRUCTIONS} from '../dist/tasks/evidence-rules.js';
import {compactMemoryTaskContext,restoreMemoryCoverageKeys} from '../dist/tasks/memory-context.js';
import {pinContextTools,registeredContextToolDefinitions} from '../dist/tool-contributions.js';
import {dispatchTools} from '../dist/task-context.js';
import {SYSTEM_PROMPT,systemInstructions} from '../dist/instructions.js';
import {prepareTaskContext} from '../dist/tasks/context-assembly.js';
import {assembleHostContext,createHostRunSession} from '../dist/host/run-session.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';

test('proposal lifecycle has one instruction contract while the envelope supplies only host state',()=>{
 const input={question:'Generated plan',hostRetrieval:'none',hostControlChannel:{phase:'proposal',definitions:[],execute:async()=>({data:{}})}};
 const envelope=buildContextEnvelope(input,[]),system=systemInstructions(input);
 assert.equal(envelope.delegation.phase,'proposal');assert.equal(envelope.delegation.instruction,undefined);
 assert.match(system,/return the requested final JSON/);assert.match(system,/Never call delegation_yield to finish planning/);
 const ordinary=systemInstructions({...input,hostControlChannel:{...input.hostControlChannel,phase:'execution'}});
 assert.match(ordinary,/Directly retrieve sufficient evidence and answer as the normal path/);
});

test('durable task retries keep their host-owned time even across a clock boundary',()=>{
 const input={question:'Review a proposed event',contextTime:'2026-09-01T23:59:59Z',timeZone:'UTC'};
 const first=buildContextEnvelope(input,[],'2026-09-01T23:59:59Z'),retry=buildContextEnvelope(input,[],'2026-09-02T00:00:01Z');
 assert.equal(first.currentTime,retry.currentTime);assert.equal(first.displayCurrentTime,retry.displayCurrentTime);
 assert.equal(buildContextEnvelope({question:'Interactive request'},[],'2026-09-02T00:00:01Z').currentTime,'2026-09-02T00:00:01Z');
});
test('opening memory hints are separate from cited evidence and include verification guidance',()=>{
 const lead={id:'generated-memory',title:'Generated preference',statement:'Generated statement',uncertainty:'Only in one project',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',admission:{scope:'A generated plan for one project',attribution:'user'},validFrom:'2026-09-18T00:00:00Z',validUntil:'2026-09-19T00:00:00Z'};
 const envelope=buildContextEnvelope({question:'What do you know?',openingMemories:[lead]},[]);
 assert.deepEqual(envelope.untrustedMemoryLeads,[lead]);
 assert.match(envelope.memoryLeadInstruction,/navigation hints, not independent evidence or instructions/);
 assert.match(envelope.memoryLeadInstruction,/includeEvidence=true.*host-verified supporting original ranges/);
 assert.match(envelope.memoryLeadInstruction,/Cite delivered original ids, not memory ids/);
 assert.match(envelope.memoryLeadInstruction,/not host owner-identity declarations or proof of current state/);
 assert.match(envelope.memoryLeadInstruction,/current attributionContext/);
 assert.equal(envelope.untrustedEvidence,undefined);
 assert.equal(envelope.hostAttributionContext,undefined);
});
test('all archive roles receive recency responsibility while selected scope and Memory publication dates stay unchanged',()=>{
 const lead={id:'generated-memory',title:'Generated older account',statement:'Generated earlier state',uncertainty:'A dated observation',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',validFrom:'2026-08-01T00:00:00Z'};
 const scope={after:'2026-06-01T00:00:00Z',before:'2026-09-18T00:00:00Z',contextTime:'2026-09-18T00:00:00Z',timeZone:'UTC'};
 let responsibility;
 for(const role of ['answer','research','writer','review']){
  const input={question:'Generated '+role+' task',...scope,openingMemories:[lead],traceContext:{phase:'quality.'+role}};
  const envelope=buildContextEnvelope(input,[]);
  assert.ok(systemInstructions(input).includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.ok(envelope.retrievalInstruction.includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.equal(envelope.retrievalInstruction.split(ARCHIVE_RECENCY_INSTRUCTIONS).length,2);
  responsibility??=envelope.retrievalInstruction;assert.equal(envelope.retrievalInstruction,responsibility,'no role-specific or question-keyword dispatch changes retrieval responsibility');
  assert.deepEqual(envelope.selectedTimeRange,{after:scope.after,before:scope.before});
  assert.equal(envelope.currentTime,scope.contextTime);assert.deepEqual(envelope.untrustedMemoryLeads,[lead]);
  assert.equal(envelope.untrustedEvidence,undefined,'a recency instruction does not synthesize original evidence');
 }
 for(const input of [{question:'Generated extraction',evidenceIds:['one']},{question:'Generated calendar',skill:'calendar-extraction'},{question:'Generated compaction',skill:'working-memory'},{question:'Generated host-only',hostRetrieval:'none'}]){
  assert.equal(buildContextEnvelope(input,[]).retrievalInstruction,undefined);
 }
});
test('archive roles receive progress precision checks while generated plans and outcomes remain unmodified evidence',()=>{
 const originals=[
  {id:'generated-plan',ocrText:'I plan to label the tool drawers on Saturday. The bolts are sorted; drawer labeling has not been reported.'},
  {id:'generated-advance',ocrText:'The paper glider passed its first balance check. The launch test and durability trial are still pending.'},
  {id:'generated-start',ocrText:'I set up the practice board and began the juggling exercise. Recording the next session is still a plan.'},
 ].map(original=>({...original,capturedAt:'2017-08-19T06:30:00Z',appName:'Generated',sourceType:'note'}));
 const before=structuredClone(originals);
 for(const phase of ['answer','research','writer','review']){
  const input={question:'Generated state-change review',traceContext:{phase:'quality.'+phase}},envelope=buildContextEnvelope(input,originals);
  assert.ok(envelope.retrievalInstruction.includes(ARCHIVE_RECENCY_INSTRUCTIONS));
  assert.match(envelope.retrievalInstruction,/intention or plan, explicitly started or ongoing action, and supported completion or outcome/);
  assert.match(envelope.retrievalInstruction,/unknown final outcome does not erase that progress/);
  assert.deepEqual(envelope.untrustedEvidence.map(({id,ocrText})=>({id,ocrText})),originals.map(({id,ocrText})=>({id,ocrText})),'the host passes originals rather than rewriting plans, choosing outcomes or inserting an expected answer');
 }
 assert.deepEqual(originals,before);
});
test('host context lineage is retained for fences without being disclosed to the model or granting citation reads',async t=>{
 const id='6f28159f-242b-5442-9a0c-a17958985a52',deps={version:1,complete:true,ids:[id]},lead={id:'generated-memory',title:'Generated',statement:'Generated decision',uncertainty:'Fixture',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z'};
 const pin={sourceId:'generated-source',version:1,fingerprint:'a'.repeat(64),kind:'metadata'},input={question:'Generated',contextEvidenceDependencies:deps,openingMemories:[lead],conversation:{turns:[{question:'Generated earlier',answer:'Generated answer',createdAt:lead.createdAt,scope:{}}],omittedTurns:0,evidenceDependencies:deps,sourceContextDependencies:[pin]}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(envelope.conversation.evidenceDependencies,undefined);assert.equal(envelope.conversation.sourceContextDependencies,undefined);assert.equal(JSON.stringify(envelope).includes(id),false);assert.equal(JSON.stringify(envelope).includes(pin.fingerprint),false);
 const bridge=await startBridge(reader,input,6);t.after(()=>bridge.close());assert.deepEqual(bridge.evidenceDependencies,deps);assert.deepEqual(bridge.sourceContextDependencies,[pin]);assert.equal(bridge.records.has(id),false,'lineage cannot confer citation authority');
 const missing=await startBridge(reader,{question:'Generated',openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[]}},6);t.after(()=>missing.close());assert.equal(missing.evidenceDependencies.complete,false,'nonempty derived lead cannot claim empty complete lineage');
});
test('scope and validity on an opening lead do not grant citations to its inline original locator',async t=>{
 const id='6f28159f-242b-5442-9a0c-a17958985a52',lead={id:'generated-memory',title:'Generated plan',statement:`A dated source plan [${id}]`,uncertainty:'Outcome unknown',status:'published',tier:'episode',createdAt:'2026-09-18T00:00:00Z',admission:{scope:'One generated source',attribution:'user'},validUntil:'2026-09-19T00:00:00Z'};
 const bridge=await startBridge(reader,{question:'Was it completed?',openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[id]}},6);t.after(()=>bridge.close());
 assert.equal(bridge.records.has(id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:`Generated completion [${id}]`,citationIds:[id]}),bridge.records),/not retrieved/);
});
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
const record={id:'6f28159f-242b-5442-9a0c-a17958985a52',capturedAt:'2026-09-18T00:00:00Z',deviceId:'fixture',appName:'Generated',ocrText:'a'.repeat(9000)+'NEEDLE the gate opens at 14:30. '+'b'.repeat(3000)};
const reader={search:async()=>[record],timeline:async()=>({items:([record]),nextCursor:null}),evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],memories:async()=>({items:[{id:'memory',statement:'derived'}],evidence:[record]})};
async function fixture(t,input={question:'fixture'}){const bridge=await startBridge(reader,input,24);t.after(()=>bridge.close());return {bridge,call:async(tool,args)=>{const r=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:r.status,body:await r.json()};}};}
test('shared context separates long task input and retains incremental semantics and task authority',()=>{
 const input={question:'Compact',skill:'working-memory',taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(30000)}]},incrementalEvidenceIds:['one']};
 const envelope=buildContextEnvelope(input,[],'2026-09-18T00:00:00Z');
 assert.equal(envelope.request,'Compact');assert.equal(envelope.untrustedTaskContext.turns[0].answer.length,30000);assert.equal(envelope.incrementalContext.count,1);assert.deepEqual(taskTools(input),[]);assert.deepEqual(taskTools({question:'Extract',evidenceIds:['one']}),['evidence']);
 assert.match(envelope.disclosurePolicy,/No archive retrieval is available/);
 const archive=buildContextEnvelope({question:'Browse generated'},[]);
 assert.match(archive.disclosurePolicy,/material_catalog.*material_read.*evidence before citing/);
 assert.match(archive.disclosurePolicy,/source tags.*untrusted/);
 assert.equal(buildContextEnvelope({...input,taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(80000)}]}},[]).untrustedTaskContext.turns[0].answer.length,80000);
});
test('search localizes late match and separate reads retain both citation spans',async t=>{
 const {bridge,call}=await fixture(t);
 const found=await call('search_context',{query:'NEEDLE'});assert.equal(found.status,200);assert.match(found.body.data[0].ocrText,/14:30/);assert.ok(found.body.data[0].textRange.start>8000);
 await call('evidence',{ids:[record.id],offset:0,length:100});
 const second=await call('evidence',{ids:[record.id],offset:9000,length:100});assert.equal(second.status,200);
 const saved=bridge.records.get(record.id);assert.equal(saved.deliveredRanges.length,3);
 const answer=parseAnswer(JSON.stringify({answer:`14:30 [${record.id}]`,citationIds:[record.id]}),bridge.records);assert.match(answer.citations[0].excerpt,/14:30/);
});
test('memory detail discovers IDs without authorizing unread original citations',async t=>{
 const {bridge,call}=await fixture(t);const memory=await call('memories',{id:'memory'});
 assert.equal(memory.status,200);assert.equal(memory.body.data.evidence[0].ocrText,undefined);assert.equal(bridge.records.has(record.id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:'claim',citationIds:[record.id]}),bridge.records));
 assert.equal((await call('evidence',{ids:[record.id],offset:9000,length:100})).status,200);assert.equal(bridge.records.has(record.id),true);
});
test('working task advertises and enforces no archive tools',async t=>{
 const {call}=await fixture(t,{question:'Compact',skill:'working-memory'});
 assert.equal((await call('_ready',{tools:['skill']})).status,200);
 assert.equal((await call('timeline',{})).status,400);
});

test('revision changes retire prior spans and repeated spans do not duplicate citation state',async t=>{
 const {rememberEvidence}=await import('../dist/evidence-ledger.js');const records=new Map();
 const first={...record,ocrText:'first',evidenceFingerprint:'v1',textRange:{start:0,end:5}};
 rememberEvidence(records,first);rememberEvidence(records,first);assert.equal(records.get(record.id).deliveredRanges.length,1);
 rememberEvidence(records,{...first,ocrText:'new',evidenceFingerprint:'v2',textRange:{start:100,end:103}});
 assert.deepEqual(records.get(record.id).deliveredRanges,[{start:100,end:103,text:'new'}]);
});
test('host context observes schema and system size without approximating provider capacity',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const {metrics}=assembleContext({question:'generated'},[],'system',[{name:'evidence'}],4096);
 assert.equal(metrics.system,6);assert.equal(metrics.outputTokenReserve,4096);assert.equal(metrics.unit,'utf16_characters');assert.equal(metrics.evidence,2,'absent seed fields are not counted as delivered wire fields');
 assert.equal(assembleContext({question:'generated'},[],'x'.repeat(180000),[],4096).metrics.system,180000);
 const limited=JSON.parse(assembleContext({question:'generated'},[],'system',[],4096,7).prompt);
 assert.equal(limited.maxToolCalls,7);
 assert.equal(buildContextEnvelope({question:'Extract',evidenceIds:['one']},[]).retrievalInstruction,undefined,'Bounded extraction is not given archive convergence instructions');
});

test('bounded evidence does not silently change an ordinary answer into memory extraction',()=>{
 assert.equal(buildContextEnvelope({question:'Answer this',evidenceIds:['one']},[]).responseMode,'answer');
 assert.equal(buildContextEnvelope({question:'Extract',skill:'memory-extraction',evidenceIds:['one']},[]).responseMode,'memory-extraction');
});

test('bounded extraction supplies the unchanged procedure, draft and originals without archive discovery instructions',()=>{
 const input={question:'Exact host admission contract',skill:'memory-extraction',evidenceIds:[record.id],evidenceRanges:[{id:record.id,offset:0,length:record.ocrText.length}],taskContext:{untrustedMemoryDraft:{memories:[{statement:'Untrusted draft'}]}}};
 const envelope=buildContextEnvelope(input,[record]);
 const {commonContextRef,...body}=envelope.untrustedEvidence[0];
 assert.equal(envelope.request,input.question);assert.deepEqual(JSON.parse(JSON.stringify({...envelope.evidenceContexts[commonContextRef],...body})),record);assert.deepEqual(envelope.untrustedTaskContext,input.taskContext);
 assert.match(envelope.procedure,/Preserve the subject, speaker, tense, uncertainty/);
 assert.match(envelope.procedureInstruction,/no skill tool call is required/);
 assert.match(envelope.disclosurePolicy,/Archive discovery tools are unavailable/);
 assert.doesNotMatch(envelope.disclosurePolicy,/material_catalog|search_context|context_index/);
});

test('host derived-context dependencies are authorization metadata and never new evidence seeds or tool scope',()=>{
 const input={question:'Compare a derived rule',evidenceIds:['candidate-only'],derivedContextEvidenceIds:['private-root-only'],taskContext:{turns:[],untrustedMemoryDraft:{statement:'The derived rule'}}};
 const envelope=buildContextEnvelope(input,[]);assert.equal(JSON.stringify(envelope).includes('private-root-only'),false);assert.deepEqual(taskTools(input),['evidence']);
});


test('large Memory catalogs and review drafts share exact declaration and source metadata without a host quota',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const context={version:1,ownerRelation:'unknown',basis:'default',sourceContextStatements:[{description:'Generated source declaration. '.repeat(80),version:1}]};
 const members=Array.from({length:24},(_,i)=>({key:String(i).padStart(64,'a'),id:'generated-'+i,offset:i*100,length:100,fingerprint:'f'.repeat(64),contextTime:'2026-10-01T00:00:00Z',attributionContext:context,state:'pending',memoryIds:[]}));
 const work={members,contextMembers:[],authorizedMembers:members.map(m=>({...m,scope:'generated'})),history:[],instruction:'Generated complete work contract'};
 const input={question:'Generated review',taskContext:{turns:[],memoryWork:work,untrustedMemoryDraft:'Generated draft. '.repeat(1100)}};
 assert.ok(JSON.stringify(input.taskContext).length>80000);
 const {prompt,metrics}=assembleContext(input,[],'Generated system',[],4096),wire=JSON.parse(prompt).untrustedTaskContext.memoryWork;
 assert.ok(metrics.task<80000);assert.equal(wire.members.length,24);assert.equal(wire.authorizedMembers.length,24);
 for(const [i,m] of wire.members.entries()){const shared=wire.commonContexts[m.commonContextRef];assert.equal(m.key,'member_'+i);assert.equal(m.offset,members[i].offset);assert.equal(shared.contextTime,members[i].contextTime);assert.deepEqual(wire.attributionContexts[shared.attributionContextRef],context);assert.equal(wire.authorizedMembers[i].memberRef,m.key);assert.equal(m.fingerprint,undefined);}
 assert.equal(input.taskContext.memoryWork.members[0].attributionContext,context,'wire compaction cannot mutate host authority or cache inputs');
 const changed={...members[0],attributionContext:{...context,ownerRelation:'owner'}};
 const other=JSON.parse(assembleContext({...input,taskContext:{...input.taskContext,memoryWork:{...work,authorizedMembers:[changed]}}},[],'Generated',[],4096).prompt).untrustedTaskContext.memoryWork;
 assert.equal(other.authorizedMembers[0].memberRef,undefined,'matching keys with different context must not be silently deduplicated');
});

test('coverage aliases round-trip only exact identities from this call, including reviewer drafts and context references',async()=>{
 const keys=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
 const work={members:[{key:keys[0],id:'target'}],contextMembers:[{key:keys[1],id:'context'}],authorizedMembers:[{key:keys[2],id:'unread'}],history:[{targets:[{key:keys[0],contextRefs:[keys[1]]}],contextMembers:[]}],instruction:'Generated'};
 const draft={memories:[{statement:'member_0 remains literal prose',evidence:[{id:'target',quote:'member_0'}]}],coverage:[{key:keys[0],contextRefs:[keys[1],'material:unchanged'],state:'needs_context',candidateIndexes:[]}],capacity:{saturated:false}};
 const task={turns:[],memoryWork:work,untrustedMemoryDraft:draft},wire=compactMemoryTaskContext(task);
 assert.equal(wire.memoryWork.contextEncoding,'memory-context@3');assert.equal(wire.untrustedMemoryDraft.coverage[0].key,'member_0');assert.deepEqual(wire.untrustedMemoryDraft.coverage[0].contextRefs,['member_1','material:unchanged']);
 assert.deepEqual(JSON.parse(restoreMemoryCoverageKeys(JSON.stringify(wire.untrustedMemoryDraft),task)),draft);
 assert.deepEqual(wire.untrustedMemoryDraft.memories,draft.memories,'claims and quotes are not alias substitution targets');
 assert.equal(wire.memoryWork.history[0].targets[0].key,'member_0');assert.equal(wire.memoryWork.history[0].targets[0].contextRefs[0],'member_1');
 const unknown=JSON.stringify({coverage:[{key:'member_999'},{key:'member_00'},{key:keys[0].slice(0,62)}]});
 assert.equal(restoreMemoryCoverageKeys(unknown,task),unknown,'unknown aliases and corrupted canonical keys are never guessed');
 const contextOnly=JSON.parse(restoreMemoryCoverageKeys(JSON.stringify({coverage:[{key:'member_1'}]}),task));assert.equal(contextOnly.coverage[0].key,keys[1],'host target validation still rejects context-only coverage');
 assert.equal(restoreMemoryCoverageKeys('not JSON',task),'not JSON');assert.deepEqual(compactMemoryTaskContext(wire),wire);
 assert.equal(task.memoryWork.members[0].key,keys[0]);assert.deepEqual(task.untrustedMemoryDraft,draft);
});

test('large host task context is retained and measured without local character rejection',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const draft='x'.repeat(181000),assembled=assembleContext({question:'Generated',taskContext:{turns:[],draft}},[],'system',[],4096),wire=JSON.parse(assembled.prompt);
 assert.equal(wire.untrustedTaskContext.draft,draft);assert.ok(assembled.metrics.task>180000);assert.equal(wire.contextBudget,undefined);assert.equal(wire.maxToolCalls,undefined);
});

test('historical dialogue status is visible while its privacy and permission receipts remain host-only',()=>{
 const dependencies={version:1,complete:true,ids:['generated-private-root']},historyContext={conversationId:'generated-private-conversation',revision:1,turns:[{id:'generated-private-turn',runId:'generated-private-run'}],evidenceDependencies:dependencies};
 const envelope=buildContextEnvelope({question:'Explain an earlier proposal',historyContext,historicalSelection:{evidenceIds:['generated-private-selection']},conversation:{historyContext,evidenceDependencies:dependencies,turns:[{question:'Generated',answer:'The second proposal was a glider.',scope:{},createdAt:'2026-10-01T00:00:00Z',evidenceStale:true,evidenceUnavailable:true}],omittedTurns:0}},[]);
 assert.equal(envelope.conversation.turns[0].evidenceStale,true);assert.equal(envelope.conversation.turns[0].evidenceUnavailable,true);assert.match(envelope.conversation.turns[0].answer,/second proposal/);
 assert.doesNotMatch(JSON.stringify(envelope),/generated-private-|historyContext|evidenceDependencies|historicalSelection/);
 assert.match(systemInstructions({question:'Generated follow-up'},[]),/resolve earlier proposals.*never as verified current facts/);
});

test('disabled archive image disclosure removes image tools and guides OCR-only Memory without granting pixels',()=>{
 const input={question:'Generated OCR review',evidenceIds:['generated'],processingImages:[{id:'generated',originalSha256:'a'.repeat(64)}],archiveImagesEnabled:false};
 assert.ok(!taskTools(input).includes('read_image'));
 assert.ok(!dispatchTools(input).includes('read_image'));
 assert.ok(!registeredContextToolDefinitions(input).some(([name])=>name==='read_image'));
 const pinned=pinContextTools(input,{});
 assert.deepEqual(pinContextTools({...pinned,archiveImagesEnabled:true},{}).contextCapabilitySnapshot,pinned.contextCapabilitySnapshot,'availability does not alter the saved schema manifest');
 const envelope=buildContextEnvelope(input,[]);
 assert.equal(envelope.authorizedImages,undefined);
 assert.match(envelope.imageEvidenceInstruction,/disabled/);
 assert.match(envelope.imageEvidenceInstruction,/incomplete/);
 assert.ok(!taskTools({question:'Generated archive question',archiveImagesEnabled:false}).includes('read_image'));
 assert.ok(taskTools({...input,archiveImagesEnabled:true}).includes('read_image'));
 assert.ok(taskTools({question:'Generated attachment',archiveImagesEnabled:false,directImages:[{id:'generated-dialogue'}]}).includes('read_image'));
});


test('selected original Ask answers normally while explicit Memory and Calendar tasks retain extraction output',async t=>{
 const input={question:'Distinguish this generated original from my comment',evidenceIds:[record.id]};
 assert.deepEqual(buildContextEnvelope(input,[record]).taskProfile,{output:'answer',retrieval:'evidence'});
 assert.deepEqual(taskTools(input),['evidence']);
 for(const memory of [{responseMode:'memory-extraction'},{skill:'memory-extraction'},{skill:'coding-memory'}])assert.deepEqual(buildContextEnvelope({...input,...memory},[record]).taskProfile,{output:'memory-extraction',retrieval:'evidence'});
 assert.deepEqual(buildContextEnvelope({...input,skill:'calendar-extraction'},[record]).taskProfile,{output:'calendar-extraction',retrieval:'evidence'});
 const {bridge,call}=await fixture(t,input);
 assert.equal(bridge.records.has(record.id),true,'the selected original is delivered to the actual bridge');
 const denied=await call('evidence',{ids:['different-generated-original']});assert.notEqual(denied.status,200,'answer output mode never widens evidence tool authority');
 assert.equal((await call('search_context',{query:'unrelated archive'})).status,400,'exact Ask never exposes archive discovery');
});

test('record references remain unread starting points while ordinary discovery can retrieve and cite a second original',async t=>{
 const other={...record,id:'7289a721-2737-4b57-a474-24f13b44fa5a',ocrText:'Generated related original: the blue observatory opens at 16:10.'};
 const reads=[],input={question:'Compare this record with relevant context',anchorEvidenceIds:[record.id],deviceId:'fixture',after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z',processingEvidence:{[record.id]:'host-only-pin'},contextEvidenceDependencies:{version:1,complete:true,ids:[record.id]}};
 const envelope=buildContextEnvelope(input,[]);
 assert.deepEqual(envelope.referenceEvidenceIds,[record.id]);assert.match(envelope.referenceInstruction,/Inspect them first with evidence/);assert.match(envelope.referenceInstruction,/not a restriction.*or an additional authorization/);assert.match(envelope.referenceInstruction,/time and device scope/);
 assert.equal(envelope.untrustedEvidence,undefined);assert.equal(envelope.request,input.question);assert.ok(!JSON.stringify(envelope).includes(record.ocrText));assert.ok(!JSON.stringify(envelope).includes('host-only-pin'));
 assert.deepEqual(envelope.taskProfile,{output:'answer',retrieval:'archive'});assert.ok(taskTools(input).includes('search_context'));assert.ok(taskTools(input).includes('evidence'));
 const referenceReader={...reader,evidence:async args=>{reads.push(args);return [record,other].filter(item=>args.ids.includes(item.id));},search:async()=>[other]};
 const bridge=await startBridge(referenceReader,input,12);t.after(()=>bridge.close());
 assert.equal(reads.length,0,'an anchor ID does not pre-deliver its original body');assert.equal(bridge.records.has(record.id),false);assert.equal(bridge.records.has(other.id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:'Unverified reference claim',citationIds:[record.id]}),bridge.records),/not retrieved/);
 const call=async(tool,args)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
 assert.equal((await call('evidence',{ids:[record.id],length:100})).status,200);assert.equal(bridge.records.has(record.id),true);
 const discovered=await call('search_context',{query:'blue observatory'});assert.equal(discovered.status,200);assert.match(discovered.body.data[0].ocrText,/16:10/);
 assert.equal((await call('evidence',{ids:[other.id]})).status,200,'ordinary evidence reads are not narrowed to the starting record');
 const result=parseAnswer(JSON.stringify({answer:'The related original gives 16:10.',citationIds:[other.id]}),bridge.records);assert.equal(result.citations[0].id,other.id);assert.match(result.citations[0].excerpt,/16:10/);
 assert.equal((await call('search_context',{query:'blue observatory',deviceId:'different-device'})).status,400,'a reference record cannot override the explicit device restriction');
 assert.equal((await call('search_context',{query:'blue observatory',after:'2026-11-01T00:00:00Z'})).status,400,'a reference record cannot widen the explicit time restriction');
});

test('query and working packs keep host grants bounded and unknown source protocols conservative',async t=>{
 const working={question:'Generated working compaction',skill:'working-memory'},preparedWorking=prepareTaskContext(working);
 assert.equal(preparedWorking.id,'working');assert.equal(preparedWorking.version,'1');assert.deepEqual(preparedWorking.profile,{output:'answer',retrieval:'none'});
 assert.deepEqual(taskTools(working),[]);assert.deepEqual(dispatchTools(working),[]);
 const selected={question:'Generated selected original',evidenceIds:[record.id]},preparedSelected=prepareTaskContext(selected);
 assert.equal(preparedSelected.id,'selected-answer');assert.equal(preparedSelected.version,'1');assert.deepEqual(preparedSelected.profile,{output:'answer',retrieval:'evidence'});
 assert.deepEqual(taskTools(selected),['evidence']);
 const {call}=await fixture(t,selected);
 assert.equal((await call('search_context',{query:'generated archive'})).status,400,'selected answer never exposes archive discovery');
 assert.notEqual((await call('evidence',{ids:['different-generated-original']})).status,200,'selected answer never widens the host evidence grant');
 assert.equal(systemInstructions({question:'Generated bounded',evidenceIds:[record.id]},[{...record,sourceType:'generated-unknown-protocol'}]),SYSTEM_PROMPT.replace(ARCHIVE_RECENCY_INSTRUCTIONS+'\n',''),'unknown source protocols keep the conservative complete rules');
});

function runtimeFixture(engine,query,assembled){
 const requests=[],controller=new AbortController(),scopeIdentity={packageId:'generated',installationId:'generated',instanceId:'generated',activationId:'generated',host:{kind:'central',id:'generated'}};
 const binding=service=>({service:{id:service,apiVersion:'1'},provider:{scope:scopeIdentity,contributionId:service},revision:1});
 const lease=(service,value)=>({binding:binding(service),value,signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();},async release(){}});
 const model={modelId:'generated-model',modelRevision:1,profileId:'generated-model-profile',profileRevision:1,transport:'generated'};
 const runtime=lease('mote.agent.runtime',{capabilities:{},async prepare(_profile,_model,host){
  host.emit({type:'tools.ready',tools:[]},null);
  return {async run(request){requests.push(request);return {terminal:{kind:'completed'},candidate:{text:JSON.stringify({answer:'Generated answer',citationIds:[]})}};},async repair(request){return this.run(request);},async cancel(){},async close(){}};
 }});
 const profile={binding:runtime.binding,runtimeId:engine,profileId:'generated-runtime-profile',profileRevision:7,assemblyFingerprint:'a'.repeat(64),taskKind:'query',configuration:{}};
 const dependencies={scope:{identity:scopeIdentity,signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();},defer(){}},identity:{runId:`generated-${engine}`,runtime:{id:engine,revision:1,profileId:profile.profileId,profileRevision:7,assemblyFingerprint:profile.assemblyFingerprint},model},input:query,profile,runtime,model:{...lease('generated.model',{}),selection:model},output:lease('mote.agent.host-output',createHostOutputProvider()),tools:{definitions:[],bindings:[],assertCurrent(){}},budget:{activeTimeoutMs:null},activeBudget:new ActiveExecutionBudget(null),commitFence:{assertCurrent(){}}};
 const evidence={records:new Map(),deliveredRanges:[],imageReadReceipts:[],sourceContextDependencies:[],evidenceDependencies:{version:1,complete:true,ids:[]},trace:[],deliveredCharacters:0};
 return {requests,create:()=>createHostRunSession(dependencies,{systemPrompt:assembled.system,prompt:assembled.prompt,outputSchema:assembled.outputSchema,contextUsage:{...assembled.metrics,toolResults:0},evidence:()=>evidence,async readTool(){throw new Error('No tool expected');},async close(){}})};
}

test('real query input and seed reach both runtime prompts with one selected scope and language',async t=>{
 const seed={...record,sourceType:'note',provenance:{sourceId:'generated-source',uri:'material:generated#0'}};
 const common={question:'Generated scope check',language:'en-US',after:'2026-01-01T00:00:00Z',before:'2026-02-01T00:00:00Z',deviceId:'generated-device',timeZone:'Asia/Shanghai'};
 const cases=[
  {...common,taskId:'answer',system:/Research the user's requested points with read-only evidence/},
  {...common,evidenceIds:[seed.id],evidenceRanges:[{id:seed.id,offset:0,length:seed.ocrText.length}],taskId:'selected-answer',system:/Restricted extraction sessions use only host-authorized original evidence/},
 ];
 for(const expected of cases){
  const input={...expected};delete input.taskId;delete input.system;
  const assembled=assembleHostContext(input,[seed],1024),envelope=JSON.parse(assembled.prompt);
  assert.equal(envelope.taskId,expected.taskId);assert.equal(envelope.language,'en-US');
  assert.deepEqual(envelope.selectedTimeRange,{after:common.after,before:common.before});assert.equal(envelope.selectedDeviceId,'generated-device');assert.equal(envelope.timeZone,'Asia/Shanghai');
  assert.equal(envelope.untrustedEvidence[0].id,seed.id);assert.match(assembled.system,expected.system);
  for(const engine of ['dsh-fixture','codex-fixture']){
   const fixture=runtimeFixture(engine,input,assembled),session=await fixture.create();
   try{
    const answer=await session.execute();assert.equal(answer.answer,'Generated answer');
    assert.equal(fixture.requests.length,1);assert.equal(fixture.requests[0].prompt,assembled.prompt);assert.deepEqual(fixture.requests[0].outputSchema,assembled.outputSchema);
    const received=JSON.parse(fixture.requests[0].prompt);
    assert.equal(received.language,envelope.language);assert.deepEqual(received.selectedTimeRange,envelope.selectedTimeRange);assert.equal(received.selectedDeviceId,envelope.selectedDeviceId);assert.equal(received.taskId,envelope.taskId);
   }finally{await session.close();}
  }
 }
});
