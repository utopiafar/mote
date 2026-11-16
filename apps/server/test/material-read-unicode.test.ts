import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseAnswer} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialReadPage} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

test('production Material reader keeps surrogate pairs intact and mapped original citation ranges advance without gaps',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-material-unicode-')),store=new Store(directory),materials=new MaterialStore(store),diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
 t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),text='ab🙂cd e\u0301 🧑‍💻 finish',source='generated-unicode-source',at='2026-10-10T00:00:00.000Z';
 await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:text});
 const material=materials.publish({id:materialId(source,'unicode'),kind:'mote.note',schemaVersion:1,title:'Generated Unicode source',origin:{sourceId:source,externalId:'unicode',deviceId:'generated',firstAt:at,lastAt:at},blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[id],evidenceContext:{observedAt:at,document:{contentRole:'authored',timeBasis:'recorded',recordedAt:at}}}],members:[{id,kind:'capture',ref:'capture:'+id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const first=materials.read(material.ref,{offset:0,length:3});assert.equal(first.text,'ab');assert.equal(first.textRange.nextOffset,2);
 assert.throws(()=>materials.read(material.ref,{offset:3,length:3}),/offset splits a UTF-16 pair/);assert.throws(()=>materials.read(material.ref,{offset:2,length:1}),/complete Unicode character/);
 const reader=new EvidenceReader(store,new SourceStore(store),undefined,undefined,undefined,materials).agent({diagnostics}),bridge=await startBridge(reader,{question:'Read generated Unicode'},32);t.after(()=>bridge.close());
 const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};
 await call('material_catalog',{});let offset=0,joined='';const evidenceId=materials.evidenceIds(material.ref)[0];
 do{const page=await call('material_read',{ref:material.ref,offset,length:3});joined+=page.data.text;for(const record of page.data.sourceEvidence){assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(record.ocrText));assert.equal(record.ocrText,text.slice(record.textRange.start,record.textRange.end));}offset=page.data.textRange.nextOffset;}while(offset!==null);
 assert.equal(joined,text+'\n');const spans=bridge.records.get(evidenceId)!.deliveredRanges as {start:number;end:number;text:string}[];assert.equal(spans.map(span=>span.text).join(''),text);assert.equal(spans[0].start,0);assert.equal(spans.at(-1)!.end,text.length);
 const answer=parseAnswer(JSON.stringify({answer:`Generated Unicode record [${evidenceId}]`,citationIds:[evidenceId]}),bridge.records);assert.match(answer.citations[0].excerpt,/🙂/);
});


async function unicodeBlocks(t:TestContext,texts:string[],selected=texts.map((_,index)=>index)){
 const directory=mkdtempSync(join(tmpdir(),'mote-material-unicode-blocks-')),store=new Store(directory),materials=new MaterialStore(store);
 const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});let runtime:ProcessingRuntime|undefined;
 t.after(async()=>{await runtime?.close();await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});await diagnostics.init();
 const at='2001-01-01T10:00:00.000Z',source='generated-unicode-source',members=[],blocks=[];
 for(const [index,text] of texts.entries()){
  const id=randomUUID(),memberId='member-'+index;
  await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:text});
  members.push({id:memberId,kind:'capture',ref:'capture:'+id});
  blocks.push({id:'block-'+index,kind:'text' as const,format:'markdown-fragment',text,memberIds:[memberId],locator:{generated:index},evidenceContext:{observedAt:at,document:{contentRole:'authored' as const,timeBasis:'recorded' as const,recordedAt:at}}});
 }
 const material=materials.publish({id:materialId(source,'generated-blocks'),kind:'mote.note',schemaVersion:1,title:'Generated Unicode blocks',origin:{sourceId:source,externalId:'generated-blocks',deviceId:'generated',firstAt:at,lastAt:at},blocks,members,coverage:{state:'complete'},artifacts:[{key:'selected-body',state:'ready',blockIds:selected.map(index=>'block-'+index)}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const consumer=new EvidenceReader(store,new SourceStore(store),undefined,undefined,undefined,materials).agent({diagnostics});
 return {store,materials,material,consumer,texts,expected:texts.join(''),processing(){return runtime??=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);}};
}

function mappedUnicodePage(f:Awaited<ReturnType<typeof unicodeBlocks>>,page:MaterialReadPage){
 assert.ok(page.text.length>0&&page.text.length<=12000);assert.equal(Buffer.from(page.text,'utf8').toString('utf8'),page.text);
 assert.equal(page.textRange.total,f.expected.length);assert.equal(page.text,f.expected.slice(page.textRange.offset,page.textRange.offset+page.text.length));
 const end=page.textRange.offset+page.text.length;assert.equal(page.textRange.nextOffset,end<f.expected.length?end:null);
 let pageOffset=0;
 for(const span of page.spans){
  assert.equal(span.pageRange.start,pageOffset);assert.ok(span.pageRange.end>pageOffset);pageOffset=span.pageRange.end;
  assert.equal(span.materialRange.start,page.textRange.offset+span.pageRange.start);assert.equal(span.materialRange.end,page.textRange.offset+span.pageRange.end);
  const index=Number(span.blockId.slice('block-'.length)),blockStart=f.texts.slice(0,index).reduce((n,text)=>n+text.length,0),body=page.text.slice(span.pageRange.start,span.pageRange.end);
  assert.deepEqual(span.memberIds,['member-'+index]);assert.equal(span.locator?.generated,index);assert.equal(span.evidenceOffset,span.materialRange.start-blockStart);
  assert.ok(span.evidenceId);const original=f.materials.evidence([span.evidenceId])[0];assert.ok(original);
  assert.equal(original.ocrText.slice(span.evidenceOffset,span.evidenceOffset+body.length),body);
 }
 assert.equal(pageOffset,page.text.length);
}

test('a 12000-unit Material read returns its complete prefix before a new block starts with one of 9000 non-BMP characters',async t=>{
 const prefix='x'.repeat(11999),unicode='🌱'.repeat(9000),f=await unicodeBlocks(t,[prefix,unicode,' exact tail.']);
 const first=f.materials.read(f.material.ref,{length:12000});assert.equal(first.text,prefix);assert.equal(first.textRange.nextOffset,prefix.length);
 assert.throws(()=>f.materials.read(f.material.ref,{offset:prefix.length+1,length:12000}),/offset splits a UTF-16 pair/);
 assert.throws(()=>f.materials.read(f.material.ref,{offset:prefix.length,length:1}),/complete Unicode character/);
 let offset=0,joined='';
 while(offset<f.expected.length){
  const page=await f.consumer.materialRead!({ref:f.material.ref,offset,length:12000});mappedUnicodePage(f,page);joined+=page.text;
  const originals=await f.consumer.evidence({ids:page.spans.map(span=>span.evidenceId!)});assert.ok(originals.length);
  for(const source of page.sourceSpans??[])assert.equal(source.record.ocrText.slice(source.offset,source.offset+source.length),page.text.slice(page.spans.find(span=>span.evidenceId===source.record.id)!.pageRange.start,page.spans.find(span=>span.evidenceId===source.record.id)!.pageRange.start+source.length));
  offset=page.textRange.nextOffset??f.expected.length;
 }
 assert.equal(joined,f.expected);assert.equal(joined.split('🌱').length-1,9000);
});

for(const split of [true,false])test(`named product paging preserves the exact Unicode continuation and processing ranges (separate-block=${split})`,async t=>{
 const prefix='x'.repeat(11999),unicode='🌱'.repeat(9000),tail=' exact product tail.';
 const texts=split?[prefix,unicode,'HIDDEN_PRODUCT_BLOCK',tail]:[prefix+unicode,'HIDDEN_PRODUCT_BLOCK',tail],selected=split?[0,1,3]:[0,2],f=await unicodeBlocks(t,texts,selected),expected=selected.map(index=>texts[index]).join('');
 const first=f.materials.product(f.material.ref,'selected-body',{offset:0,length:12000});assert.equal(first.pages.map(page=>page.text).join(''),prefix,'the incomplete Unicode character and later blocks remain for the next product window');
 assert.throws(()=>f.materials.product(f.material.ref,'selected-body',{offset:prefix.length,length:1}),/complete Unicode character/);
 assert.throws(()=>f.materials.product(f.material.ref,'selected-body',{offset:prefix.length+1,length:12000}),/offset splits a UTF-16 pair/);
 let offset=0,joined='';
 while(offset<expected.length){
  const product=f.materials.product(f.material.ref,'selected-body',{offset,length:12000}),body=product.pages.map(page=>page.text).join('');
  assert.ok(body.length>0&&body.length<=12000);assert.equal(body,expected.slice(offset,offset+body.length));assert.equal(product.ranges.length,product.pages.length);
  for(const [index,page] of product.pages.entries()){
   mappedUnicodePage(f,page);assert.deepEqual(product.ranges[index],{ref:f.material.ref,offset:page.textRange.offset,length:page.text.length});assert.ok(page.spans.every(span=>selected.includes(Number(span.blockId.slice('block-'.length)))));
  }
  joined+=body;offset+=body.length;
 }
 assert.equal(joined,expected);assert.equal(joined.split('🌱').length-1,9000);assert.ok(!joined.includes('HIDDEN_PRODUCT_BLOCK'));
 const runtime=f.processing();let consumed:MaterialReadPage[]=[];
 runtime.registry.register({id:'fixture.unicode',version:'1',lane:'extract',deterministic:true,async process(input){consumed=input.materials;return [{kind:'fixture.unicode',text:input.materials.map(page=>page.text).join(''),metadata:{}}];}});
 const job=runtime.enqueue([{name:'unicode',processor:'fixture.unicode',productInputs:[{authority:'material',ref:f.material.ref,key:'selected-body',offset:0,length:12000}]}]).unicode;
 await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');assert.equal(consumed.map(page=>page.text).join(''),prefix);
 const artifact=f.store.archive.get(runtime.view().jobs[0].outputs[0]);assert.ok(artifact);assert.deepEqual(artifact.materialInputs,[{ref:f.material.ref,offset:0,length:prefix.length}]);
});
