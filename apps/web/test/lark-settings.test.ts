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
const {LarkSettings,LarkJobStatus}=await import('../src/LarkSettings.js');
const base=():LarkStatus=>({installed:true,configured:true,connected:true,version:'1.0.57',missingScopes:[],selection:{documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false}});
const tick=()=>new Promise(r=>setTimeout(r,20));
const button=(name:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===name);assert.ok(b,`button ${name}`);return b;};
async function click(name:string){await act(async()=>{button(name).click();await tick();});}
async function input(element:HTMLInputElement|HTMLTextAreaElement,value:string){await act(async()=>{const proto=element instanceof dom.window.HTMLTextAreaElement?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();});}
async function mount(t:any,status:LarkStatus,fail=false){
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container),calls:{path:string;init?:RequestInit}[]=[];let back=0,sources=0;
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});if(fail)throw Error('fixture network unavailable');
  if(path.endsWith('/calendars'))return {calendars:[{id:'fixture-calendar',name:'合成日历',primary:true}]};
  if(path.endsWith('/selection')){status.selection=JSON.parse(String(init?.body));return structuredClone(status);}
  if(path.endsWith('/install')){status.job={id:'fixture',kind:'install',state:'running'};return status.job;}
  if(path.endsWith('/login')){status.job={id:'fixture',kind:'login',state:'waiting',authorizationUrl:'https://accounts.feishu.cn/authorize?opaque=a%2Bb',expiresAt:new Date(Date.now()+600000).toISOString()};return status.job;}
  if(path.endsWith('/cancel')){status.job={...status.job!,state:'cancelled',authorizationUrl:undefined};return structuredClone(status);}
  if(init?.method==='DELETE'){status.connected=false;return structuredClone(status);}
  return structuredClone(status);
 }} as unknown as Api;
 await act(async()=>{root.render(React.createElement(LarkSettings,{api,onBack:()=>back++,onSources:()=>sources++}));await tick();});
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {calls,container,get back(){return back;},get sources(){return sources;}};
}

test('setup page offers install, locks read scope before login and keeps navigation working',async t=>{
 const f=await mount(t,{...base(),installed:false,configured:false,connected:false});
 assert.equal(button('安装 Lark CLI').disabled,false);assert.equal(button('扫码登录并授权只读权限').disabled,true);assert.equal(document.querySelector('fieldset')?.disabled,true);
 await click('安装 Lark CLI');assert.ok(f.calls.some(c=>c.path.endsWith('/install')));assert.match(f.container.textContent!,/安装 CLI · 正在处理/);
 await click('设置');assert.equal(f.back,1);await click('查看来源与归档');assert.equal(f.sources,1);
});

test('authorization shows exact external URL and QR then removes them on cancel',async t=>{
 await mount(t,{...base(),connected:false});await click('扫码登录并授权只读权限');
 const a=document.querySelector<HTMLAnchorElement>('.lark-authorization a')!;assert.equal(a.getAttribute('href'),'https://accounts.feishu.cn/authorize?opaque=a%2Bb');assert.equal(a.target,'_blank');assert.match(a.rel,/noopener/);
 await act(tick);assert.match(document.querySelector('img')!.src,/^data:image\/png;base64,/);
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});await click('复制授权链接');assert.equal(copied,a.getAttribute('href'));assert.match(document.body.textContent!,/授权链接已复制/);
 await click('取消当前操作');assert.equal(document.querySelector('.lark-authorization'),null);assert.match(document.body.textContent!,/已取消/);
});

test('scope edits and calendar choice are saved explicitly; dirty scope prevents syncing',async t=>{
 const status=base(),f=await mount(t,status);await click('加载可选日历');
 const checkbox=[...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e=>e.parentElement?.textContent?.includes('合成日历'))!;
 await act(async()=>{checkbox.click();await tick();});
 await input(document.querySelector('textarea')!,'https://fixture.feishu.cn/docx/DocFixture123');
 assert.equal(button('立即同步').disabled,true);await click('保存同步范围');
 const saved=JSON.parse(String(f.calls.find(c=>c.path.endsWith('/selection'))?.init?.body));assert.deepEqual(saved.calendarIds,['fixture-calendar']);assert.deepEqual(saved.documents,['https://fixture.feishu.cn/docx/DocFixture123']);assert.equal(saved.autoSync,false);
 assert.equal(button('立即同步').disabled,false);assert.match(document.body.textContent!,/同步范围已保存/);
});

test('disconnect explains retained history and requires its own explicit click',async t=>{
 const f=await mount(t,base());await click('断开连接');assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,0);assert.match(document.body.textContent!,/保留已归档资料/);
 await click('返回');assert.equal(document.querySelector('button')?.textContent,'设置');assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,0);
 await click('断开连接');await click('确认断开');assert.equal(f.calls.filter(c=>c.init?.method==='DELETE').length,1);assert.equal(document.querySelector('fieldset')?.disabled,true);
});

test('request failure and expired authorization have actionable visible error states',async t=>{
 await mount(t,base(),true);assert.match(document.querySelector('[role=alert]')!.textContent!,/fixture network unavailable/);
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>{root.render(React.createElement(LarkJobStatus,{job:{id:'fixture',kind:'login',state:'failed',error:'lark_authorization_expired'}}));await tick();});assert.match(container.textContent!,/授权链接已过期，请重新发起登录/);assert.equal(container.querySelector('a'),null);
});
