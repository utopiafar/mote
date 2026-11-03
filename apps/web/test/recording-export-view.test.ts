import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {rawTranscriptFromTar} from '../src/plugins/sources/RecordingTools';
import {buildApp} from '../../server/src/app.js';
import {fileExportEntries,exportTar} from '../../server/src/file-export.js';
import {sha256} from '../../server/src/store.js';
const text='Generated raw <script>literal</script> and original words';
const transcript={durationMs:1000,segments:[{startMs:0,endMs:1000,text,speaker:'SPEAKER_0'}]};
async function bytes(stream:AsyncIterable<Uint8Array>){const parts=[];for await(const part of stream)parts.push(part);return Buffer.concat(parts);}

test('owner raw viewer reads the actual export by named entry and exact manifest pin independently of tar ordering',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-recording-export-view-')),token='generated-recording-token-1234567890';
 const node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-recording',name:'Generated recording',kind:'local-files',deviceId:'generated',platform:'macos',retention:'archive'});
 const original=Buffer.from('Generated unavailable audio decoder fixture'),start=node.files.begin({sourceId:'generated-recording',item:{externalId:'recording.wav',revision:'1',observedAt:'2026-10-29T00:00:00Z',kind:'file',layer:'original',mimeType:'audio/wav'},sizeBytes:original.length,sha256:sha256(original)},()=>{});node.files.part(start.uploadId,0,original,()=>{});const ack=await node.files.commit(start.uploadId,()=>{}),artifact=randomUUID();
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,ack.id,'transcript','2026-10-29T00:00:00Z','generated',JSON.stringify({complete:true,transcript}));
 const response=await node.app.inject({url:'/api/files/'+ack.id+'/export',headers:{authorization:'Bearer '+token}});assert.equal(response.statusCode,200,response.body);
 const plain=gunzipSync(response.rawPayload);assert.deepEqual(rawTranscriptFromTar(plain,ack.id,artifact),transcript);
 const reordered=gunzipSync(await bytes(exportTar(fileExportEntries(node.files,ack.id).reverse())));assert.deepEqual(rawTranscriptFromTar(reordered,ack.id,artifact),transcript,'the reader binds manifest and current localized raw filename, never export entry position');
 assert.throws(()=>rawTranscriptFromTar(plain,randomUUID(),artifact),/版本已变化/);assert.throws(()=>rawTranscriptFromTar(plain,ack.id,randomUUID()),/版本已变化/);
 const corrupt=Buffer.from(plain);corrupt[124]=57;assert.throws(()=>rawTranscriptFromTar(corrupt,ack.id,artifact),/导出无效/);
 const wrongShape=fileExportEntries(node.files,ack.id).map(entry=>entry.name.endsWith('.json')&&entry.name!=='manifest.json'?{...entry,bytes:Buffer.from(JSON.stringify({durationMs:1000,segments:[{startMs:0,endMs:1000,text:17}]}))}:entry);
 const invalid=gunzipSync(await bytes(exportTar(wrongShape)));assert.throws(()=>rawTranscriptFromTar(invalid,ack.id,artifact));
});

for(const change of ['owner','raw-pin','close'] as const)test('an in-flight raw export cannot cross '+change+' and keeps its exact readable original',async t=>{
 const React=await import('react'),{act}=React,{JSDOM}=await import('jsdom'),{RawRecording}=await import('../src/plugins/sources/RecordingTools');const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost/'}),previous=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const captureId=randomUUID(),first=randomUUID(),second=randomUUID();let resolve!:(value:Response)=>void,oldSignal:AbortSignal|undefined,firstReads=0,currentPin=first;const pending=new Promise<Response>(accept=>resolve=accept);
 const archive=async(pin:string,rawText:string)=>new Response(await bytes(exportTar([{name:'manifest.json',bytes:Buffer.from(JSON.stringify({version:1,captureId,artifacts:[{id:pin,kind:'transcript'}]}))},{name:'原始转写.json',bytes:Buffer.from(JSON.stringify({...transcript,segments:[{...transcript.segments[0],text:rawText}]}))}])));
 const api={request:async()=>{firstReads++;return {artifacts:[{id:currentPin,kind:'transcript'}]};},raw:async(_path:string,init:RequestInit)=>{if(currentPin===second)return archive(second,'Generated current original');oldSignal=init.signal as AbortSignal;return pending;}} as any;
 const nextApi={request:async()=>({artifacts:[{id:second,kind:'transcript'}]}),raw:async()=>archive(second,'Generated current original')} as any;
 const view=(owner:any,pin:string)=>React.createElement(RawRecording,{api:owner,id:captureId,artifacts:[{id:pin,kind:'transcript'}]});await act(async()=>root.render(view(api,first)));assert.ok(oldSignal);
 if(change==='close')await act(async()=>root.render(null));else if(change==='owner')await act(async()=>root.render(view(nextApi,second)));else{currentPin=second;await act(async()=>root.render(view(api,second)));}
 assert.equal(oldSignal!.aborted,true);await act(async()=>resolve(await archive(first,'STALE GENERATED RAW')));for(let attempt=0;change!=='close'&&attempt<100&&!dom.window.document.body.textContent?.includes('Generated current original');attempt++)await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));assert.doesNotMatch(dom.window.document.body.textContent!,/STALE GENERATED RAW/);assert.equal(firstReads,change==='raw-pin'?3:1,'an aborted export never performs its post-read on the old node');if(change!=='close')assert.match(dom.window.document.body.textContent!,/Generated current original/);
});
