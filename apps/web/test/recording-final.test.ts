import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {FileReview} from '../src/plugins/intake/FileReview';
import {FileDetail} from '../src/plugins/intake/Files';
import {recordingClock,recordingSpeaker} from '../src/recording-presentation';
import type {Api} from '../src/api';
import {resources} from '../src/resource-cache';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',dialogue='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',diarization='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const artifacts=[{id:dialogue,kind:'dialogue'},{id:diarization,kind:'diarization',segments:2,samples:[{speaker:'SPEAKER_0'},{speaker:'SPEAKER_1'}]}];
async function fixture(t:any,options:{raw?:(path:string,init?:RequestInit)=>Promise<Response>;write?:(path:string,body:any)=>Promise<unknown>}={}){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>(),urls:string[]=[],revoked:string[]=[],writes:{path:string;body:any}[]=[],reads:string[]=[];let changed=0,closed=0;
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};dom.window.HTMLMediaElement.prototype.play=async()=>{};
 const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;URL.createObjectURL=()=>{const url='blob:generated-'+urls.length;urls.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(String(init.body));writes.push({path,body});return options.write?options.write(path,body):{};}if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};reads.push(path);return {items:[]};},raw:async(path:string,init?:RequestInit)=>{reads.push(path);return options.raw?options.raw(path,init):new Response(new Blob(['Generated sample'],{type:'audio/wav'}));},setAgentTimeout:()=>{}} as Api;
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document;
 const props={api,id,artifacts,onChanged:async()=>{changed++;},onClose:()=>{closed++;},initialSection:'speakers' as const,initialSpeaker:'SPEAKER_1'};
 async function render(next:any=props){await act(async()=>root.render(React.createElement(FileReview,next)));}
 const click=async(label:string,index=0)=>{const button=[...d.querySelectorAll<HTMLButtonElement>('button')].filter(b=>b.textContent?.trim()===label)[index];assert.ok(button,label);await act(async()=>button.click());};
 const input=async(label:string,value:string)=>{const element=d.querySelector<HTMLInputElement>('[data-recording-name="'+label+'"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
 t.after(async()=>{await act(async()=>root.unmount());URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;dom.window.close();for(const [key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 return {d,api,props,render,root,reads,writes,urls,revoked,click,input,events:()=>({changed,closed}),unmount:async()=>{await act(async()=>root.render(null));}};
}

test('recording clocks preserve coordinates and anonymous labels require a real diarization artifact',()=>{
 assert.equal(recordingClock(0),'00:00');assert.equal(recordingClock(61_000),'01:01');assert.equal(recordingClock(3_661_000),'1:01:01');assert.equal(recordingClock(undefined),'未标时间');assert.equal(recordingClock(Number.NaN),'未标时间');
 assert.equal(recordingSpeaker('SPEAKER_0',true),'说话人 1');assert.equal(recordingSpeaker('SPEAKER_1',true),'说话人 2');assert.equal(recordingSpeaker('SPEAKER_0',false),'SPEAKER_0');assert.equal(recordingSpeaker('Source participant',false),'Source participant');assert.equal(recordingSpeaker('SPEAKER_UNKNOWN',true),'SPEAKER_UNKNOWN');assert.equal(recordingSpeaker('SPEAKER_0',true,'Confirmed name'),'Confirmed name');
});

test('speaker naming opens the selected row, reads no samples until requested, and shares one scoped player',async t=>{
 const f=await fixture(t);await f.render();assert.equal(f.d.querySelectorAll('.recording-speaker-row').length,2);assert.equal(f.d.activeElement?.getAttribute('data-recording-name'),'SPEAKER_1');assert.deepEqual(f.reads,[]);assert.equal(f.d.querySelector('audio'),null);
 await f.click('▷ 试听片段',0);assert.equal(f.reads.length,1);assert.equal(new URL(f.reads[0],'http://localhost').searchParams.get('name'),'speaker_samples/SPEAKER_0.wav');assert.equal(new URL(f.reads[0],'http://localhost').searchParams.get('artifactId'),diarization);assert.equal(f.d.querySelectorAll('audio').length,1);
 await f.click('▷ 试听片段',0);assert.equal(f.reads.length,1,'replaying the selected sample does not fetch every sample');await f.click('▷ 试听片段',1);assert.equal(f.d.querySelectorAll('audio').length,1);assert.equal(f.reads.length,2);assert.deepEqual(f.revoked,['blob:generated-0']);
 await f.input('SPEAKER_1','  Generated Ada  ');await f.click('保存名称');assert.deepEqual(f.writes,[{path:'/api/files/'+id+'/speakers',body:{artifactId:dialogue,names:{SPEAKER_1:'Generated Ada'}}}]);assert.deepEqual(f.events(),{changed:1,closed:1});await f.unmount();assert.deepEqual(f.revoked,['blob:generated-0','blob:generated-1']);
});

test('a naming failure keeps the same draft and never closes or silently retries',async t=>{
 const f=await fixture(t,{write:async()=>{throw Error('Generated current naming conflict');}});await f.render();await f.input('SPEAKER_0','Generated retained name');await f.click('保存名称');assert.equal(f.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!.value,'Generated retained name');assert.match(f.d.body.textContent!,/Generated current naming conflict/);assert.deepEqual(f.events(),{changed:0,closed:0});assert.equal(f.writes.length,1);await act(async()=>{});assert.equal(f.writes.length,1);
});

for(const change of ['owner','close'] as const)test('a late selected sample cannot start audio after '+change,async t=>{
 let accept!:(value:Response)=>void,signal:AbortSignal|undefined;const response=new Promise<Response>(yes=>accept=yes),f=await fixture(t,{raw:async(_path,init)=>{signal=init?.signal as AbortSignal;return response;}});await f.render();await f.click('▷ 试听片段',0);assert.ok(signal);
 if(change==='close')await f.unmount();else{const nextApi={...f.api,raw:async()=>{throw Error('New owner sample must require a new explicit selection');}} as Api;await f.render({...f.props,api:nextApi});}
 assert.equal(signal!.aborted,true);await act(async()=>accept(new Response(new Blob(['STALE SAMPLE']))));assert.equal(f.d.querySelector('audio'),null);assert.deepEqual(f.urls,[]);assert.equal(f.reads.length,1);
});

for(const change of ['owner','close'] as const)test('a late naming acknowledgement cannot refresh or close another '+change+' view',async t=>{
 let accept!:(value:unknown)=>void;const pending=new Promise(yes=>accept=yes),f=await fixture(t,{write:()=>pending});await f.render();await f.input('SPEAKER_0','Old owner draft');await f.click('保存名称');
 if(change==='close')await f.unmount();else await f.render({...f.props,api:{...f.api} as Api});await act(async()=>accept({saved:true}));assert.deepEqual(f.events(),{changed:0,closed:0});if(change==='owner')assert.equal(f.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!.value,'');
});

test('recording header names stay within the current file session and correction remains a small per-segment action',async t=>{
 const f=await fixture(t);let file={captureId:id,sourceId:'generated',sizeBytes:16,hasOriginal:false,originMissing:false,item:{title:'Generated transcript without audio',layer:'original',mimeType:'audio/wav',observedAt:'2026-10-29T01:00:00Z'},job:{state:'succeeded',summary_state:'skipped'},processingPolicy:{capabilities:{dialogue:true,summary:false},current:{profile:{name:'Generated',processorId:'audio.local-dialogue',parameters:{},summarize:false},rule:{type:'audio/*'}}},artifacts};
 const chunks=[0,1].map(i=>({id:'generated-'+i,ocrText:'[SPEAKER_'+i+'] Exact generated '+i,fileEvidence:{artifactId:dialogue,chunkId:'generated-'+i,speaker:'SPEAKER_'+i,startMs:i*1000,endMs:i*1000+500}}));
 const api={...f.api,request:async(path:string,init?:RequestInit)=>{if(path==='/api/files/'+id)return file;if(path.includes('/chunks'))return {items:chunks,nextOffset:null};return f.api.request(path,init);}} as Api;
 await act(async()=>f.root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));assert.equal(f.d.querySelector('.recording-speaker')!.textContent,'说话人 1');assert.equal(f.d.querySelector('.recording-time')!.textContent,'00:00');assert.equal(f.d.querySelector('.recording-turn-tools button')!.textContent,'纠正文字');assert.ok(f.d.querySelector('.recording-turn-tools .text-button'));assert.equal(f.reads.some(path=>path.includes('/assets?')),false);
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.recording-speaker')!.click());await f.input('SPEAKER_0','Current session only');await f.click('返回');await act(async()=>f.d.querySelector<HTMLButtonElement>('.recording-speaker')!.click());assert.equal(f.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!.value,'Current session only');assert.deepEqual(f.writes,[]);await f.click('返回');
 file={...file,artifacts:file.artifacts.map(artifact=>artifact.kind==='diarization'?{...artifact,id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}:artifact)};
 await act(async()=>resources(api).invalidate(path=>path==='/api/files/'+id));await act(async()=>f.d.querySelector<HTMLButtonElement>('.recording-speaker')!.click());assert.equal(f.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!.value,'','new anonymous groups do not inherit an unconfirmed old-group name');await f.click('返回');
 await act(async()=>f.root.render(React.createElement(FileDetail,{api:{...api} as Api,id,onOpen:()=>{}})));await act(async()=>f.d.querySelector<HTMLButtonElement>('.recording-speaker')!.click());assert.equal(f.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!.value,'');
});

test('a failed sample read retries only on another explicit selection of that sample',async t=>{
 let calls=0;const f=await fixture(t,{raw:async()=>{if(++calls===1)throw Error('Generated sample unavailable');return new Response(new Blob(['Generated retry sample']));}});await f.render();await f.click('▷ 试听片段',0);assert.equal(calls,1);assert.match(f.d.body.textContent!,/Generated sample unavailable/);await act(async()=>{});assert.equal(calls,1);await f.click('▷ 试听片段',0);assert.equal(calls,2);for(let attempt=0;attempt<20&&!f.d.querySelector('audio');attempt++)await act(async()=>new Promise(done=>setTimeout(done,5)));assert.equal(f.d.querySelectorAll('audio').length,1);
});

test('an actual provider-supplied transcript artifact uses the transcript reader without pretending the JSON export is audio',async t=>{
 const f=await fixture(t);let file={captureId:id,sourceId:'generated-provider',sizeBytes:200,hasOriginal:true,originMissing:false,item:{title:'Generated vendor transcript',layer:'original',mimeType:'application/json',observedAt:'2026-10-29T01:00:00Z'},job:{state:'succeeded',summary_state:'skipped'},processingPolicy:{capabilities:{dialogue:false,summary:false},current:{profile:{name:'Generated',processorId:'archive-only',parameters:{},summarize:false},rule:{type:'application/json'}}},artifacts:[{id:dialogue,kind:'transcript',providerSupplied:true}]};
 const api={...f.api,request:async(path:string,init?:RequestInit)=>{if(path==='/api/files/'+id)return file;if(path.includes('/chunks'))return {items:[{id:'generated-provider-segment',ocrText:'[Vendor A] Provider literal original',fileEvidence:{artifactId:dialogue,chunkId:'generated-provider-segment',speaker:'Vendor A',startMs:0,endMs:1000}}],nextOffset:null};return f.api.request(path,init);}} as Api;
 await act(async()=>f.root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));assert.ok(f.d.querySelector('.recording-view'));assert.equal(f.d.querySelector('.recording-speaker')!.textContent,'Vendor A来源标签');assert.equal(f.d.querySelector('button.recording-speaker'),null);assert.equal(f.d.querySelector<HTMLButtonElement>('.recording-time')!.disabled,true);assert.equal([...f.d.querySelectorAll('button')].some(button=>button.textContent==='回听录音'),false);assert.equal(f.d.querySelector('.recording-file-head a')!.getAttribute('href'),'#/connections?sourceId=generated-provider');assert.match(f.d.querySelector('.recording-file-name small')!.textContent!,/音频尚未归档 · 转写可读/);assert.equal(f.d.querySelector('.recording-turn .file-text')!.textContent,'Provider literal original');assert.deepEqual(f.writes,[]);
});
