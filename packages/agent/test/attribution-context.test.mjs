import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
import {taskTools} from '../dist/task-context.js';
import {generatedMaterialPages,materialRef} from './material-page-fixture.mjs';

const importId='638b031c-67a9-437d-a47d-3c3cf7fd16c2',replyId='a3350766-4f13-4f7d-915c-567bdf3ec191';
function fixtureContext(id,instruction,answer='Only the narrator in the first paragraph is me.'){
 return {version:1,ownerRelation:'unknown',basis:'default',sourceDeclaration:{sourceId:'generated-source',version:2,ownerRelation:'unknown'},correction:{version:1,ownerRelation:'unknown'},
  declarations:[{id:replyId,version:3,fingerprint:'b'.repeat(64)}],ownerStatements:[{id:replyId,question:'Which speaker is the owner?',answer}],
  importDeclarations:[{id:importId,version:2,fingerprint:'a'.repeat(64),captureIds:[id]}],importStatements:[{id:importId,version:2,instruction,captureIds:[id]}]};
}
async function open(t,context,extra={}){
 const fixture=generatedMaterialPages({text:'Generated narrator planned a walk. The outcome is unknown.'});
 let current=fixtureContext(fixture.originals[0].id,context.instruction,context.answer),available=true;
 fixture.material.attributionContext=current;
 const rawRead=fixture.reader.materialRead;
 fixture.reader.materialCatalog=async()=>({items:[{...fixture.material,attributionContext:current},{...fixture.material,id:'mat_'+'e'.repeat(64),ref:'material:mat_'+'e'.repeat(64)+'@'+'f'.repeat(64),revision:'f'.repeat(64),attributionContext:current}],nextCursor:null});
 fixture.reader.materialRead=async args=>{if(!available)throw Error('Generated private context is unavailable');const page=await rawRead(args);return {...page,material:{...page.material,attributionContext:current},spans:page.spans.map(span=>({...span,attributionContext:current}))};};
 fixture.reader.evidence=async({ids})=>available?fixture.originals.filter(record=>ids.includes(record.id)).map(record=>({...record,attributionContext:current})):[];
 const bridge=await startBridge(fixture.reader,{question:'Generated attribution transport',...extra},40);t.after(()=>bridge.close());
 const call=async(tool,args={})=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
 return {fixture,bridge,call,get context(){return current;},change(){current={...current,correction:{version:2,ownerRelation:'third_party'},ownerRelation:'third_party',basis:'owner_material'};},deny(){available=false;}};
}
async function pages(call,locator,length=12000){
 let text='',offset=0,expectedFingerprint;const results=[];
 do {const result=await call('attribution_context',{...locator,offset,length,...(expectedFingerprint?{expectedFingerprint}:{})});assert.equal(result.status,200,JSON.stringify(result.body));
  assert.ok(JSON.stringify(result.body).length<=16000);const page=result.body.data;assert.equal(page.offset,offset);assert.equal(page.citationAuthority,false);
  if(expectedFingerprint)assert.equal(page.contextFingerprint,expectedFingerprint);else expectedFingerprint=page.contextFingerprint;
  text+=page.text;offset=page.nextOffset;results.push(result);
 }while(offset!==null);
 return {text,results};
}

test('two catalog items and tiny material pages omit long statement prose without changing scopes or granting citations',async t=>{
 const instruction='x'.repeat(12000),f=await open(t,{instruction});
 const catalog=await f.call('material_catalog',{limit:2});assert.equal(catalog.status,200);assert.equal(catalog.body.data.items.length,2);
 assert.ok(JSON.stringify(catalog.body).length<16000);assert.equal(JSON.stringify(catalog.body).includes(instruction),false);
 assert.deepEqual(catalog.body.data.items[0].attributionContext.importDeclarations,f.context.importDeclarations);
 assert.deepEqual(catalog.body.data.items[0].attributionContextLocator,{ref:materialRef});
 for(const length of [1,128]){const result=await f.call('material_read',{ref:materialRef,length});assert.equal(result.status,200);assert.ok(JSON.stringify(result.body).length<16000);assert.equal(JSON.stringify(result.body).includes(instruction),false);
  assert.equal(result.body.data.material.attributionContext.ownerRelation,'unknown');assert.deepEqual(result.body.data.spans[0].attributionContext.correction,f.context.correction);}
 const before=f.bridge.records.size,read=await pages(f.call,{ref:materialRef});assert.equal(read.text,JSON.stringify(f.context));assert.equal(JSON.parse(read.text).importStatements[0].instruction,instruction);
 assert.equal(f.bridge.records.size,before);assert.throws(()=>parseAnswer(JSON.stringify({answer:`Unread [${f.fixture.originals[0].id}]`,citationIds:[f.fixture.originals[0].id]}),f.bridge.records),/not retrieved/);
 assert.ok(f.bridge.evidenceDependencies.ids.includes(f.fixture.originals[0].id),'context participates in hidden lineage, not citation authority');
});

test('12000-unit notes and 8000-unit owner replies reassemble without increasing either budget',async t=>{
 const instruction='Generated narrator scope. '.repeat(600).slice(0,12000),answer='The owner is only the narrator. '.repeat(300).slice(0,8000),f=await open(t,{instruction,answer});
 assert.equal(instruction.length,12000);assert.equal(answer.length,8000);
 assert.equal((await f.call('material_catalog',{limit:2})).status,200);
 const result=await pages(f.call,{ref:materialRef});assert.equal(result.text,JSON.stringify(f.context));assert.deepEqual(JSON.parse(result.text),f.context);
 assert.ok(f.bridge.deliveredCharacters<=48000);assert.equal(f.bridge.records.size,0);
});

test('escaped 12000-unit notes and 8000-unit owner replies reassemble exactly across budget-fitted UTF-16 pages',async t=>{
 const instruction=('"\\\n😀X').repeat(2000).slice(0,12000),answer='Visitor scope remains separate. '.repeat(300).slice(0,8000),f=await open(t,{instruction,answer});
 assert.equal(instruction.length,12000);assert.equal(answer.length,8000);
 assert.equal((await f.call('material_catalog',{limit:2})).status,200);
 const before=f.bridge.deliveredCharacters;
 const result=await pages(f.call,{ref:materialRef});assert.equal(result.text,JSON.stringify(f.context));assert.deepEqual(JSON.parse(result.text),f.context);
 assert.ok(result.results.length>1);assert.ok(f.bridge.trace.some(row=>row.attributionPage?.budgetLimited));
 assert.equal(f.bridge.records.size,0);assert.equal(f.bridge.deliveredCharacters,before+result.results.reduce((n,r)=>n+JSON.stringify(r.body).length,0));
});

test('original context reads reuse discovery and current scope without expanding delivered evidence',async t=>{
 const f=await open(t,{instruction:'Generated scoped note'}),id=f.fixture.originals[0].id;
 assert.equal((await f.call('attribution_context',{id})).status,400);
 const search=await f.call('search_context');assert.equal(search.status,200);
 // This fixture intentionally discovers through the native material page, not
 // by supplying the original directly to the new context endpoint.
 await f.call('material_catalog');assert.equal((await f.call('material_read',{ref:materialRef,length:1})).status,200);
 const before=JSON.stringify([...f.bridge.records]),result=await pages(f.call,{id});assert.equal(result.text,JSON.stringify(f.context));assert.equal(JSON.stringify([...f.bridge.records]),before);
 f.deny();assert.equal((await f.call('attribution_context',{id})).status,400);assert.equal((await f.call('attribution_context',{ref:materialRef})).status,400);
});

test('continuations fence context changes, invalid locators and task authority',async t=>{
 const f=await open(t,{instruction:'Generated scope 😀 '+ 'x'.repeat(500)});await f.call('material_catalog');
 assert.equal((await f.call('attribution_context',{ref:materialRef,id:f.fixture.originals[0].id})).status,400);
 assert.equal((await f.call('attribution_context',{ref:materialRef,offset:10})).status,400);
 assert.equal((await f.call('attribution_context',{ref:materialRef.replace('@'+'d'.repeat(64),'@'+'e'.repeat(64))})).status,400);
 const first=await f.call('attribution_context',{ref:materialRef,length:80});assert.equal(first.status,200);f.change();
 const changed=await f.call('attribution_context',{ref:materialRef,offset:first.body.data.nextOffset,expectedFingerprint:first.body.data.contextFingerprint});assert.equal(changed.status,400);assert.equal(changed.body.toolError.code,'attribution_context_changed');
 assert.equal(f.bridge.records.size,0);assert.equal(taskTools({question:'Extract',evidenceIds:[f.fixture.originals[0].id]}).includes('attribution_context'),false);
});

test('extreme escaping exhausts the unchanged total budget with an explicit unread tail',async t=>{
 const f=await open(t,{instruction:'"\\\n'.repeat(4000),answer:'"\\\n'.repeat(2667).slice(0,8000)});
 assert.equal((await f.call('material_catalog',{limit:2})).status,200);
 for(const length of [1,128])assert.equal((await f.call('material_read',{ref:materialRef,length})).status,200,'ordinary body pages remain usable before context disclosure');
 let offset=0,fingerprint,received='',lastPage;
 for(let attempt=0;attempt<10;attempt++){
  const result=await f.call('attribution_context',{ref:materialRef,offset,length:12000,...(fingerprint?{expectedFingerprint:fingerprint}:{})});
  if(result.status!==200){assert.equal(result.body.toolError.code,'evidence_budget_exceeded');assert.ok(lastPage.nextOffset!==null);break;}
  lastPage=result.body.data;received+=lastPage.text;offset=lastPage.nextOffset;fingerprint=lastPage.contextFingerprint;
  assert.notEqual(offset,null,'this fixture deliberately exceeds one query budget');
 }
 assert.ok(received.length<JSON.stringify(f.context).length);assert.equal(received,JSON.stringify(f.context).slice(0,received.length));assert.ok(f.bridge.deliveredCharacters<=48000);assert.equal(f.bridge.records.size,0);
});

test('UTF-16 boundaries, selected scope and declaration-only locators never expand original authority',async t=>{
 const f=await open(t,{instruction:'Generated scope 😀 with intact units'},{after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z',deviceId:'generated-device'});
 await f.call('material_catalog');
 const first=await f.call('attribution_context',{ref:materialRef,length:128});assert.equal(first.status,200);
 const id=f.fixture.originals[0].id;
 assert.equal((await f.call('evidence',{ids:[id]})).status,400,'statement captureIds and context-only host reads do not discover originals');
 assert.equal((await f.call('read_image',{id})).status,400);
 assert.equal((await f.call('attribution_context',{ref:materialRef,deviceId:'another-device'})).status,400,'tool cannot broaden host scope');
 const split=JSON.stringify(f.context).indexOf('😀')+1;
 assert.equal((await f.call('attribution_context',{ref:materialRef,offset:split,expectedFingerprint:first.body.data.contextFingerprint})).status,400);
 await f.call('material_read',{ref:materialRef,length:1});
 f.fixture.reader.evidence=async()=>[{...f.fixture.originals[0],deviceId:'another-device',attributionContext:f.context}];
 assert.equal((await f.call('attribution_context',{id})).status,400,'fresh original scope is checked even after discovery');
 f.fixture.reader.evidence=async()=>[{...f.fixture.originals[0],capturedAt:'2026-08-01T00:00:00Z',attributionContext:f.context}];
 assert.equal((await f.call('attribution_context',{id})).status,400,'expired selected time scope cannot disclose its context');
 assert.equal(f.bridge.records.size,0);
});

test('source descriptions require discovery, read losslessly, strip prose from metadata and preserve every disclosed version pin',async t=>{
 const sourceId='generated:audio-source',description=('Generated calls belong to me; anonymous speakers remain unknown. 😀\\\n').repeat(200).slice(0,12000);
 let pin={sourceId,version:1,fingerprint:'c'.repeat(64)},available=true;
 const ref=()=>`source-context:${Buffer.from(sourceId).toString('base64url')}@${pin.version}#${pin.fingerprint}`;
 const context=()=>({version:1,ownerRelation:'unknown',basis:'default',sourceContextDeclarations:[pin],sourceContextStatements:[{sourceId,version:pin.version,description}]});
 const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>({}),
  sources:async args=>({items:[{id:sourceId,name:'Generated recordings',sourceContextRef:ref(),descriptionPreview:description.slice(0,300)}],nextCursor:null}),
  sourceContext:async args=>{if(!available||args.sourceContextRef!==ref())throw Error('Source description changed');return {attributionContext:context()};}};
 const bridge=await startBridge(reader,{question:'Generated context fixture'},40);t.after(()=>bridge.close());
 const call=async(tool,args={})=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
 assert.equal((await call('attribution_context',{sourceContextRef:ref()})).status,400);
 const capability=await call('capability_discover',{name:'sources'});assert.equal(capability.status,200);
 const discover=()=>call('capability_execute',{name:'sources',version:capability.body.data.version,argumentsJson:JSON.stringify({query:'calls'})});
 assert.equal((await discover()).status,200);const oldRef=ref();
 const read=await pages(call,{sourceContextRef:oldRef});assert.equal(JSON.parse(read.text).sourceContextStatements[0].description,description);
 assert.equal(bridge.records.size,0,'source metadata grants no original citation');assert.deepEqual(bridge.sourceContextDependencies,[pin]);
 pin={...pin,version:2,fingerprint:'d'.repeat(64)};assert.equal((await call('attribution_context',{sourceContextRef:oldRef})).status,400);
 assert.equal((await discover()).status,200);assert.equal(bridge.sourceContextDependencies.length,2,'a new discovery cannot erase the old disclosed dependency');
 available=false;assert.equal((await call('attribution_context',{sourceContextRef:ref()})).status,400);
});

test('default source context pins fence projected originals across edits and clearing while undeclared evidence keeps its legacy fingerprint',async t=>{
 const fixture=generatedMaterialPages({text:'Generated original transcript remains unchanged.'}),record=fixture.originals[0],sourceId='generated-source';
 const legacy=createHash('sha256').update(JSON.stringify([record.ocrText,record.provenance,record.fileEvidence])).digest('hex');
 const fingerprints=[];
 const contexts=[{version:1,ownerRelation:'unknown',basis:'default'},
  {version:1,ownerRelation:'unknown',basis:'default',sourceContextDeclarations:[],sourceContextStatements:[]},
  ...[{version:1,description:'Generated narrator background'},{version:2,description:'Generated narrator background'},{version:3,description:''}].map(({version,description})=>({
   version:1,ownerRelation:'unknown',basis:'default',sourceContextDeclarations:[{sourceId,version,fingerprint:String(version).repeat(64)}],sourceContextStatements:[{sourceId,version,description}]}))];
 for(const attributionContext of contexts){
  const reader={...fixture.reader,evidence:async()=>[{...record,attributionContext}]};
  const bridge=await startBridge(reader,{question:'Generated default source lineage',evidenceIds:[record.id],evidenceRanges:[{id:record.id,offset:0,length:record.ocrText.length}]},10);
  t.after(()=>bridge.close());
  fingerprints.push(bridge.seedEvidence[0].evidenceFingerprint);
 }
 assert.equal(fingerprints[0],legacy);assert.equal(fingerprints[1],legacy);
 assert.equal(new Set(fingerprints.slice(2)).size,3,'an unchanged body or cleared description cannot retain an earlier source version identity');
 assert.ok(fingerprints.slice(2).every(fingerprint=>fingerprint!==legacy));
});
