import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  assistantDraftCommandSchema, assistantDraftProposalSchema, assistantDraftSchema,
  assistantTaskInputSchema, assistantTaskRecordSchema, attributionContextSchema,
  codingEvidenceSchema, conversationMessageInputSchema, conversationMessageSchema,
  documentSchema, evidenceDependenciesSchema, fileViewSchema, modelBudgetSchema, queryScopeSchema,
  sourceEvidenceRevisionSchema, workspaceTemplateSchema,
} from '../dist/index.js';
import {acceptUiContribution,parseUiContribution} from '../dist/plugin-ui.js';

const roundTrip=(schema,value)=>schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));
const sourceA='generated.source-a',sourceB='generated.source-b';
const captureA=randomUUID(),captureB=randomUUID();
const originals=[{sourceId:sourceA,captureId:captureA},{sourceId:sourceB,captureId:captureB}];

test('explicit source scopes survive JSON, including empty selections and empty evidence filters',()=>{
  // An illustrative consumer of the wire discriminator, not an authority check.
  const select=(scope)=>originals.filter(item=>
    (scope.kind==='all'||scope.sourceIds===undefined||scope.sourceIds.includes(item.sourceId))&&
    (scope.evidenceIds===undefined||scope.evidenceIds.includes(item.captureId)));
  for(const [input,expected] of [
    [{kind:'all'},originals],
    [{kind:'selection',sourceIds:[sourceB]},[originals[1]]],
    [{kind:'selection',sourceIds:[]},[]],
    [{kind:'selection',evidenceIds:[captureA]},[originals[0]]],
    [{kind:'selection',evidenceIds:[]},[]],
    [{kind:'all',evidenceIds:[]},[]],
    [{kind:'selection',sourceIds:[sourceA],evidenceIds:[captureB]},[]],
  ])assert.deepEqual(select(roundTrip(queryScopeSchema,input)),expected);
  for(const invalid of [
    {},{kind:'selection'},{kind:'selection',sourceIds:null},{kind:'all',sourceIds:[sourceA]},
    {kind:'selection',sourceIds:[],anchorEvidenceIds:[captureA]},
    {kind:'all',after:'2026-11-14T00:00:00Z',before:'2026-11-13T00:00:00Z'},
  ])assert.equal(queryScopeSchema.safeParse(invalid).success,false);
});

test('context window and output limit remain distinct and conservative estimates are labelled',()=>{
  const input={contextWindow:8000,maxTokens:1200,lowWatermarkRatio:0.8,tokenCounting:'estimated',contextWindowSource:'conservative'};
  assert.deepEqual(roundTrip(modelBudgetSchema,input),{...input,historyRatio:0.5});
  assert.equal(modelBudgetSchema.parse({...input,lowWatermarkRatio:0}).lowWatermarkRatio,0);
  assert.equal(modelBudgetSchema.safeParse({...input,lowWatermarkRatio:1}).success,false);
  assert.equal(modelBudgetSchema.safeParse({...input,contextWindowSource:undefined}).success,false);
  assert.equal(modelBudgetSchema.safeParse({...input,historyRatio:1.1}).success,false);
});

test('message and task round trips retain scope, anchors, versions and original dependencies',()=>{
  const scope={kind:'selection',sourceIds:[sourceA],deviceId:'generated-device',
    after:'2026-01-01T00:00:00Z',before:'2027-01-01T00:00:00Z',timeZone:'Asia/Shanghai',evidenceIds:[captureA]};
  const input={conversationId:randomUUID(),clientRequestId:randomUUID(),question:'  Generated request  ',scope,
    attachmentIds:[captureA],anchorEvidenceIds:[captureA]};
  const message={id:randomUUID(),...input,seq:4,revision:2,status:'accepted',createdAt:'2026-11-13T00:00:00Z',evidenceStale:true,
    historyEvidenceDependencies:{version:1,complete:true,ids:[captureA]}};
  assert.deepEqual(roundTrip(conversationMessageSchema,message),message);
  assert.deepEqual(roundTrip(conversationMessageInputSchema,{...input,scope:{kind:'selection',sourceIds:[]}}).scope,{kind:'selection',sourceIds:[]});
  assert.equal(conversationMessageInputSchema.safeParse({...input,anchorMaterialRef:'material:mat_'+ 'a'.repeat(64)+'@'+'b'.repeat(64)}).success,false);
  assert.equal(conversationMessageSchema.safeParse({...message,status:'unrecognized'}).success,false);

  const taskInput={requestId:randomUUID(),goal:'  Generated goal  ',scope};
  const task={id:randomUUID(),...taskInput,revision:3,state:'running',
    evidenceDependencies:{version:1,complete:true,ids:[captureA]},
    sourceEvidenceRevisions:[{sourceId:sourceA,externalId:'file:a',revision:'1',captureId:captureA,layer:'snapshot'}],
    sourceContextDependencies:[{sourceId:sourceA,version:2,fingerprint:'c'.repeat(64)}]};
  assert.deepEqual(roundTrip(assistantTaskInputSchema,taskInput),taskInput);
  assert.deepEqual(roundTrip(assistantTaskRecordSchema,task),task);
  assert.equal(assistantTaskRecordSchema.safeParse({...task,evidenceDependencies:{...task.evidenceDependencies,version:2}}).success,false);
  assert.equal(assistantTaskRecordSchema.safeParse({...task,state:'unrecognized'}).success,false);
  assert.equal(evidenceDependenciesSchema.safeParse({version:1,complete:true,ids:['artifact:generated:1']}).success,false);
});

test('independent sources can have the same content hash without becoming the same evidence or grant',()=>{
  const one={sourceId:sourceA,externalId:'file:a',revision:'1',captureId:captureA,layer:'snapshot'};
  const two={sourceId:sourceB,externalId:'file:b',revision:'1',captureId:captureB,layer:'snapshot'};
  assert.deepEqual(roundTrip(sourceEvidenceRevisionSchema,one),one);
  assert.deepEqual(roundTrip(sourceEvidenceRevisionSchema,two),two);
  assert.notDeepEqual(one,two);
  assert.equal(sourceEvidenceRevisionSchema.safeParse({...one,layer:'derived'}).success,false);

  const index={version:1,fileId:'file:a',contentVersion:'a'.repeat(64),mode:'index',coverage:'none',
    parser:'generated',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:true};
  const file={captureId:captureA,sourceId:sourceA,retention:'snapshot',hasOriginal:false,originMissing:true,canOpenOriginal:false,
    item:{externalId:'file:a',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'snapshot',title:'Generated',text:'',deleted:false,document:{fileIndex:index}},
    coverage:{extraction:{status:'partial',completed:1,total:2},semantic:{status:'pending'},embedding:{status:'unsupported',reason:'Generated capability unavailable'}}};
  assert.deepEqual(roundTrip(fileViewSchema,file),file);
  const other={...file,captureId:captureB,sourceId:sourceB,item:{...file.item,externalId:'file:b',document:{fileIndex:{...index,fileId:'file:b'}}}};
  assert.equal(roundTrip(fileViewSchema,other).item.document.fileIndex.contentVersion,index.contentVersion);
  assert.notEqual(other.captureId,file.captureId);
  const reference={...file,retention:'reference',item:{...file.item,layer:'reference',document:{fileIndex:{...index,mode:'catalog',allowRead:false}}}};
  assert.deepEqual(roundTrip(fileViewSchema,reference),reference);
  assert.equal(fileViewSchema.safeParse({...reference,item:{...reference.item,text:'Must not retain original content'}}).success,false);
  const archive={...file,retention:'archive',hasOriginal:true,originMissing:false,canOpenOriginal:true,
    item:{...file.item,layer:'original',document:{fileIndex:{...index,mode:'archive',allowRead:false}}}};
  assert.deepEqual(roundTrip(fileViewSchema,archive),archive);
  assert.equal(fileViewSchema.safeParse({...file,coverage:{...file.coverage,extraction:{status:'ready',completed:1,total:2}}}).success,false);
  assert.equal(fileViewSchema.safeParse({...file,retention:undefined}).success,false);
  assert.equal(fileViewSchema.safeParse({...file,item:{...file.item,document:{fileIndex:{...index,version:2}}}}).success,false);
});

test('unknown attribution and occurrence remain explicit or absent in existing source and coding contracts',()=>{
  const attribution={version:1,ownerRelation:'unknown',basis:'default'};
  assert.deepEqual(roundTrip(attributionContextSchema,attribution),attribution);
  assert.deepEqual(roundTrip(documentSchema,{timeBasis:'unknown'}),{timeBasis:'unknown'});
  const coding={version:1,provider:'codex',sessionId:'generated',projectIdentity:'unknown',projectKey:'generated',eventId:'1',role:'user',attribution:'unknown',part:0,parts:1};
  assert.deepEqual(roundTrip(codingEvidenceSchema,coding),coding);
  for(const name of ['project','person','travel','reading'])assert.equal(workspaceTemplateSchema.parse(name),name);
  assert.equal(workspaceTemplateSchema.safeParse('arbitrary-template').success,false);
  const descriptor=parseUiContribution({id:'generated.view',kind:'declarative-view',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'generated',i18nNamespace:'generated'},data:{schemaRef:'generated.data',schemaVersion:2}});
  assert.equal(acceptUiContribution([],{packageId:'generated',descriptor},{'generated.data':[1]}).accepted,false);
  assert.equal(acceptUiContribution([],{packageId:'generated',descriptor},{'generated.data':[2]}).accepted,true);
});

test('draft proposals carry only a goal; the host binds identity, scope and capabilities',()=>{
  const proposal={goal:'Generated follow-up'};
  assert.deepEqual(roundTrip(assistantDraftProposalSchema,proposal),proposal);
  for(const invalid of [{goal:''},{goal:'   '},{goal:'Generated',scope:{kind:'all'}},{goal:'Generated',requestId:randomUUID()},{goal:'Generated',capability:'assistant.task.start'}])
    assert.equal(assistantDraftProposalSchema.safeParse(invalid).success,false);

  const draft={requestId:randomUUID(),revision:1,goal:'Generated follow-up',scope:{kind:'selection',sourceIds:[sourceB]},capabilities:['assistant.task.preview']};
  assert.deepEqual(roundTrip(assistantDraftSchema,draft),draft);
  assert.equal(assistantDraftSchema.safeParse({...draft,capabilities:[]}).success,false);
  assert.equal(assistantDraftSchema.safeParse({...draft,capabilities:['assistant.task.preview','assistant.task.preview']}).success,false);
  assert.equal(assistantDraftSchema.safeParse({...draft,capabilities:['assistant.task.send']}).success,false);

  const command={conversationId:randomUUID(),turnId:randomUUID(),requestId:draft.requestId,expectedRevision:1,capability:'assistant.task.preview',goal:draft.goal,scope:draft.scope};
  assert.deepEqual(roundTrip(assistantDraftCommandSchema,command),command);
  assert.equal(assistantDraftCommandSchema.safeParse({...command,capability:'assistant.task.send'}).success,false);
  assert.equal(assistantDraftCommandSchema.safeParse({...command,scope:{kind:'all'}}).success,true,'scope is checked against the stored draft by the host, not by the wire schema');
});
