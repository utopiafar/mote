import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import type {LarkStatus} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
configureLocale(()=> 'zh-CN');
import type {Api} from '../src/api.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {LarkSettings,LarkJobStatus}=await import('../src/plugins/sources/LarkSettings.js');
const base=():LarkStatus=>({installed:true,configured:true,connected:true,version:'1.0.85',missingScopes:[],documentSync:{confirmed:true,documents:0,activities:0,failed:0,pending:0,errors:[]},lastSyncAt:'2026-10-14T01:00:00.000Z',selection:{documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false}});
const tick=()=>new Promise(r=>setTimeout(r,20));
const button=(name:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===name);assert.ok(b,`button ${name}`);return b;};
async function click(name:string){await act(async()=>{button(name).click();await tick();});}
async function input(element:HTMLInputElement|HTMLTextAreaElement,value:string){await act(async()=>{const proto=element instanceof dom.window.HTMLTextAreaElement?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();});}
async function mount(t:any,status:LarkStatus,fail=false){
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container),calls:{path:string;init?:RequestInit}[]=[];let sources=0;
 let sourceEnabled=true;
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});if(fail)throw Error('fixture network unavailable');
  if(path.endsWith('/context'))return {sourceId:'generated-documents',version:0,description:''};
  if(path==='/api/sources')return {items:[{id:'generated-documents',enabled:sourceEnabled}]};
  if(path.startsWith('/api/sources/')){if(init?.method==='PATCH'&&typeof JSON.parse(String(init.body)).enabled==='boolean')sourceEnabled=JSON.parse(String(init.body)).enabled;return {id:'generated-documents',enabled:sourceEnabled};}
  if(path.endsWith('/calendars'))return {calendars:[{id:'fixture-calendar',name:'合成日历',primary:true}]};
  if(path.endsWith('/selection')){const scope=(value:typeof status.selection)=>JSON.stringify([value.documents,value.folders??[],value.wikiRoots??[],value.excludedDocuments??[],value.documentDiscovery]);const next=JSON.parse(String(init?.body));if(scope(next)!==scope(status.selection))status.documentSync={documents:0,activities:0,failed:0,pending:0,errors:[],...status.documentSync,confirmed:false,preview:undefined};status.selection=next;return structuredClone(status);}
  if(path.endsWith('/install')){status.job={id:'fixture',kind:'install',state:'running'};return status.job;}
  if(path.endsWith('/login')){status.job={id:'fixture',kind:'login',state:'waiting',authorizationUrl:'https://accounts.feishu.cn/authorize?opaque=a%2Bb',expiresAt:new Date(Date.now()+600000).toISOString()};return status.job;}
  if(path.endsWith('/cancel')){status.job={...status.job!,state:'cancelled',authorizationUrl:undefined};return structuredClone(status);}
  if(path.endsWith('/preview')){status.documentSync={confirmed:false,documents:0,activities:0,failed:0,pending:0,errors:[],preview:[{reference:'https://fixture.feishu.cn/docx/DocFixture123',title:'合成日记'}],previewTotal:1};return {id:'preview',kind:'preview',state:'completed'};}
  if(path.endsWith('/sync')){status.job={id:'sync',kind:'sync',state:'completed',result:{imported:1,duplicates:0,activities:1}};return status.job;}
  if(init?.method==='DELETE'){status.connected=false;return structuredClone(status);}
  return structuredClone(status);
 }} as unknown as Api;
 await act(async()=>{root.render(React.createElement(LarkSettings,{api,onSources:()=>sources++}));await tick();});
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {calls,container,get sources(){return sources;}};
}

test('setup page offers install, locks read scope before login and keeps navigation working',async t=>{
 const f=await mount(t,{...base(),installed:false,configured:false,connected:false});
 assert.equal(button('安装 Lark CLI').disabled,false);assert.equal(button('扫码登录并授权只读权限').disabled,true);assert.equal(document.querySelector('fieldset')?.disabled,true);
 await click('安装 Lark CLI');assert.ok(f.calls.some(c=>c.path.endsWith('/install')));assert.match(f.container.textContent!,/安装 CLI · 正在处理/);
 await click('查看来源与归档');assert.equal(f.sources,1);
});

test('authorization shows exact external URL and QR then removes them on cancel',async t=>{
 await mount(t,{...base(),connected:false});await click('扫码登录并授权只读权限');
 const a=document.querySelector<HTMLAnchorElement>('.lark-authorization a')!;assert.equal(a.getAttribute('href'),'https://accounts.feishu.cn/authorize?opaque=a%2Bb');assert.equal(a.target,'_blank');assert.match(a.rel,/noopener/);
 await act(tick);assert.match(document.querySelector('img')!.src,/^data:image\/png;base64,/);
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});await click('复制授权链接');assert.equal(copied,a.getAttribute('href'));assert.match(document.body.textContent!,/授权链接已复制/);
 await click('取消当前操作');assert.equal(document.querySelector('.lark-authorization'),null);assert.match(document.body.textContent!,/已取消/);
});

test('calendar read authorization is explicit and does not select calendars or start collection',async t=>{
 const f=await mount(t,base());await click('授权日历读取');
 const login=f.calls.find(call=>call.path.endsWith('/login'))!;assert.deepEqual(JSON.parse(String(login.init?.body)),{calendar:true});
 assert.equal(f.calls.some(call=>call.path.endsWith('/selection')||call.path.endsWith('/sync')),false);
});

test('scope edits and calendar choice are saved explicitly; dirty scope prevents syncing',async t=>{
 const status=base(),f=await mount(t,status);await click('加载可选日历');
 const checkbox=[...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e=>e.parentElement?.textContent?.includes('合成日历'))!;
 await act(async()=>{checkbox.click();await tick();});
 await input(document.querySelector('textarea')!,'https://fixture.feishu.cn/docx/DocFixture123');
 assert.equal(button('立即同步').disabled,true);await click('保存同步范围');
 const saved=JSON.parse(String(f.calls.find(c=>c.path.endsWith('/selection'))?.init?.body));assert.deepEqual(saved.calendarIds,['fixture-calendar']);assert.deepEqual(saved.documents,['https://fixture.feishu.cn/docx/DocFixture123']);assert.equal(saved.autoSync,false);
 assert.equal(button('确认并开始归档').disabled,true);assert.match(document.body.textContent!,/同步范围已保存/);
 await click('预览文档范围');assert.equal(button('确认并开始归档').disabled,false);
});

test('disconnect explains retained history and requires its own explicit click',async t=>{
 const f=await mount(t,base());await click('断开连接');assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,0);assert.match(document.body.textContent!,/保留已归档资料/);
 await click('返回');assert.equal(document.querySelector('.back-link'),null);assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,0);
 await click('断开连接');await click('确认断开');assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,1);assert.equal(document.querySelector('fieldset')?.disabled,true);
});

test('request failure and expired authorization have actionable visible error states',async t=>{
 await mount(t,base(),true);assert.match(document.querySelector('[role=alert]')!.textContent!,/fixture network unavailable/);
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>{root.render(React.createElement(LarkJobStatus,{job:{id:'fixture',kind:'login',state:'failed',error:'lark_authorization_expired'}}));await tick();});assert.match(container.textContent!,/授权链接已过期，请重新发起登录/);assert.equal(container.querySelector('a'),null);
});

test('new activity scope previews metadata before archive confirmation even after a prior calendar sync',async t=>{
 const status=base();status.documentSync=undefined;status.selection={...status.selection,autoSync:true,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30}};
 const f=await mount(t,status);
 assert.equal(button('确认并开始归档').disabled,true);
 const check=(label:string)=>[...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(input=>input.parentElement?.textContent===label)!;
 assert.equal(check('我创建的').checked,true);assert.equal(check('我编辑过的').checked,true);assert.equal(check('我打开过的').checked,true);
 const field=(label:string)=>[...document.querySelectorAll('label')].find(item=>item.textContent===label)!.querySelector('textarea')!;
 await input(field('文件夹（每行一个）'),' folder-generated \n');
 await input(field('知识库分支（每行一个）'),'wiki-generated');
 await input(field('不再读取的文档（每行一个）'),'excluded-generated');
 assert.equal(button('预览文档范围').disabled,true);
 await click('保存同步范围');
 const saved=JSON.parse(String(f.calls.find(c=>c.path.endsWith('/selection'))?.init?.body));
 assert.deepEqual(saved.documentDiscovery,{created:true,edited:true,opened:true,firstSyncDays:30});assert.deepEqual(saved.folders,['folder-generated']);assert.deepEqual(saved.wikiRoots,['wiki-generated']);assert.deepEqual(saved.excludedDocuments,['excluded-generated']);assert.equal(saved.autoSync,true);
 assert.equal(f.calls.some(call=>call.path.endsWith('/sync')),false,'saving never invokes content sync from the UI');
 await click('预览文档范围');
 assert.match(f.container.textContent!,/合成日记/);assert.match(f.container.textContent!,/尚未因预览读取正文/);
 assert.equal(button('确认并开始归档').disabled,false);
 await click('确认并开始归档');assert.equal(f.calls.filter(call=>call.path.endsWith('/sync')).length,1);
 assert.match(f.container.textContent!,/保存 1 条文档活动线索/);
});

test('legacy connection keeps discovery opted out; partial failure can retry one document and preserve pause',async t=>{
 const status=base();status.selection.documents=['DocFixture123'];status.documentSync={confirmed:true,sourceId:'generated-documents',documents:3,activities:4,failed:1,pending:0,errors:[{reference:'DocFailure123',code:'lark_document_sync_incomplete'}]};
 const f=await mount(t,status);
 const discovery=[...document.querySelectorAll<HTMLInputElement>('.lark-discovery-options input')];assert.equal(discovery.length,3);assert.ok(discovery.every(input=>!input.checked));
 assert.match(f.container.textContent!,/已归档 3 篇文档 · 4 条活动线索/);
 await click('重试此文档');const retry=f.calls.find(call=>call.path.endsWith('/sync'))!;assert.deepEqual(JSON.parse(String(retry.init?.body)),{document:'DocFailure123'});
 await click('暂停接入');assert.equal(button('立即同步').disabled,true);assert.match(f.container.textContent!,/保存范围或重新授权不会恢复接入/);
 await click('保存同步范围');assert.equal(button('立即同步').disabled,true);assert.ok(button('恢复接入'));
 await click('恢复接入');assert.equal(button('立即同步').disabled,false);
});

test('a legacy snapshot source asks explicitly to retain full Markdown before retrying a large document',async t=>{
 const status=base();status.selection.documents=['DocFixture123'];status.documentSync={confirmed:true,sourceId:'generated-documents',documents:0,activities:0,failed:1,pending:1,errors:[{reference:'LargeFixture123',code:'lark_document_archive_required'}]};
 const f=await mount(t,status);assert.match(f.container.textContent!,/图片和附件仍只保留引用/);
 await click('为此来源保留完整正文并重试');
 const mutation=f.calls.findIndex(call=>call.path==='/api/sources/generated-documents'&&call.init?.method==='PATCH'),sync=f.calls.findIndex(call=>call.path.endsWith('/sync'));
 assert.ok(mutation>=0&&sync>mutation);assert.deepEqual(JSON.parse(String(f.calls[mutation].init?.body)),{retention:'archive'});assert.deepEqual(JSON.parse(String(f.calls[sync].init?.body)),{document:'LargeFixture123'});
});
