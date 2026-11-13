import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {writeFile} from 'node:fs/promises';
import {FileDetail} from '../src/plugins/intake/Files.js';
import {FileReview} from '../src/plugins/intake/FileReview.js';
import {rawTranscriptFromTar} from '../src/plugins/sources/RecordingTools.js';
import {type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {audioCentral,audioDom,deferred,until} from './fixtures/funasr-ui.js';

test('production FunASR bytes reach archive, reader, exact seek, owner naming, manual correction and raw comparison',async t=>{
 const f=await audioCentral(t),id=await f.upload(),ui=await audioDom(t);
 let detail=await f.api.request<any>('/api/files/'+id),raw=detail.artifacts.find((a:any)=>a.kind==='transcript'),dialogue=detail.artifacts.find((a:any)=>a.kind==='dialogue');
 assert.equal(detail.job.state,'succeeded');assert.equal(raw.output.type.id,'mote.funasr-transcript');assert.equal(dialogue.output.type.id,'mote.funasr-dialogue');
 await ui.render(React.createElement(FileDetail,{api:f.api,id,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('.recording-turn .file-text'));
 assert.match(ui.d.body.textContent!,/零到二十。/);assert.match(ui.d.body.textContent!,/重叠的尾段。/);
 await until(()=>!ui.button('回听录音').disabled);await ui.click('回听录音');await until(()=>!!ui.d.querySelector('audio'));const times=ui.d.querySelectorAll<HTMLButtonElement>('.recording-segment .recording-time');assert.ok(times.length>=2);
 await act(async()=>{times[1].click();ui.d.querySelector('audio')!.dispatchEvent(new ui.dom.window.Event('loadedmetadata'));});assert.equal(ui.d.querySelector('audio')!.currentTime,.020,'milliseconds are preserved even when the clock rounds to 00:00');
 const originalPlayer=ui.d.querySelector('audio')!;
 await ui.click('说话人');assert.ok(ui.stopped.includes(originalPlayer));assert.match(ui.d.body.textContent!,/CAM\+\+ \/ FunASR 1\.4\.25/);assert.doesNotMatch(ui.d.body.textContent!,/WeSpeaker|轮廓系数|sherpa/);
 const name=ui.d.querySelector<HTMLInputElement>('[data-recording-name="SPEAKER_0"]')!;await ui.input(name,'  Generated owner name  ');
 const sample=[...ui.d.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='▷ 试听片段')!;await act(async()=>sample.click());await until(()=>!!ui.d.querySelector('.recording-sample-player'));
 assert.equal(ui.d.querySelectorAll('.recording-sample-player').length,1);assert.ok(f.calls.some(call=>call.path.includes('speaker_samples%2FSPEAKER_0.wav')));
 await ui.click('保存名称');await until(()=>!ui.d.querySelector('.recording-dialog'));
 const named=await f.api.request<any>('/api/files/'+id+'/chunks?offset=0');assert.equal(named.items[0].fileEvidence.speakerAttribution.name,'Generated owner name');
 assert.deepEqual(JSON.parse(String(f.calls.find(call=>call.path.endsWith('/speakers'))!.init.body)),{artifactId:dialogue.id,names:{SPEAKER_0:'Generated owner name'}});
 assert.equal(ui.revoked.length,1,'closing naming revokes its selected sample');
 await until(()=>!!ui.d.querySelector('.recording-turn-tools button'));
 const correct=[...ui.d.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='纠正文字')!;await act(async()=>correct.click());
 const textarea=ui.d.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Generated manual correction');textarea.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}));});
 await ui.click('保存校正');await until(()=>ui.d.querySelector('.recording-turn .file-text')?.textContent?.includes('Generated manual correction')===true);
 detail=await f.api.request<any>('/api/files/'+id);assert.ok(detail.artifacts.some((a:any)=>a.kind==='corrected-dialogue'));
 await ui.click('原文对照');await until(()=>!!ui.d.querySelector('.recording-comparison'));
 const sections=ui.d.querySelectorAll('.recording-comparison>section');assert.match(sections[0].textContent!,/零到二十。/);assert.doesNotMatch(sections[0].textContent!,/Generated manual correction/);assert.match(sections[1].textContent!,/Generated manual correction/);
 const exported=await f.api.raw('/api/files/'+id+'/export'),plain=gunzipSync(Buffer.from(await exported.arrayBuffer()));assert.equal(rawTranscriptFromTar(plain,id,raw.id).segments[0].text,'零到二十。');
 assert.ok(f.responses.some(response=>response.path==='/api/files/'+id+'/view'),'the reader consumes the actual public availability contract');
 if(process.env.MOTE_ASR05_READER_EXAMPLE_PATH)await writeFile(process.env.MOTE_ASR05_READER_EXAMPLE_PATH,JSON.stringify({evidence:'generated fixture; real Python serializer, registry, archive, SQLite and authenticated route responses',nativeRequest:f.bundle.request,nativeRecognition:f.bundle.response,nativeDiarization:f.bundle.diarizeResponse,responses:f.responses.filter(response=>response.path==='/api/files/'+id||response.path==='/api/files/'+id+'/view'||response.path.includes('/chunks')).map(response=>({path:response.path,body:JSON.parse(response.body)})),actions:f.calls.filter(call=>call.init.method==='POST'&&typeof call.init.body==='string').map(call=>({path:call.path,body:JSON.parse(String(call.init.body))})),exportedRaw:rawTranscriptFromTar(plain,id,raw.id)},null,2)+'\n');
});

for(const scenario of ['failed','missing','empty'] as const)test('a '+scenario+' CAM/recording result leaves the real completed transcript readable',async t=>{
 const f=await audioCentral(t),id=await f.upload(scenario),ui=await audioDom(t),detail=await f.api.request<any>('/api/files/'+id);
 await ui.render(React.createElement(FileDetail,{api:f.api,id,onOpen:()=>{}}));
 if(scenario==='empty'){await until(()=>ui.d.body.textContent!.includes('转写结果为空。'));assert.equal(detail.job.state,'succeeded');assert.equal(ui.d.querySelectorAll('.recording-turn').length,0);assert.doesNotMatch(ui.d.body.textContent!,/处理失败/);}
 else{await until(()=>!!ui.d.querySelector('.recording-turn .file-text'));assert.equal(detail.job.state,scenario==='failed'?'failed':'blocked');assert.match(ui.d.body.textContent!,/零到二十。/);assert.doesNotMatch(ui.d.body.textContent!,/转写结果为空。/);assert.ok(detail.artifacts.some((a:any)=>a.kind==='transcript'&&a.complete));}
 assert.ok([...ui.d.querySelectorAll('button')].some(button=>button.textContent==='导出转写与说话人记录'));
});

const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',dialogueId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',diarizationId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function speakerArtifacts(dialogue=dialogueId,diarization=diarizationId){return [{id:dialogue,kind:'dialogue'},{id:diarization,kind:'diarization',engine:'CAM++ / FunASR 1.4.25',segments:1,samples:[{speaker:'SPEAKER_0'}]}];}

test('a new attribution version discards an unconfirmed name and sends only the current dialogue pin',async t=>{
 const ui=await audioDom(t),writes:any[]=[],api={request:async(path:string,init?:RequestInit)=>{if(init?.method)writes.push(JSON.parse(String(init.body)));return {items:[]};}} as Api;
 const view=(artifacts:any[])=>React.createElement(FileReview,{api,id:fileId,artifacts,onChanged:async()=>{},onClose:()=>{},initialSection:'speakers'});
 await ui.render(view(speakerArtifacts()));await ui.input(ui.d.querySelector('input')!,'Old acoustic draft');
 const nextDialogue=randomUUID(),nextDiarization=randomUUID();await ui.render(view(speakerArtifacts(nextDialogue,nextDiarization)));
 assert.equal(ui.d.querySelector('input')!.value,'','an old-file draft must not attach to a new acoustic/text version');
 await ui.input(ui.d.querySelector('input')!,'Current acoustic draft');await ui.click('保存名称');assert.deepEqual(writes,[{artifactId:nextDialogue,names:{SPEAKER_0:'Current acoustic draft'}}]);
});

for(const change of ['file','version','owner','close'] as const)test('late speaker sample and naming responses cannot cross '+change,async t=>{
 const ui=await audioDom(t),sample=deferred<Response>(),save=deferred(),signals:AbortSignal[]=[],events:string[]=[];
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method){signals.push(init.signal as AbortSignal);return save.promise;}return {items:[]};},raw:async(_path:string,init?:RequestInit)=>{signals.push(init?.signal as AbortSignal);return sample.promise;}} as Api;
 const props={api,id:fileId,artifacts:speakerArtifacts(),onChanged:async()=>{events.push('changed');},onClose:()=>events.push('closed'),initialSection:'speakers' as const};
 await ui.render(React.createElement(FileReview,props));await ui.input(ui.d.querySelector('input')!,'Old pending name');await ui.click('▷ 试听片段');await ui.click('保存名称');assert.equal(signals.length,2);
 await ui.render(change==='close'?null:React.createElement(FileReview,{...props,...(change==='file'?{id:randomUUID()}:change==='version'?{artifacts:speakerArtifacts(randomUUID(),randomUUID())}:{api:{...api} as Api})}));
 assert.ok(signals.every(signal=>signal?.aborted),'only page requests are aborted, without a Central cancel action');
 await act(async()=>{sample.resolve(new Response('late generated sample'));save.resolve({saved:true});});
 assert.deepEqual(events,[]);assert.deepEqual(ui.urls,[]);assert.equal(ui.d.querySelector('audio'),null);if(change!=='close')assert.equal(ui.d.querySelector('input')!.value,'');
});

test('CAM details never inherit WeSpeaker scores or names confirmed for a different dialogue',async t=>{
 const ui=await audioDom(t),artifacts:any[]=speakerArtifacts();
 artifacts[1]={...artifacts[1],modelProvenance:{embedding:'wespeaker-zh'},estimate:{method:'bounded-silhouette-v1',candidates:[],selectedClusters:2}};
 artifacts.push({id:randomUUID(),kind:'speaker-names',inputArtifact:randomUUID(),names:{SPEAKER_0:'Stale confirmed name'}});
 const api={request:async()=>({items:[]})} as Api;await ui.render(React.createElement(FileReview,{api,id:fileId,artifacts,onChanged:async()=>{},initialSection:'speakers'}));
 assert.match(ui.d.body.textContent!,/CAM\+\+/);assert.doesNotMatch(ui.d.body.textContent!,/轮廓系数|wespeaker-zh|Stale confirmed name/);assert.equal(ui.d.querySelector('input')!.value,'');
});

test('late review reads and submissions stop on leaving the panel without cancelling authorized background work',async t=>{
 const ui=await audioDom(t),read=deferred(),write=deferred(),requests:{method?:string;signal:AbortSignal;path:string}[]=[],events:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{requests.push({path,signal:init?.signal as AbortSignal,method:init?.method});return init?.method?write.promise:read.promise;}} as Api;
 await ui.render(React.createElement(FileReview,{api,id:fileId,artifacts:speakerArtifacts(),initialSection:'review',onChanged:async()=>{events.push('changed');}}));
 assert.match(ui.d.body.textContent!,/复核使用所选模型/);await ui.click('检查可能的识别错误');await ui.render(null);
 assert.ok(requests.every(request=>request.signal?.aborted));await act(async()=>{read.resolve({items:[{id:'late',reason:'STALE REVIEW'}]});write.resolve({queued:true});});assert.deepEqual(events,[]);assert.doesNotMatch(ui.d.body.textContent!,/STALE REVIEW/);assert.ok(requests.every(request=>!request.path.endsWith('/cancel')));
});

test('switching a recording aborts original/chunk reads and stops the previous player',async t=>{
 const f=await audioCentral(t),first=await f.upload(),second=await f.upload(),ui=await audioDom(t);
 await ui.render(React.createElement(FileDetail,{api:f.api,id:first,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('.recording-turn'));
 await until(()=>!ui.button('回听录音').disabled);await ui.click('回听录音');await until(()=>!!ui.d.querySelector('audio'));const audio=ui.d.querySelector('audio')!;assert.ok(audio);
 await ui.render(React.createElement(FileDetail,{api:f.api,id:second,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('.recording-turn'));
 assert.ok(ui.stopped.includes(audio));assert.equal(audio.hasAttribute('src'),false);assert.equal(ui.d.querySelector('audio'),null);
 const held=deferred(),oldSignals:AbortSignal[]=[];
 const delayed={...f.api,request:async<T>(path:string,init?:RequestInit):Promise<T>=>{if(path.endsWith('/playback')||path.includes('/chunks')){oldSignals.push(init?.signal as AbortSignal);return held.promise as Promise<T>;}return f.api.request<T>(path,init);}} as Api;
 await ui.render(React.createElement(FileDetail,{api:delayed,id:first,onOpen:()=>{}}));await until(()=>oldSignals.length===1);await until(()=>!ui.button('回听录音').disabled);await ui.click('回听录音');
 await ui.render(React.createElement(FileDetail,{api:f.api,id:second,onOpen:()=>{}}));assert.equal(oldSignals.length,2);assert.ok(oldSignals.every(signal=>signal.aborted));
 await act(async()=>held.resolve({url:'/api/files/'+first+'/content',items:[{id:'STALE CHUNK',ocrText:'STALE GENERATED TEXT'}],nextOffset:null}));assert.doesNotMatch(ui.d.body.textContent!,/STALE GENERATED TEXT/);assert.equal(ui.d.querySelector('audio'),null);
});

test('multiple sentence selections during playback loading keep the last exact time',async t=>{
 const f=await audioCentral(t),id=await f.upload(),ui=await audioDom(t),reply=deferred<{url:string}>();let playbackCalls=0;
 const api={...f.api,request:<T>(path:string,init?:RequestInit)=>path.endsWith('/playback')?(playbackCalls++,reply.promise as Promise<T>):f.api.request<T>(path,init)} as Api;
 await ui.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}}));await until(()=>ui.d.querySelectorAll('.recording-turn>.recording-time').length===3);
 const times=ui.d.querySelectorAll<HTMLButtonElement>('.recording-turn>.recording-time');await act(async()=>{times[0].click();times[2].click();});assert.equal(playbackCalls,1);
 await act(async()=>reply.resolve({url:'/api/files/'+id+'/content'}));const audio=ui.d.querySelector('audio')!;await act(async()=>audio.dispatchEvent(new ui.dom.window.Event('loadedmetadata')));assert.equal(audio.currentTime,.101,'the last selected group begins at 101 ms, including its overlapping tail');
});

test('Central completion updates an already-open recording without remounting or an extra text transform',async t=>{
 const f=await audioCentral(t),id=await f.upload('failed'),ui=await audioDom(t);
 await ui.render(React.createElement(FileDetail,{api:f.api,id,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('.recording-turn'));
 assert.equal(ui.d.querySelector('button.recording-speaker'),null);
 await f.upload('dialogue');f.node.processing.retry(id,'diarize');await f.node.processing.tick();
 await act(async()=>resources(f.api).invalidate(path=>path==='/api/files/'+id));await until(()=>!!ui.d.querySelector('button.recording-speaker'));
 assert.match(ui.d.body.textContent!,/零到二十。/);assert.match(ui.d.body.textContent!,/重叠的尾段。/);
});

test('an external owner rename refreshes visible chunks while retaining the current transcript version',async t=>{
 const f=await audioCentral(t),id=await f.upload(),ui=await audioDom(t),detail=await f.api.request<any>('/api/files/'+id),artifactId=detail.artifacts.find((a:any)=>a.kind==='dialogue').id;
 await ui.render(React.createElement(FileDetail,{api:f.api,id,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('button.recording-speaker'));
 await f.api.request('/api/files/'+id+'/speakers',{method:'POST',body:JSON.stringify({artifactId,names:{SPEAKER_0:'Generated external owner name'}})});
 await act(async()=>resources(f.api).invalidate(path=>path==='/api/files/'+id));await until(()=>ui.d.querySelector('button.recording-speaker')?.textContent?.includes('Generated external owner name')===true);
 const after=await f.api.request<any>('/api/files/'+id);assert.equal(after.artifacts.find((a:any)=>a.kind==='dialogue').id,artifactId);
});

test('closing processing details keeps an authorized Central stage running and lets its saved result complete',async t=>{
 const f=await audioCentral(t),gate=f.holdDiarization(),id=await f.upload('dialogue',false),running=f.node.processing.tick(),ui=await audioDom(t);
 try{
  await gate.started;await ui.render(React.createElement(FileDetail,{api:f.api,id,onOpen:()=>{}}));await until(()=>!!ui.d.querySelector('.recording-turn'));
  await ui.click('处理详情');await until(()=>!!ui.d.querySelector('.recording-dialog .file-diarization-settings'));assert.equal(f.node.files.detail(id).job!.state,'running');
  await ui.click('返回');assert.equal(ui.d.querySelector('.recording-dialog'),null);assert.equal(f.node.files.detail(id).job!.state,'running');assert.ok(f.calls.every(call=>!call.path.endsWith('/cancel')));
 }finally{gate.release();await running;}
 assert.equal(f.node.files.detail(id).job!.state,'succeeded');
});
