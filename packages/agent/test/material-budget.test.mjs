import {test} from 'node:test';
import {formatEvidenceRef} from '@mote/shared';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {generatedMaterialPages,materialRef as ref} from './material-page-fixture.mjs';

async function open(t,fixture,bounds={}){
  const bridge=await startBridge(fixture.reader,{question:'Generated bounded material page',...bounds},40);t.after(()=>bridge.close());
  const call=async(tool,args={})=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
  assert.equal((await call('material_catalog')).status,200);
  return {bridge,call};
}

test('one material call fits full serialized provenance and grants only its delivered page',async t=>{
  const fixture=generatedMaterialPages(),{bridge,call}=await open(t,fixture);
  const before=bridge.deliveredCharacters,read=await call('material_read',{ref,length:10000});
  assert.equal(read.status,200);assert.deepEqual(fixture.attempts.map(args=>args.length),[10000,5000]);
  assert.ok(fixture.attempts.every(args=>args.ref===ref&&args.offset===0));
  assert.deepEqual(read.body.data.pagination,{requestedLength:10000,returnedLength:5000,limitedBy:'host_budget'});
  assert.deepEqual(read.body.data.textRange,{offset:0,total:fixture.text.length,nextOffset:5000});
  assert.equal(read.body.data.text,fixture.text.slice(0,5000));assert.ok(JSON.stringify(read.body).length<=16000);
  assert.equal(bridge.deliveredCharacters,before+JSON.stringify(read.body).length);
  assert.equal(read.body.hostBudget.remainingCalls,38,'only catalog and one model tool call count');
  assert.deepEqual(bridge.trace.at(-1).materialPage,{readAttempts:2,requestedLength:10000,returnedLength:5000,budgetLimited:true});
  const omitted=fixture.originals[1].id;assert.ok(fixture.grants.has(omitted),'the reader simulates a pre-delivery internal source grant');
  assert.deepEqual(read.body.data.originalRefs,[formatEvidenceRef('capture',fixture.originals[0].id)]);
  assert.equal(bridge.evidenceDependencies.ids.includes(omitted),false);
  assert.equal((await call('evidence',{ids:[omitted]})).status,400);
  let imageReads=0;fixture.reader.readImage=async()=>{imageReads++;throw Error('must not read omitted image');};
  assert.equal((await call('read_image',{id:omitted})).status,400);assert.equal(imageReads,0);
  assert.equal((await call('evidence',{ids:[fixture.originals[0].id],length:50})).status,200);
});

for(const archive of [false,true])test(`budget pages retain UTF-16 offsets, spans and ${archive?'archive anchor':'capture member'} references`,async t=>{
  const fixture=generatedMaterialPages({archive}),{bridge,call}=await open(t,fixture);
  let offset=13,joined='',reads=0;
  for(;;){
    const result=await call('material_read',{ref,offset,length:10000});assert.equal(result.status,200);reads++;
    const page=result.body.data;assert.equal(page.textRange.offset,offset);assert.equal(page.text,fixture.text.slice(offset,offset+page.text.length));
    for(const span of page.spans){assert.equal(span.materialRange.start,offset+span.pageRange.start);assert.equal(span.materialRange.end,offset+span.pageRange.end);assert.equal(span.memberIds[0],archive?'generated-archive':`generated-member-${span.blockId.split('-').at(-1)}`);}
    const expected=fixture.blocks.filter(block=>block.end>offset&&block.start<offset+page.text.length).map(block=>formatEvidenceRef('capture',block.originalId));
    assert.deepEqual(page.originalRefs,expected);joined+=page.text;
    if(page.textRange.nextOffset===null)break;
    assert.equal(page.textRange.nextOffset,offset+page.text.length);offset=page.textRange.nextOffset;
    assert.ok(reads<10,'progress must be bounded');
  }
  assert.equal(joined,fixture.text.slice(13),'concatenation preserves escapes and surrogate code units exactly');
  const eof=await call('material_read',{ref,offset:fixture.text.length,length:10000});assert.equal(eof.status,200);
  assert.deepEqual(eof.body.data.pagination,{requestedLength:10000,returnedLength:0,limitedBy:null});assert.equal(eof.body.data.textRange.nextOffset,null);
  t.diagnostic(JSON.stringify({archive,modelToolReads:reads+1,localPageReads:fixture.attempts.length,deliveredCharacters:bridge.deliveredCharacters}));
});

test('the existing 64-block boundary remains the exact continuation point',async t=>{
  const fixture=generatedMaterialPages({text:'x'.repeat(70),blockSize:1}),{call}=await open(t,fixture);
  const first=await call('material_read',{ref,length:12000});assert.equal(first.status,200);
  assert.equal(first.body.data.spans.length,64);assert.equal(first.body.data.textRange.nextOffset,64);
  assert.equal(first.body.data.pagination.limitedBy,null);assert.equal(first.body.data.originalRefs.length,30);assert.equal(first.body.data.originalRefsTruncated,true);
  const last=await call('material_read',{ref,offset:64,length:12000});assert.equal(last.status,200);
  assert.equal(last.body.data.textRange.nextOffset,null);assert.equal(last.body.data.spans.length,6);
});

for(const failure of ['revoked','deleted','revision','scope','aborted'])test(`a page fit does not retry past ${failure}`,async t=>{
  const fixture=generatedMaterialPages(),originalRead=fixture.reader.materialRead,controller=new AbortController();
  fixture.reader.materialRead=async args=>{
    const page=await originalRead(args);
    if(fixture.attempts.length===1)return page;
    if(failure==='revoked'||failure==='deleted')throw Error(`Generated ${failure}`);
    if(failure==='revision')return {...page,material:{...page.material,ref:ref.replace(/d/g,'e'),revision:'e'.repeat(64)}};
    if(failure==='scope')return {...page,material:{...page.material,origin:{...page.material.origin,deviceId:'other'}}};
    controller.abort();return page;
  };
  const {bridge,call}=await open(t,fixture,{deviceId:'generated-device',signal:controller.signal}),before=bridge.deliveredCharacters;
  const result=await call('material_read',{ref,length:10000});assert.equal(result.status,400);assert.equal(fixture.attempts.length,2);
  assert.equal(bridge.deliveredCharacters,before);assert.equal(bridge.trace.filter(entry=>entry.tool==='material_read').length,0);
  assert.equal(bridge.evidenceDependencies.ids.length,0);
});

test('metadata that cannot fit fails after at most fourteen local reads without granting evidence',async t=>{
  const fixture=generatedMaterialPages({text:'x'.repeat(12000)}),originalRead=fixture.reader.materialRead;
  fixture.reader.materialRead=async args=>{const page=await originalRead(args);return {...page,spans:Array.from({length:64},(_,i)=>({...page.spans[0],blockId:`generated-heavy-${i}`,pageRange:{start:0,end:1},materialRange:{start:0,end:1},memberIds:Array.from({length:32},(_,j)=>`generated-${j}-${'m'.repeat(100)}`)}))};};
  const events=[],{bridge,call}=await open(t,fixture,{onTrace:event=>events.push(event)}),before=bridge.deliveredCharacters;
  const result=await call('material_read',{ref,length:12000});assert.equal(result.status,400);assert.equal(result.body.toolError.code,'evidence_budget_exceeded');
  assert.equal(fixture.attempts.length,14);assert.equal(fixture.attempts.at(-1).length,1);assert.equal(bridge.deliveredCharacters,before);
  assert.equal(events.find(event=>event.type==='tool.rejected').payload.materialPage.readAttempts,14);
  assert.equal((await call('evidence',{ids:[fixture.originals[0].id]})).status,400);
  t.diagnostic(JSON.stringify({localPageReads:fixture.attempts.length,successfulMaterialResults:0}));
});

test('parallel tools consume the current remaining budget before a waiting material page is admitted',async t=>{
  const fixture=generatedMaterialPages({text:'x'.repeat(12000)}),originalRead=fixture.reader.materialRead;
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  fixture.reader.materialRead=async args=>{const page=await originalRead(args);if(args.length===12000&&fixture.attempts.length===1){entered();await gate;}return page;};
  const {bridge,call}=await open(t,fixture),pending=call('material_read',{ref,length:12000});await waiting;
  for(let i=0;i<4;i++)assert.equal((await call('material_read',{ref,length:9000})).status,200);
  const before=bridge.deliveredCharacters;release();const result=await pending;
  assert.equal(result.status,200);assert.equal(result.body.data.pagination.limitedBy,'host_budget');
  assert.ok(JSON.stringify(result.body).length<=48000-before);assert.ok(bridge.deliveredCharacters<=48000);
  assert.ok(bridge.trace.at(-1).materialPage.readAttempts>1);
});

test('malformed or non-advancing pages are errors rather than budget retries',async t=>{
  for(const nextOffset of [0,9000]){
    const fixture=generatedMaterialPages(),originalRead=fixture.reader.materialRead;
    fixture.reader.materialRead=async args=>{const page=await originalRead(args);return {...page,textRange:{...page.textRange,nextOffset}};};
    const {call}=await open(t,fixture),result=await call('material_read',{ref,length:10000});assert.equal(result.status,400);assert.match(result.body.error,/Invalid material read page/);assert.equal(fixture.attempts.length,1);
  }
});
