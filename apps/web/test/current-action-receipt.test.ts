import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api';
import {CurrentActionReceipt} from '../src/plugins/work/ActionResults';
import {calendarEvent,currentOwnerCalendarFixture} from '../../server/test/fixtures/current-owner-calendar';
import {until} from '../../server/test/fixtures/current-owner-instruction';

configureLocale(()=> 'zh-CN');
async function fixture(t:any,respond?:Parameters<typeof currentOwnerCalendarFixture>[1],allowCalendarChanges=false){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const f=await currentOwnerCalendarFixture(t,respond,allowCalendarChanges),httpCalls:{path:string;method:string;done:boolean}[]=[],api={request:async(path:string,init?:RequestInit)=>{const call={path,method:init?.method??'GET',done:false};httpCalls.push(call);try{const response=await f.node.app.inject({url:path,method:call.method as 'GET'|'POST',headers:f.headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});if(response.statusCode>=400)throw new ApiError('Generated owner HTTP failure',response.statusCode);return response.json();}finally{call.done=true;}}} as Api;
 return {...f,get node(){return f.node;},root,d:dom.window.document,api,httpCalls};
}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.includes(text));

test('the actual owner HTTP reference renders its original successful Action receipt without a second confirmation',async t=>{
 const f=await fixture(t),accepted=await f.post(),message=await f.settled(accepted.message.id),reference=message.result!.currentAction!;await until(()=>f.node.actions.get(reference.id).status==='succeeded'?true:undefined,'original Action success');
 await act(async()=>{f.root.render(React.createElement(CurrentActionReceipt,{api:f.api,reference}));});
 assert.match(f.d.querySelector('[role=status]')!.textContent!,/已写入已有日历/);assert.equal(f.d.querySelector('a')!.getAttribute('href'),'#/actions?action='+reference.id);assert.equal(button(f.d,'开始'),undefined);assert.equal(button(f.d,'确认'),undefined);assert.equal(f.calls.length,1);assert.equal(f.effects.size,1);assert.equal(f.d.body.textContent!.includes('inputHash'),false);
});

test('actual in-flight cancellation renders pending verification then the late real success from the same receipt',async t=>{
 const f=await fixture(t),release=f.blockEffect(),accepted=await f.post(),message=await f.settled(accepted.message.id),reference=message.result!.currentAction!;await until(()=>f.calls.length===1?true:undefined,'in-flight actual connector');
 await act(async()=>f.root.render(React.createElement(CurrentActionReceipt,{api:f.api,reference})));assert.match(f.d.querySelector('[role=status]')!.textContent!,/同步中/);
 const before=f.httpCalls.length;await act(async()=>{button(f.d,'停止后续执行')!.click();await until(()=>f.httpCalls.length===before+2&&f.httpCalls.slice(before).every(call=>call.done)?true:undefined,'actual cancel POST and receipt GET');});assert.match(f.d.querySelector('[role=status]')!.textContent!,/已请求取消，写入结果仍待核实/);assert.equal(f.effects.size,0);
 release();await until(()=>f.node.actions.get(reference.id).status==='succeeded'?true:undefined,'late connector success');const reads=f.httpCalls.length;await act(async()=>{button(f.d,'刷新状态')!.click();await until(()=>f.httpCalls.length===reads+1&&f.httpCalls.at(-1)!.done?true:undefined,'actual successful receipt GET');});assert.match(f.d.querySelector('[role=status]')!.textContent!,/已写入已有日历/);assert.equal(f.calls.length,1);assert.equal(f.effects.size,1);assert.equal(button(f.d,'停止后续执行'),undefined);
});

test('the actual current calendar cancellation reference renders its original provider receipt without another confirmation',async t=>{
 let kind='calendar.create';
 const f=await fixture(t,({envelope})=>{const target=envelope.ownerActionTargets?.find((target:any)=>target.kind===kind);return target?{answer:'The Action receipt determines the result.',citationIds:[],draft:{goal:'Carry out the current owner calendar instruction',input:'current-action',action:{kind,targetId:target.id,event:target.event??calendarEvent}}}:{answer:'Original event unavailable.',citationIds:[],draft:null};},true);
 const first=await f.post(),created=await f.settled(first.message.id);await until(()=>f.node.actions.get(created.result!.currentAction!.id).status==='succeeded'?true:undefined,'original event success');
 kind='calendar.cancel';const accepted=await f.post('Cancel the event I just created.'),message=await f.settled(accepted.message.id);const page=await f.api.request<any>(`/api/conversations/${f.conversationId}?anchor=${message.id}&limit=1`);const reference=page.turns.find((turn:{id:string})=>turn.id===message.id).result.currentAction;assert.equal(reference.kind,'calendar.cancel');await until(()=>f.node.actions.get(reference.id).status==='succeeded'?true:undefined,'actual cancellation receipt');
 await act(async()=>f.root.render(React.createElement(CurrentActionReceipt,{api:f.api,reference})));
 assert.match(f.d.querySelector('[role=status]')!.textContent!,/已取消/);assert.equal(f.d.querySelector('a')!.getAttribute('href'),'#/actions?action='+reference.id);assert.equal(button(f.d,'确认'),undefined);assert.equal(button(f.d,'开始'),undefined);assert.equal(f.calls.length,2);assert.equal(f.effects.size,0);
});
