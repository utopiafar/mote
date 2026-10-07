import {fixtureCaptureId} from './capture-fixture-id.mjs';
import {formatEvidenceRef} from '@mote/shared';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {taskTools} from '../dist/task-context.js';

const at='2026-09-24T00:00:00Z';
const ref=`material:mat_${'a'.repeat(64)}@${'b'.repeat(64)}`;
const id=`mat_${'a'.repeat(64)}`;
const original={id:fixtureCaptureId('material-original-1'),capturedAt:at,deviceId:'generated-device',appName:'Generated',ocrText:'Generated original evidence'};
const text='Generated material page text';
const material={id,ref,kind:'coding.session',schemaVersion:1,title:'Generated session',origin:{sourceId:'generated-source',externalId:'/private/source-path',deviceId:'generated-device',firstAt:at,lastAt:at},revision:'b'.repeat(64),updatedAt:at,memberCount:1,blockCount:1,textLength:text.length,assetCount:0,coverage:{state:'complete',reason:'private coverage detail'},fidelity:{state:'lossless',limitations:['private limitation']},retention:{original:'retained',policy:'keep'},text:'PRIVATE BODY',members:[original.id]};
const page={material,text,textRange:{offset:0,total:text.length,nextOffset:null},spans:[{blockId:'block-1',kind:'text',format:'plain',pageRange:{start:0,end:text.length},materialRange:{start:0,end:text.length},memberIds:['member-1'],locator:{privatePath:'/hidden'}}],originalRefs:[formatEvidenceRef('capture',original.id)],originalRefsTotal:1,originalRefsTruncated:false};
const baseReader={search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),evidence:async({ids})=>[original].filter(row=>ids.includes(row.id)),activity:async()=>({}),devices:async()=>[],materialCatalog:async()=>({items:[material],nextCursor:null}),materialRead:async()=>page};
async function fixture(t,reader=baseReader,bounds={question:'Generated material',deviceId:'generated-device',after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z'}) {
  const bridge=await startBridge(reader,bounds,40);t.after(()=>bridge.close());
  const call=async(tool,args={})=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
  return {bridge,call};
}

test('material catalog discloses only metadata and pins exact returned revisions for reading',async t=>{
  const {bridge,call}=await fixture(t);
  assert.equal((await call('material_read',{ref})).status,400);
  const catalog=await call('material_catalog',{});assert.equal(catalog.status,200);
  assert.equal(catalog.body.data.items.length,1);
  assert.equal(catalog.body.data.items[0].ref,ref);
  for(const sensitive of ['PRIVATE BODY','privatePath','private coverage detail','private limitation',original.id,'/private/source-path'])assert.equal(JSON.stringify(catalog.body).includes(sensitive),false,sensitive);
  assert.equal((await call('evidence',{ids:[original.id]})).status,400);
  assert.equal((await call('material_read',{ref:ref.replace('@','@'+ 'c')})).status,400);
  const read=await call('material_read',{ref});assert.equal(read.status,200);
  assert.equal(read.body.data.text,page.text);
  assert.deepEqual(read.body.data.originalRefs,[formatEvidenceRef('capture',original.id)]);
  assert.equal(JSON.stringify(read.body.data.spans).includes('/hidden'),false);
  assert.equal((await call('evidence',{ids:[original.id]})).status,200);
  assert.equal(bridge.evidenceDependencies.complete,false);
  assert.equal(bridge.records.has(id),false,'material identity is not an original citation');
});

test('material catalog and read enforce host time and device scope',async t=>{
  const outside={...material,origin:{...material.origin,deviceId:'other-device'}};
  const {call}=await fixture(t,{...baseReader,materialCatalog:async()=>({items:[outside],nextCursor:null})});
  assert.equal((await call('material_catalog',{})).body.data.items.length,0);
  assert.equal((await call('material_read',{ref})).status,400);
  const outOfTime={...material,origin:{...material.origin,lastAt:'2026-10-02T00:00:00Z'}};
  const timed=await fixture(t,{...baseReader,materialCatalog:async()=>({items:[outOfTime],nextCursor:null})});
  assert.equal((await timed.call('material_catalog',{})).body.data.items.length,0);
  const changed=await fixture(t,{...baseReader,materialRead:async()=>({...page,material:outOfTime})});
  assert.equal((await changed.call('material_catalog',{})).status,200);
  assert.equal((await changed.call('material_read',{ref})).status,400);
  assert.equal((await changed.call('evidence',{ids:[original.id]})).status,400);
});

test('material context reaches both catalog and spans without admitting arbitrary metadata',async t=>{
  const attributionContext={version:1,ownerRelation:'mixed',basis:'owner_source',sourceDeclaration:{sourceId:'generated-source',version:2,ownerRelation:'mixed'}};
  const declared={...material,attributionContext};
  const {call}=await fixture(t,{...baseReader,materialCatalog:async()=>({items:[declared],nextCursor:null}),materialRead:async()=>({...page,material:declared,spans:page.spans.map(span=>({...span,attributionContext}))})});
  const catalog=await call('material_catalog');
  assert.deepEqual(catalog.body.data.items[0].attributionContext,attributionContext);
  const read=await call('material_read',{ref});
  assert.deepEqual(read.body.data.material.attributionContext,attributionContext);
  assert.deepEqual(read.body.data.spans[0].attributionContext,attributionContext);
  assert.ok(!JSON.stringify(read.body).includes('/hidden'));
});

test('a reader that ignores a smaller page request cannot grant its original evidence ID',async t=>{
  const large='x'.repeat(12000),largePage={...page,text:large,textRange:{offset:0,total:12000,nextOffset:null},spans:[{...page.spans[0],pageRange:{start:0,end:12000},materialRange:{start:0,end:12000},memberIds:Array.from({length:32},(_,i)=>`member-${i}-${'m'.repeat(110)}`)}]};
  const {call}=await fixture(t,{...baseReader,materialRead:async()=>largePage});
  assert.equal((await call('material_catalog',{})).status,200);
  const denied=await call('material_read',{ref,length:12000});assert.equal(denied.status,400);assert.match(denied.body.error,/Invalid material read page/);
  assert.equal((await call('evidence',{ids:[original.id]})).status,400);
});

test('material reading caps original grants at 30 and extraction advertises no material tools',async t=>{
  const originals=Array.from({length:35},(_,i)=>({...original,id:fixtureCaptureId('material-original-'+i)}));
  const {call}=await fixture(t,{...baseReader,evidence:async({ids})=>originals.filter(row=>ids.includes(row.id)),materialRead:async()=>({...page,originalRefs:originals.map(row=>formatEvidenceRef('capture',row.id)),originalRefsTotal:35,originalRefsTruncated:true})});
  await call('material_catalog',{});
  const read=await call('material_read',{ref});assert.equal(read.status,200);assert.equal(read.body.data.originalRefs.length,30);assert.equal(read.body.data.originalRefsTruncated,true);
  assert.equal((await call('evidence',{ids:[originals[34].id]})).status,400);
  assert.deepEqual(taskTools({question:'Extract',evidenceIds:[original.id]}),['evidence']);
  const restricted=await fixture(t,baseReader,{question:'Extract',evidenceIds:[original.id],evidenceRanges:[{id:original.id,offset:0,length:original.ocrText.length}]});
  assert.equal((await restricted.call('material_catalog',{})).status,400);
  assert.equal((await restricted.call('material_read',{ref})).status,400);
});

test('old bare or wrong-kind material originalRefs reject the page without authorizing originals',async t=>{
  for(const originalRef of [original.id,formatEvidenceRef('memory',original.id)]){
    let evidenceReads=0;
    const {bridge,call}=await fixture(t,{...baseReader,evidence:async args=>{evidenceReads++;return baseReader.evidence(args);},materialRead:async()=>({...page,originalRefs:[originalRef]})});
    assert.equal((await call('material_catalog',{})).status,200);
    const denied=await call('material_read',{ref});
    assert.equal(denied.status,400);assert.match(denied.body.error,/Invalid material original reference/);
    assert.equal(evidenceReads,0,'invalid page must be rejected before reading originals');
    assert.equal((await call('evidence',{ids:[original.id]})).status,400);
    assert.equal(evidenceReads,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
    assert.equal(bridge.trace.some(entry=>entry.tool==='material_read'),false);
  }
});
