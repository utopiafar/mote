import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {assembleContext,buildContextEnvelope} from '../dist/task-context.js';
import {compactSeedEvidence} from '../dist/tasks/evidence-rules.js';
import {compactMemoryTaskContext,compactMemoryReadCatalog,restoreMemoryCoverageKeys} from '../dist/tasks/memory-context.js';
import {startBridge} from '../dist/bridge.js';

const canon=value=>JSON.parse(JSON.stringify(value));
function expandMember(work,row){if(row.memberRef)return expandMember(work,[...work.members,...work.contextMembers,...work.authorizedMembers].find(value=>value.key===row.memberRef&&!value.memberRef));const {commonContextRef,...member}=row;const shared=work.commonContexts[commonContextRef],{attributionContextRef,...context}=shared;return {...member,...context,...(attributionContextRef?{attributionContext:work.attributionContexts[attributionContextRef]}:{})};}
function expandEvidence(envelope,row){const {commonContextRef,provenanceUri,...body}=row,context=envelope.evidenceContexts[commonContextRef],source=context.provenance;return canon({...context,...body,...(source&&typeof source==='object'&&!Array.isArray(source)?{provenance:{...source,...(provenanceUri===undefined?{}:{uri:provenanceUri})}}:{})});}
function expandRange(work,row){const member=row.memberRef?expandMember(work,[...work.members,...work.contextMembers,...work.authorizedMembers].find(value=>value.key===row.memberRef)):row;return {id:member.id,offset:member.offset,length:member.length};}
const key=label=>createHash('sha256').update(label).digest('hex');

test('shared metadata preserves every original, declaration and exact grant without copying host fingerprints',()=>{
 const context={version:1,ownerRelation:'owner',basis:'owner_material',ownerStatements:[{id:'generated',version:1,answer:'Generated diary declaration 🌱'}]};
 const members=Array.from({length:5},(_,i)=>({key:key('member-'+i),id:randomUUID(),offset:i,length:3,fingerprint:key('fingerprint-'+i),materialRef:'material:generated@version',sourceId:'generated',contextTime:'2017-08-19T06:30:00Z',attributionContext:context,state:'pending',memoryIds:[]}));
 const changed={...members[4],contextTime:'2016-08-19T06:30:00Z',attributionContext:{...context,ownerRelation:'third_party'}};
 const original={turns:[],memoryWork:{members:members.slice(0,2),contextMembers:[members[2]],authorizedMembers:[...members.slice(0,4),changed],history:[{targets:[{...members[0],state:'needs_context',contextRefs:[members[2].key],memoryIds:['generated-memory']}],contextMembers:[members[2]]}]}};
 const copy=structuredClone(original),wire=compactMemoryTaskContext(original),work=wire.memoryWork;
 assert.deepEqual(original,copy);assert.equal(work.members.length,2);assert.equal(work.authorizedMembers.length,5);assert.equal(Object.keys(work.commonContexts).length,2);
 for(const [index,row] of work.authorizedMembers.entries()){const {fingerprint,state,memoryIds,...expected}=index===4?changed:members[index];const {key:alias,...actual}=expandMember(work,row);assert.deepEqual(canon(actual),canon({...expected,key:undefined}));assert.equal(row.fingerprint,undefined);assert.ok(alias.startsWith('member_'));}
 const history=expandMember(work,work.history[0].targets[0]);assert.equal(history.state,'needs_context');assert.deepEqual(history.memoryIds,['generated-memory']);
 const draft={memories:[],coverage:work.members.map(row=>({key:row.key,state:'no_candidates',candidateIndexes:[]}))};
 assert.deepEqual(JSON.parse(restoreMemoryCoverageKeys(JSON.stringify(draft),original)).coverage.map(row=>row.key),members.slice(0,2).map(row=>row.key));
 const grants=members.map(({id,offset,length})=>({id,offset,length}));grants.push({id:members[0].id,offset:0,length:30});
 const projected=compactMemoryReadCatalog(grants,wire);assert.deepEqual(projected.map(row=>expandRange(work,row)),grants);assert.deepEqual(projected.at(-1),grants.at(-1),'a larger interval cannot be replaced by a smaller member');
});

test('seed metadata references retain exact per-record body, time, speaker and URI including opaque metadata',()=>{
 const common={capturedAt:'2017-08-19T06:30:00Z',appName:'Generated',attributionContext:{version:1,ownerRelation:'unknown',basis:'default'},provenance:{sourceId:'generated',document:{timeBasis:'recorded',recordedAt:'2017-08-18T06:30:00Z',contentRole:'transcript'}}};
 const records=Array.from({length:3},(_,i)=>({...common,id:randomUUID(),ocrText:'Generated statement '+i+' 🌱',evidenceFingerprint:key('record-'+i),textRange:{start:0,end:24},estimatedReadCharacters:24+i,provenance:{...common.provenance,uri:'material:generated#'+i}}));
 records.push({...records[0],id:randomUUID(),provenance:'opaque generated metadata'});
 const projection=compactSeedEvidence(records),envelope={untrustedEvidence:projection.records,evidenceContexts:projection.contexts};assert.equal(Object.keys(projection.contexts).length,2);
 for(const [index,row] of envelope.untrustedEvidence.entries()){const {evidenceFingerprint,...original}=records[index];assert.deepEqual(expandEvidence(envelope,row),canon(original));assert.equal(row.evidenceFingerprint,undefined);}
 assert.ok(records.every(record=>record.evidenceFingerprint),'provider representation never mutates canonical host records');
});

test('4097 originals with a reviewer draft remain readable through the full catalog within native Codex input capacity',async t=>{
 const contexts=Array.from({length:17},(_,i)=>({version:1,ownerRelation:'unknown',basis:'default',sourceContextStatements:[{id:'generated-'+i,version:1,description:'Generated source declaration. '.repeat(30)}]}));
 const records=Array.from({length:4097},(_,i)=>({id:randomUUID(),capturedAt:'2017-08-18T06:30:00Z',appName:'Generated source '+i%17,deviceId:'generated',ocrText:'Generated original '+i+' 🌱',attributionContext:contexts[i%17],provenance:{sourceId:'generated-'+i%17,layer:'original',document:{recordedAt:'2017-08-18T06:30:00Z',timeBasis:'recorded',contentRole:'transcript'},uri:'material:generated-'+i%17+'#'+i}}));
 const members=records.map((record,i)=>({key:key('large-'+i),id:record.id,offset:0,length:record.ocrText.length,fingerprint:key('fp-'+i),materialRef:'material:'+key('source-'+i%17)+'@'+key('revision-'+i%17),sourceId:record.provenance.sourceId,contextTime:'2017-08-19T06:30:00Z',attributionContext:record.attributionContext,state:'pending',memoryIds:[]}));
 const targets=members.slice(0,257),ranges=members.map(({id,offset,length})=>({id,offset,length})),draft={memories:Array.from({length:29},(_,i)=>({statement:'Generated independently reviewed claim. '.repeat(20),evidence:[{id:targets[i].id,quote:records[i].ocrText,offset:0}]})),coverage:targets.map(row=>({key:row.key,state:'no_candidates',candidateIndexes:[]}))};
 const input={question:'Generated exact contract. '.repeat(500),responseMode:'memory-extraction',skill:'memory-strategy',evidenceIds:targets.map(row=>row.id),evidenceRanges:ranges.slice(0,257),evidenceReadRanges:ranges,taskContext:{turns:[],memoryWork:{members:targets,contextMembers:[],authorizedMembers:members,history:[],instruction:'Generated complete range evaluation'},untrustedMemoryDraft:draft}};
 const reader={evidence:async({ids})=>records.filter(row=>ids.includes(row.id)),search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),devices:async()=>[],activity:async()=>({})},bridge=await startBridge(reader,input);t.after(()=>bridge.close());
 const assembled=assembleContext(input,bridge.seedEvidence,'Generated system',[],65536),envelope=JSON.parse(assembled.prompt),work=envelope.untrustedTaskContext.memoryWork;
 assert.equal(work.members.length,257);assert.equal(work.authorizedMembers.length,4097);assert.equal(envelope.untrustedEvidence.length,257);assert.equal(envelope.authorizedContextRanges.ranges.length,4097);
 assert.deepEqual(envelope.authorizedContextRanges.ranges.map(row=>expandRange(work,row)),ranges);assert.equal(assembled.metrics.prompt,assembled.prompt.length);assert.equal(assembled.metrics.task,JSON.stringify(envelope.untrustedTaskContext).length);
 assert.equal(assembled.metrics.evidence,JSON.stringify({untrustedEvidence:envelope.untrustedEvidence,evidenceContexts:envelope.evidenceContexts}).length);
 assert.ok(Array.from(JSON.stringify({taskContext:input.taskContext,seedEvidence:bridge.seedEvidence,evidenceReadRanges:ranges})).length>(1<<20),'independently generated repeated metadata exceeds the real native Unicode input boundary before wire compaction');
 assert.ok(Array.from(assembled.prompt).length<(1<<20),'the real Codex Unicode input boundary is a fixture assertion, never a host reading quota');
 assert.deepEqual(JSON.parse(restoreMemoryCoverageKeys(JSON.stringify(envelope.untrustedTaskContext.untrustedMemoryDraft),input.taskContext)),draft);
 const last=records.at(-1);assert.equal(bridge.records.has(last.id),false,'an unread metadata reference grants no citation authority');
 const response=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:last.id,offset:0,length:12000})});assert.equal(response.status,200);assert.equal((await response.json()).data[0].ocrText,last.ocrText);assert.equal(bridge.records.has(last.id),true);
 const outside=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:randomUUID(),offset:0,length:1})});assert.equal(outside.status,400);
 assert.equal(bridge.seedEvidence.length,257);assert.equal(input.taskContext.memoryWork.authorizedMembers.length,4097);assert.equal(input.taskContext.memoryWork.authorizedMembers[0].fingerprint,members[0].fingerprint);
});
