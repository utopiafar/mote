import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {AnswerView} from '../src/shell-components';
import {currentInstructionFixture} from '../../server/test/fixtures/current-owner-instruction';

configureLocale(()=> 'zh-CN');

test('the saved owner record acknowledgement renders through the existing compact conversation answer without task or source controls',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const acknowledgement='记下了，今天午休散步了十分钟。',f=await currentInstructionFixture(t,()=>({answer:acknowledgement,citationIds:[],draft:null}));
 const accepted=await f.post('今天午休在楼下散步了十分钟。');await f.settled(accepted.message.id);
 const response=await f.api('GET',`/api/conversations/${f.conversationId}?anchor=${accepted.message.id}&limit=1`);assert.equal(response.statusCode,200,response.body);const message=response.json().turns.find((turn:{id:string})=>turn.id===accepted.message.id);assert.equal(message.status,'completed');
 await act(async()=>root.render(React.createElement(AnswerView,{answer:message.result,onOpen:()=>assert.fail('a recording ACK has no original citation to open'),compact:true})));
 assert.equal(dom.window.document.querySelector('.answer-compact .markdown')!.textContent,acknowledgement);
 assert.equal(dom.window.document.querySelector('.citations'),null);assert.equal(dom.window.document.querySelector('.trace'),null);assert.equal(dom.window.document.querySelector('button'),null);
 assert.equal(message.result.draft,undefined);assert.equal(message.result.currentAction,undefined);assert.equal(f.requests.length,1);
});
