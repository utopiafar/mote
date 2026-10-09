import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseAnswer} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {Store} from '../src/store.js';
import {MaterialStore,materialId} from '../src/materials.js';
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
