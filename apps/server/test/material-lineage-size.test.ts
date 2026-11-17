import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {startBridge} from '../../../packages/agent/dist/bridge.js';

test('a long current Material keeps every private lineage contributor while disclosing only the requested page',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-material-lineage-size-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
 t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),at='2026-10-01T00:00:00Z',texts=Array.from({length:1001},(_,index)=>'Generated line '+index+'.');
 await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:texts.join('\n')});
 const material=materials.publish({id:materialId('generated-long','transcript'),kind:'mote.note',schemaVersion:1,title:'Generated long transcript',origin:{sourceId:'generated-long',externalId:'transcript',deviceId:'generated',firstAt:at,lastAt:at},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:texts.map((text,index)=>({id:'line-'+index,kind:'text' as const,format:'plain',text,memberIds:[id]})),artifacts:[{key:'body',state:'ready',blockIds:texts.map((_,index)=>'line-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials).agent({diagnostics}),expected=[...materials.evidenceIds(material.ref),id];assert.equal(expected.length,1002);
 const catalog=await reader.materialCatalog!({limit:1}),read=await reader.materialRead!({ref:material.ref,length:128});for(const page of [catalog,read]){assert.equal(page.disclosureDependencies!.complete,true);assert.deepEqual(new Set(page.disclosureDependencies!.ids),new Set(expected));}
 const bridge=await startBridge(reader,{question:'Generated long transcript'});t.after(()=>bridge.close());
 const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.ok(!JSON.stringify(body).includes('disclosureDependencies'));return body;};
 await call('material_catalog',{limit:1});assert.equal(bridge.records.size,0,'private metadata contributors grant no body citations');const page=await call('material_read',{ref:material.ref,length:128});assert.equal(page.data.text.length,128);assert.ok(bridge.records.size<expected.length);assert.equal(bridge.evidenceDependencies.complete,true);assert.deepEqual(new Set(bridge.evidenceDependencies.ids),new Set(expected));
});
