import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale,moteText} from '@mote/shared/i18n';
import type {RecordingStatus} from '@mote/shared';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {RecordingConnection,RecordingsSettings}=await import('../src/RecordingsSettings.js');
const tick=()=>new Promise(r=>setTimeout(r,20));
const button=(name:string)=>{const found=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name);assert.ok(found);return found;};
async function description(value:string){await act(async()=>{const input=document.querySelector('textarea')!;assert.ok(input);Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();});}
test('recording journey connects an existing account, explicitly enables import, preserves draft range and offers failure retry',async t=>{
 const calls:{path:string;init?:RequestInit}[]=[],status:RecordingStatus={provider:'feishu',connected:false,authorization:{revision:'00000000-0000-4000-8000-000000000001',environment:{installed:true,version:'1.0.98',configured:true}},selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});if(path.endsWith('/items?includeExports=true'))return {items:[]};if(path.endsWith('/connect'))status.connected=true;if(path.endsWith('/selection')){status.selection=JSON.parse(String(init?.body));status.counts.failed=1;}return structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'feishu',onOpen:()=>{}}));await tick();});
 assert.equal(calls.filter(c=>c.init?.method==='POST').length,0,'mounting never starts collection');assert.ok(element.querySelector('.recording-authorization'),'recording detail exposes authorization in its existing connection page');assert.ok(button('授权并连接账号'));assert.ok(button('连接已授权账号'));
 await act(async()=>{button('连接已授权账号').click();await tick();});const enabled=[...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e=>e.parentElement?.textContent?.includes('启用录音同步'))!;
 await act(async()=>{enabled.click();await tick();});assert.equal(button('立即同步').disabled,true,'unsaved edits must not sync');
 await act(async()=>{button('保存并开始同步').click();await tick();});const body=JSON.parse(String(calls.find(c=>c.path.endsWith('/selection'))?.init?.body));assert.equal(body.enabled,true);assert.equal(body.backupAudio,true);assert.equal(body.start,'2026-09-01T00:00:00Z');assert.equal(button('立即同步').disabled,false);
 await act(async()=>{button('重试失败步骤').click();await tick();});assert.ok(calls.some(c=>c.path.endsWith('/retry')));
});

test('recording range keeps typed year drafts through refresh and saves local dates only on submit',async t=>{
 const status:RecordingStatus={provider:'feishu',connected:true,selection:{enabled:true,start:'2026-09-01T00:00:12Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 const saves:Record<string,unknown>[]=[],api={request:async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/items?includeExports=true'))return {items:[]};
  if(init?.method==='PUT'){const body=JSON.parse(String(init.body));saves.push(body);status.selection=body;}
  return structuredClone(status);
 }} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'feishu',onOpen:()=>{}}));await tick();});
 const [start,end]=[...element.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')];
 const input=async(field:HTMLInputElement,value:string)=>act(async()=>{
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(field,value);
  field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();
 });
 await act(async()=>{element.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1].click();await tick();});
 await act(async()=>{button('保存并开始同步').click();await tick();});
 assert.equal(saves[0].start,'2026-09-01T00:00:12Z','untouched timestamps retain their seconds');
 start.focus();
 for(const year of ['0002','0020','0201','2011']){
  const value=year+'-09-01T08:30';await input(start,value);
  assert.equal(start.value,value,'React must not convert or rewrite each partial year');
  assert.equal(document.activeElement,start);
 }
 await input(end,'2012-10-02T18:45');
 await act(async()=>{resources(api).invalidate(path=>path==='/api/connectors/feishu-recordings');await tick();});
 assert.equal(start.value,'2011-09-01T08:30');assert.equal(end.value,'2012-10-02T18:45');
 assert.equal(button('立即同步').disabled,true);assert.equal(saves.length,1);
 await act(async()=>{button('保存并开始同步').click();await tick();});
 assert.equal(saves[1].start,new Date('2011-09-01T08:30').toISOString());
 assert.equal(saves[1].end,new Date('2012-10-02T18:45').toISOString());
 await input(start,'');await act(async()=>{button('保存并开始同步').click();await tick();});
 assert.equal(start.validity.valueMissing,true);assert.equal(saves.length,2,'an empty required start cannot silently save the old range');
 await input(start,'2011-09-01T08:30');await input(end,'');
 await act(async()=>{button('保存并开始同步').click();await tick();});
 assert.equal(saves[2].end,undefined,'clearing the optional end keeps continuous sync');
});

test('recording save acknowledges exact source description before enabling intake and a metadata-only edit keeps the sync lifecycle',async t=>{
 const sourceId='generated-recordings-owner',status:RecordingStatus={provider:'generated',connected:true,sourceId,selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 let snapshot={sourceId,version:0,description:''},ack!:()=>void;
 const writes:{path:string;body:any}[]=[],api={request:async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/context')){if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));writes.push({path,body});if(snapshot.version===0)await new Promise<void>(resolve=>ack=resolve);snapshot={...snapshot,version:snapshot.version+1,description:body.description};}return structuredClone(snapshot);}
  if(path.endsWith('/items?includeExports=true'))return {items:[]};
  if(init?.method){const body=JSON.parse(String(init.body));writes.push({path,body});if(path.endsWith('/selection'))status.selection=body;}
  return structuredClone(status);
 }} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'generated',onOpen:()=>{}}));await tick();});await act(tick);
 assert.ok(element.querySelector('.recording-save-bar .button.primary'),'save is the primary action, separated from sync controls');
 const prose='  Generated diary owner\nOther voices belong to their speakers.  ';
 await description(prose);await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();});
 await act(async()=>{button('保存并开始同步').click();await tick();});assert.equal(writes.length,1);assert.ok(writes[0].path.endsWith('/context'));assert.deepEqual(writes[0].body,{expectedVersion:0,description:prose});
 await act(async()=>{ack();await tick();});assert.ok(writes[1].path.endsWith('/selection'));assert.equal(writes[1].body.enabled,true);
 await description('Generated revised background');await act(async()=>{button('保存设置').click();await tick();});
 assert.equal(writes.filter(write=>write.path.endsWith('/selection')).length,1,'pure description edits never restart synchronization');assert.deepEqual(writes[2].body,{expectedVersion:1,description:'Generated revised background'});assert.match(element.textContent!,/设置已保存/);
});

test('a source description conflict preserves both drafts and prevents enabling recording intake',async t=>{
 const {ApiError}=await import('../src/api.js'),sourceId='generated-conflict',status:RecordingStatus={provider:'generated',connected:true,sourceId,selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}},writes:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method){writes.push(path);if(path.endsWith('/context'))throw new ApiError('Generated source version conflict',409);}if(path.endsWith('/context'))return {sourceId,version:2,description:'Generated saved description'};return path.includes('/steps?')?{items:status.steps,nextCursor:null}:path.endsWith('/items?includeExports=true')?{items:[]}:structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'generated',onOpen:()=>{}}));await tick();});await act(tick);
 await description('Generated unsaved declaration');await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();});
 await act(async()=>{button('保存并开始同步').click();await tick();});
 assert.equal(writes.some(path=>path.endsWith('/selection')),false);assert.equal(document.querySelector('textarea')!.value,'Generated unsaved declaration');assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,true);assert.match(element.textContent!,/Generated source version conflict/);assert.equal(button('立即同步').disabled,true);
});

test('a failed range save retries only the range after the source declaration was already acknowledged',async t=>{
 const sourceId='generated-partial-save',status:RecordingStatus={provider:'generated',connected:true,sourceId,selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 let snapshot={sourceId,version:0,description:''},attempts=0;const writes:string[]=[],api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method)writes.push(path);
  if(path.endsWith('/context')){if(init?.method)snapshot={...snapshot,version:1,description:JSON.parse(String(init.body)).description};return structuredClone(snapshot);}
  if(path.endsWith('/selection')){if(++attempts===1)throw Error('Generated range save failed');status.selection=JSON.parse(String(init?.body));}
  return path.endsWith('/items?includeExports=true')?{items:[]}:structuredClone(status);
 }} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'generated',onOpen:()=>{}}));await tick();});await act(tick);
 await description('Generated retained description');await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();});
 await act(async()=>{button('保存并开始同步').click();await tick();});assert.match(element.textContent!,/Generated range save failed/);
 await act(async()=>{button('保存并开始同步').click();await tick();});assert.equal(writes.filter(path=>path.endsWith('/context')).length,1);assert.equal(writes.filter(path=>path.endsWith('/selection')).length,2);assert.equal(document.querySelector('textarea')!.value,'Generated retained description');assert.match(element.textContent!,/设置已保存/);
});

test('switching central nodes during a description save never sends the old recording selection or publishes its late acknowledgement',async t=>{
 const sourceId='generated-old-source',oldStatus:RecordingStatus={provider:'generated',connected:true,sourceId,selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 let acknowledge!:(value:unknown)=>void,signal:AbortSignal|undefined;const writes:string[]=[];
 const oldApi={request:async(path:string,init?:RequestInit)=>{if(init?.method){writes.push(path);signal=init.signal as AbortSignal;return new Promise(resolve=>acknowledge=resolve);}return path.endsWith('/context')?{sourceId,version:0,description:''}:path.endsWith('/items?includeExports=true')?{items:[]}:structuredClone(oldStatus);}} as unknown as Api;
 const newSourceId='generated-new-source',newStatus={...oldStatus,sourceId:newSourceId},newApi={request:async(path:string,init?:RequestInit)=>{assert.equal(init?.method,undefined,'node switching must not write old settings on the new node');return path.endsWith('/context')?{sourceId:newSourceId,version:4,description:'Generated new node context'}:path.endsWith('/items?includeExports=true')?{items:[]}:structuredClone(newStatus);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api:oldApi,provider:'generated',onOpen:()=>{}}));await tick();});await act(tick);
 await description('Generated old draft');await act(async()=>{document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();});await act(async()=>{button('保存并开始同步').click();await tick();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api:newApi,provider:'generated',onOpen:()=>{}}));await tick();});await act(tick);
 assert.equal(signal?.aborted,true);await act(async()=>{acknowledge({sourceId,version:1,description:'Generated old draft'});await tick();});
 assert.equal(writes.length,1);assert.ok(writes[0].endsWith('/context'));assert.equal(document.querySelector('textarea')!.value,'Generated new node context');assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);assert.doesNotMatch(element.textContent!,/设置已保存/);
});

test('the recording page discovers third-party providers from the connector registry without a core provider list',async t=>{
 const status:RecordingStatus={category:'recordings',label:'Generated recorder plugin',provider:'generated',connected:false,setup:{description:'Generated authorization instructions',command:'generated login'},selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 const calls:string[]=[],api={request:async(path:string)=>{calls.push(path);return path==='/api/connectors/status'?{'generated-recordings':status,unrelated:null}:structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingsSettings,{api,onSources:()=>{},onOpen:()=>{}}));await tick();});
 await act(async()=>{await tick();});assert.ok(element.textContent?.includes(status.label!));
 const provider=element.querySelector<HTMLAnchorElement>('a[href="#/connections/recordings?provider=generated"]');assert.ok(provider,'the registered provider has an explicit detail entry');
 assert.ok(!calls.includes('/api/connectors/generated-recordings'),'the provider directory does not mount connection controls');
 await act(async()=>{dom.window.location.hash=provider.getAttribute('href')!;dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));await tick();});
 assert.ok(element.textContent?.includes(status.setup!.description!));assert.ok(calls.includes('/api/connectors/generated-recordings'));assert.ok(!calls.includes('/api/connectors/feishu-recordings'));
 await act(async()=>{dom.window.location.hash='#/connections/recordings';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));await tick();});
 assert.ok(element.querySelector('a[href="#/connections/recordings?provider=generated"]'),'back navigation returns to the provider directory');
});

for(const [locale,code,expected] of [
 ['zh-CN','unsupported_format','厂商转写格式尚不支持'],
 ['en','unsupported_format',"provider's transcript format is not supported"],
 ['zh-CN','generated_unknown_failure','generated_unknown_failure'],
 ['en','generated_unknown_failure','generated_unknown_failure'],
] as const)test('recording failures keep archived audio separate from transcript failure and report the exact cause in '+locale+' / '+code,async t=>{
 configureLocale(()=>locale);t.after(()=>configureLocale(()=> 'zh-CN'));
 const status:RecordingStatus={provider:'generated',connected:true,selection:{enabled:true,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[{id:'generated-transcript-step',phase:'transcript',state:'failed',attempts:1,error:code},{id:'generated-audio-step',phase:'media',state:'succeeded',attempts:1}],counts:{transcripts:0,audio:1,pending:0,failed:1}};
 const writes:string[]=[],api={request:async(path:string,init?:RequestInit)=>{if(init?.method)writes.push(path);return path.includes('/steps?')?{items:status.steps,nextCursor:null}:path.endsWith('/items?includeExports=true')?{items:[]}:structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'generated',onOpen:()=>{}}));await tick();});
 assert.match(element.textContent??'',new RegExp(expected));
 assert.match(element.querySelector('p[role=status]')?.textContent??'',locale==='en'?/0 transcripts and 1 audio files/:/转写 0 条，音频 1 条/);
 await act(async()=>{const summary=[...element.querySelectorAll('summary')].find(s=>s.textContent?.startsWith(moteText('同步步骤与状态')))!;assert.ok(summary);const details=summary.parentElement as HTMLDetailsElement;details.open=true;details.dispatchEvent(new dom.window.Event('toggle'));await tick();});
 assert.match(element.textContent??'',locale==='en'?/Back up audio|Audio backup/:/备份音频/);
 assert.equal(writes.length,0,'reading a failure never changes its source or repeats archival');
 assert.doesNotMatch(element.textContent??'',locale==='en'?/Check the node network and provider read permissions/:/请检查节点网络与厂商读取权限/);
});
