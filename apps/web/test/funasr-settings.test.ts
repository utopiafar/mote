import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useState} from 'react';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileDiarizationOptionsSchema,mediaModelsViewSchema} from '@mote/shared';
import {AudioProcessingSettings,AudioCleanupSetting,AudioModelStatus,AudioDiarizationSetting} from '../src/AudioProcessingSettings.js';
import {FileProcessingControls} from '../src/FileProcessingControls.js';
import {type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {MEDIA_CATALOG} from '../../server/src/media-assets.js';
import {audioCentral,audioDom,deferred,until} from './fixtures/funasr-ui.js';

test('audio settings consume real Central installation and worker HTTP statuses without showing the retired backend',async t=>{
 let health:Record<string,unknown>={protocol:'mote.funasr/1',asr:false,diarization:false,missingDependencies:['funasr','torch']};
 const worker=createServer((request,response)=>{assert.equal(request.headers.authorization,'Bearer generated-audio-health');response.setHeader('content-type','application/json');response.end(JSON.stringify(health));});
 worker.listen(0,'127.0.0.1');await once(worker,'listening');t.after(async()=>{worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));});
 const f=await audioCentral(t,{mediaWorker:{endpoint:`http://127.0.0.1:${(worker.address() as {port:number}).port}/transcribe`,token:'generated-audio-health'}}),ui=await audioDom(t),before=f.node.modelAuthorization.view();
 const prior=MEDIA_CATALOG.dialogue,data=Buffer.from('Generated UI model bytes; no weights');MEDIA_CATALOG.dialogue={version:'generated-ui-funasr',files:[{name:'asr/generated.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://example.invalid/generated-ui'}]};t.after(()=>{MEDIA_CATALOG.dialogue=prior;});
 await ui.render(React.createElement(AudioProcessingSettings,{api:f.api}));await until(()=>ui.d.body.textContent!.includes('尚未安装'));
 assert.match(ui.d.body.textContent!,/Fun-ASR-Nano-2512 \+ fsmn-vad \+ CAM\+\+ \+ CT-Punc/);assert.doesNotMatch(ui.d.body.textContent!,/WeSpeaker|3D-Speaker|faster.whisper|sherpa/);
 assert.ok(f.calls.every(call=>!call.init.method),'mounting settings does not install models or authorize background work');
 const bundle=join(f.directory,'generated-model-bundle');await mkdir(join(bundle,'asr'),{recursive:true});await writeFile(join(bundle,'asr/generated.bin'),data);await f.node.featureServices.mediaAssets.importBundle('dialogue',bundle);
 const refresh=async()=>act(async()=>resources(f.api).invalidate(path=>path==='/api/media-models'||path==='/api/media-preparation'));
 await refresh();await until(()=>ui.d.body.textContent!.includes('缺少运行依赖：funasr, torch'));
 assert.match(ui.d.querySelector('.audio-model-status')!.textContent!,/模型已准备，音频或图片服务尚未就绪/);assert.match(ui.d.body.textContent!,/generated-ui-funasr/);
 health={protocol:'mote.funasr/1',asr:true,diarization:true,missingDependencies:[],identity:f.bundle.request.identity};await refresh();await until(()=>ui.d.querySelector('.audio-model-status [role=status]')?.textContent==='可使用');
 const actual=f.responses.filter(response=>response.path==='/api/media-models').at(-1)!;assert.equal(mediaModelsViewSchema.parse(JSON.parse(actual.body)).dialogue!.runtimeReady,true);
 health={version:2,asr:true,diarization:true,missingDependencies:['faster_whisper','sherpa_onnx']};await refresh();await until(()=>ui.d.querySelector('.audio-model-status [role=status]')?.textContent?.includes('尚未就绪')===true);
 assert.doesNotMatch(ui.d.body.textContent!,/faster_whisper|sherpa_onnx|WeSpeaker/);assert.deepEqual(f.node.modelAuthorization.view(),before);
 if(process.env.MOTE_ASR05_SETTINGS_EXAMPLE_PATH)await writeFile(process.env.MOTE_ASR05_SETTINGS_EXAMPLE_PATH,JSON.stringify({evidence:'generated model bytes and health; actual verified installation and authenticated route serializers',responses:f.responses.filter(response=>response.path==='/api/media-models').map(response=>JSON.parse(response.body))},null,2)+'\n');
});

test('closing the settings panel aborts page reads and never cancels an installation or background task',async t=>{
 const ui=await audioDom(t),read=deferred(),calls:{path:string;init?:RequestInit}[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});return read.promise;}} as Api;
 await ui.render(React.createElement(AudioProcessingSettings,{api}));assert.equal(calls.length,2);await ui.render(null);
 assert.ok(calls.every(call=>call.init?.signal?.aborted));await act(async()=>read.resolve({}));assert.equal(ui.d.body.textContent,'');assert.ok(calls.every(call=>!call.init?.method));
});

test('an old-owner late status cannot replace the current status or keep polling after unmount',async t=>{
 const ui=await audioDom(t),old=deferred(),signals:AbortSignal[]=[],oldApi={request:async(_path:string,init?:RequestInit)=>{signals.push(init?.signal as AbortSignal);return old.promise;}} as Api;
 t.mock.timers.enable({apis:['setTimeout']});
 const model={role:'dialogue',state:'ready',version:'generated-current-owner',bytes:1,totalBytes:1,source:'generated',runtimeReady:false};
 const currentApi={request:async()=>({dialogue:model})} as Api;
 await ui.render(React.createElement(AudioModelStatus,{api:oldApi}));await ui.render(React.createElement(AudioModelStatus,{api:currentApi}));assert.equal(signals[0].aborted,true);
 await act(async()=>old.resolve({dialogue:{...model,version:'STALE OWNER',runtimeReady:true}}));assert.match(ui.d.body.textContent!,/generated-current-owner/);assert.doesNotMatch(ui.d.body.textContent!,/STALE OWNER|可使用/);await ui.render(null);
 t.mock.timers.tick(15000);assert.equal(signals.length,1);t.mock.timers.reset();
});

test('conservative cleanup defaults on and can be disabled without changing other parameters or running work',async t=>{
 const ui=await audioDom(t),edits:unknown[]=[];
 function Profile(){const [parameters,setParameters]=useState({speakerCount:null,semanticTurns:true} as Record<string,string|number|boolean|null>);return React.createElement(AudioCleanupSetting,{parameters,onChange:value=>{edits.push(value);setParameters(value);}});}
 await ui.render(React.createElement(Profile));const checkbox=ui.d.querySelector('input')!;assert.equal(checkbox.checked,true);assert.match(ui.d.body.textContent!,/原文始终可对照和导出/);
 await act(async()=>checkbox.click());assert.equal(checkbox.checked,false);assert.deepEqual(edits,[{speakerCount:null,semanticTurns:true,deduplicate:false}]);await act(async()=>checkbox.click());assert.deepEqual(edits[1],{speakerCount:null,semanticTurns:true,deduplicate:true});
});

test('the fixed CAM setting exposes an unavailable saved choice until the owner explicitly replaces it',async t=>{
 const ui=await audioDom(t),edits:string[]=[];
 await ui.render(React.createElement(AudioDiarizationSetting,{processor:'audio.diarize-wespeaker',onChange:value=>edits.push(value)}));
 assert.match(ui.d.body.textContent!,/插件不可用 · audio.diarize-wespeaker/);assert.equal(ui.d.querySelector('select'),null);assert.deepEqual(edits,[]);
 await ui.click('使用 CAM++');assert.deepEqual(edits,['audio.diarize']);
});

test('single-file CAM options submit the current raw pin and an explicit range, then reset on recording change',async t=>{
 const f=await audioCentral(t),first=await f.upload(),second=await f.upload(),ui=await audioDom(t),writes:{path:string;body:any}[]=[];
 // ASR-03 owns the future retry handler. Keep this timing/transport boundary
 // controlled on #868; all reads still consume the real Central serializers.
 const api={...f.api,request:async<T>(path:string,init?:RequestInit):Promise<T>=>{if(path.endsWith('/retry')){writes.push({path,body:JSON.parse(String(init?.body))});return {queued:true} as T;}return f.api.request<T>(path,init);}} as Api;
 await ui.render(React.createElement(FileProcessingControls,{api,id:first}));await until(()=>!!ui.d.querySelector('.file-diarization-settings'));
 assert.match(ui.d.querySelector('.file-diarization-settings')!.textContent!,/CAM\+\+/);assert.doesNotMatch(ui.d.body.textContent!,/WeSpeaker|3D-Speaker/);
 const mode=ui.d.querySelector('select')!;await act(async()=>{mode.value='range';mode.dispatchEvent(new ui.dom.window.Event('change',{bubbles:true}));});
 let inputs=ui.d.querySelectorAll<HTMLInputElement>('input[type=number]');await ui.input(inputs[0],'1');await ui.input(inputs[1],'3');
 await act(async()=>ui.d.querySelector('form')!.dispatchEvent(new ui.dom.window.Event('submit',{bubbles:true,cancelable:true})));
 const detail=await f.api.request<any>('/api/files/'+first),raw=detail.artifacts.find((a:any)=>a.kind==='transcript');
 assert.deepEqual(writes,[{path:'/api/files/'+first+'/retry',body:{stage:'diarize',diarization:{artifactId:raw.id,options:{processor:'audio.diarize',speakerCount:null,range:{min:1,max:3}}}}}]);assert.equal(fileDiarizationOptionsSchema.parse(writes[0].body.diarization.options).processor,'audio.diarize');
 await ui.render(React.createElement(FileProcessingControls,{api,id:second}));await until(()=>!!ui.d.querySelector('select'));assert.equal(ui.d.querySelector('select')!.value,'unknown');assert.equal(ui.d.querySelectorAll('input[type=number]').length,0);
 await act(async()=>{const select=ui.d.querySelector('select')!;select.value='exact';select.dispatchEvent(new ui.dom.window.Event('change',{bubbles:true}));});await ui.input(ui.d.querySelector('input[type=number]')!,'2');await act(async()=>ui.d.querySelector('form')!.dispatchEvent(new ui.dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.deepEqual(writes[1].body.diarization.options,{processor:'audio.diarize',speakerCount:2,range:null});assert.equal(writes[1].path,'/api/files/'+second+'/retry');
 await act(async()=>{const select=ui.d.querySelector('select')!;select.value='range';select.dispatchEvent(new ui.dom.window.Event('change',{bubbles:true}));});inputs=ui.d.querySelectorAll('input[type=number]');await ui.input(inputs[0],'4');await ui.input(inputs[1],'2');
 await act(async()=>ui.d.querySelector('form')!.dispatchEvent(new ui.dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(writes.length,2);assert.match(ui.d.body.textContent!,/完整有序范围/);
});
