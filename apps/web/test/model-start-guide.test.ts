import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ModelStartGuide} from '../src/plugins/models-processing/ModelStartGuide.js';
import {webFeatures} from '../src/features/registry.js';

async function fixture(t:any){
 const dom=new JSDOM('<html></html>',{url:'http://localhost/#/system/models?category=providers'}),previous=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true,writable:true});
 configureLocale(()=> 'zh-CN');
 const featureId='generated.model-start.'+Math.random();
 const fiber=await webFeatures.install({id:featureId,version:'1',components:[]},[
  ...[{id:'ask',route:'ask'},{id:'activity',route:'activity'},{id:'archive',route:'library'},{id:'settings',route:'system/models'}].map(entry=>({surface:'page' as const,entry:{...entry,featureId,render:()=>null}})),
  {surface:'collection',entry:{id:'materials',featureId,label:'Generated materials',order:1,render:()=>null}},
 ]);
 t.after(async()=>{await fiber.dispose();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');dom.window.close();});
 return {window:dom.window,render:()=>new JSDOM(renderToStaticMarkup(React.createElement(ModelStartGuide))).window.document};
}

test('direct model settings keep setup steps without inventing a task return destination',async t=>{
 const {render}=await fixture(t),d=render();
 assert.equal(d.querySelector('a[href="#/ask"]'),null);
 assert.equal(d.querySelectorAll('a').length,2);
 assert.ok([...d.querySelectorAll('a')].every(link=>!new URLSearchParams(link.getAttribute('href')!.split('?')[1]).has('returnTo')));
 assert.match(d.body.textContent!,/已有可用默认时可直接使用/);
 assert.match(d.body.textContent!,/无需创建新预设或修改所有模块/);
 const help=d.querySelector<HTMLDetailsElement>('details')!;
 assert.equal(help.open,false);assert.match(help.querySelector('summary')!.textContent!,/模型设置说明/);
 assert.equal(d.querySelectorAll('nav a').length,2,'Setup steps remain immediately reachable outside the folded help');
});

test('a valid task return target survives both model setup steps with its exact context',async t=>{
 const {window,render}=await fixture(t),target='#/activity?work=generated-task';
 window.location.hash='#/system/models?category=providers&returnTo='+encodeURIComponent(target);
 const d=render(),links=[...d.querySelectorAll<HTMLAnchorElement>('a')];
 assert.equal(links.length,3);
 assert.equal(links[2].getAttribute('href'),target);
 for(const link of links.slice(0,2))assert.equal(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('returnTo'),target);
});

for(const candidate of ['', 'https://example.invalid/task', '#/removed', '#/library?view=removed', '#/activity?tab=memory'])test('invalid supplied return target stays explicit rather than falling back: '+JSON.stringify(candidate),async t=>{
 const {window,render}=await fixture(t);
 window.location.hash='#/system/models?category=providers&returnTo='+encodeURIComponent(candidate);
 const d=render();
 assert.equal(d.querySelector('a[href="#/ask"]'),null);
 assert.match(d.querySelector('[role=status]')?.textContent??'',/原任务入口当前不可用/);
});
