import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {REPORT_SIZE_MESSAGE,REPORT_SOURCE_MESSAGE,acceptedReportHeight,acceptedReportSource} from '../src/plugins/discovery/report-sizing';
import {reportDocument} from '../src/plugins/discovery/report-document';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {InsightReportFrame} from '../src/plugins/discovery/InsightReportFrame';
import lightTokens from '../../../packages/shared/design-tokens.light.json';
import darkTokens from '../../../packages/shared/design-tokens.json';

const citation={id:'11111111-1111-4111-8111-111111111111',capturedAt:'2026-10-01T00:00:00Z',appName:'Generated original',excerpt:'Generated evidence'};

test('the report remains scriptless by default; resizing allows only one host nonce before untrusted markup',()=>{
 const html='<script>window.generatedAttack=true</script><p>Generated report</p>',plain=reportDocument(html);
 assert.match(plain,/script-src 'none';/);assert.doesNotMatch(plain,/<script nonce=/);
 const token='a'.repeat(32),sized=reportDocument(html,[],'light',{token,parentOrigin:'http://127.0.0.1:54321'});
 assert.ok(sized.indexOf('Content-Security-Policy')<sized.indexOf('window.generatedAttack'));
 assert.match(sized,/script-src 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; script-src-attr 'none';/);
 assert.equal((sized.match(/<script nonce=/g)??[]).length,1,'A nonce is never added to model-supplied script elements');
 const document=new JSDOM(sized).window.document,bridge=document.querySelector('script[nonce]')!;assert.equal(bridge.textContent,'','The trusted bridge contains no inline executable text');assert.equal(bridge.getAttribute('src'),'http://127.0.0.1:54321/insight-report-bridge.js');document.defaultView!.close();
 assert.doesNotMatch(sized,/unsafe-eval|strict-dynamic|script-src 'unsafe-inline'/);assert.match(sized,/connect-src 'none'/);
 assert.throws(()=>reportDocument('',[],'light',{token:'untrusted',parentOrigin:'http://127.0.0.1:54321'}));
 assert.throws(()=>reportDocument('',[],'light',{token,parentOrigin:'javascript:alert(1)'}));
});

test('only the exact current frame and document may supply a bounded numeric height',()=>{
 const source={} as Window,other={} as Window,token='b'.repeat(32);
 const message=(height:unknown,nextSource:Window=source,nextToken=token)=>({source:nextSource,data:{type:REPORT_SIZE_MESSAGE,token:nextToken,height}} as MessageEvent);
 assert.equal(acceptedReportHeight(message(172.2),source,token),173);assert.equal(acceptedReportHeight(message(999999),source,token),16000);
 for(const height of ['200',true,null,NaN,Infinity,-1,0])assert.equal(acceptedReportHeight(message(height),source,token),undefined);
 assert.equal(acceptedReportHeight(message(200,other),source,token),undefined);assert.equal(acceptedReportHeight(message(200,source,'old-document'),source,token),undefined);
 assert.equal(acceptedReportHeight(message(200),null,token),undefined);
});

test('a source navigation message supplies only an in-range integer into the current parent citation list',()=>{
 const source={} as Window,token='b'.repeat(32),message=(index:unknown,nextSource:Window=source,nextToken=token)=>({source:nextSource,data:{type:REPORT_SOURCE_MESSAGE,token:nextToken,index,id:'ignored',url:'https://generated.invalid/ignored'}} as MessageEvent);
 assert.equal(acceptedReportSource(message(0),source,token,2),0);assert.equal(acceptedReportSource(message(1),source,token,2),1);
 for(const index of ['0',null,true,NaN,Infinity,-1,0.5,2,Number.MAX_SAFE_INTEGER+1])assert.equal(acceptedReportSource(message(index),source,token,2),undefined);
 assert.equal(acceptedReportSource(message(0,{} as Window),source,token,2),undefined);assert.equal(acceptedReportSource(message(0,source,'old'),source,token,2),undefined);assert.equal(acceptedReportSource(message(0),null,token,2),undefined);assert.equal(acceptedReportSource(message(0),source,token,0),undefined);
});

test('only verified visible citations receive unpredictable host navigation markers while the plain API stays scriptless',()=>{
 const dom=new JSDOM(),before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
 try{
  const token='c'.repeat(32),html=`<p>Generated [${citation.id}] [unknown]</p><span data-mote-report-source="${token}" data-mote-report-index="999">Model marker</span><code>[${citation.id}]</code><script>window.generatedAttack=true</script>`,plain=reportDocument(html,[citation]),sized=reportDocument(html,[citation],'light',{token,parentOrigin:'http://localhost'}),rendered=new JSDOM(sized),markers=rendered.window.document.querySelectorAll('[data-mote-report-source]');
  assert.equal(markers.length,1);assert.equal(markers[0].getAttribute('data-mote-report-source'),token);assert.equal(markers[0].getAttribute('data-mote-report-index'),'0');assert.equal(markers[0].getAttribute('role'),'button');assert.equal(markers[0].textContent,'1');assert.equal(markers[0].getAttribute('aria-label'),'来源 1');assert.match(sized,/<code>\[11111111/);assert.match(sized,/\[unknown\]/);assert.match(sized,/window.generatedAttack=true/);
  for(const [scheme,colors] of [['light',lightTokens],['dark',darkTokens]] as const){const view=new JSDOM(reportDocument(html,[citation],scheme,{token,parentOrigin:'http://localhost'})),marker=view.window.document.querySelector<HTMLElement>('[data-mote-report-source]')!,style=view.window.getComputedStyle(marker);assert.equal(marker.textContent,'1');assert.equal(style.display,'inline-flex');assert.equal(style.minWidth,'22px');assert.equal(style.minHeight,'22px');assert.equal(style.marginLeft,'5px');assert.equal(style.padding,'0px 5px');assert.equal(style.borderRadius,'4px');assert.equal(style.fontSize,'10px');assert.equal(style.verticalAlign,'2px');assert.equal(style.lineHeight,'1.5');const color=(hex:string)=>'rgb('+hex.slice(1).match(/../g)!.map(value=>parseInt(value,16)).join(', ')+')';assert.equal(style.background,color(colors.tint));assert.equal(style.color,color(colors.accent));assert.equal(style.textDecoration,'');assert.match(view.serialize(),/@media\(pointer:coarse\)[\s\S]*?min-height:32px!important;min-width:30px!important/);view.window.close();}
  assert.doesNotMatch(plain,/data-mote-report-source|data-mote-report-index|<script nonce=/);assert.match(plain,/script-src 'none'/);assert.match(plain,/Generated （来源 1）/);assert.ok(html.includes(`[${citation.id}]`));rendered.window.close();
 }finally{if(before)Object.defineProperty(globalThis,'document',before);else Reflect.deleteProperty(globalThis,'document');dom.window.close();}
});

test('a current report maps only its own citations and rejects an old owner listener even when the frame WindowProxy is reused',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[],ownerA={},ownerB={},listeners:EventListener[]=[];
 const add=dom.window.addEventListener.bind(dom.window);dom.window.addEventListener=((type:string,listener:EventListener,options?:boolean|AddEventListenerOptions)=>{if(type==='message')listeners.push(listener);add(type,listener,options);}) as typeof dom.window.addEventListener;
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const view=(owner:object,citations=[citation],onOpen=(ref:string)=>opened.push(ref))=>React.createElement(InsightReportFrame,{html:`<p>[${citation.id}]</p>`,citations,scheme:'light',title:'Generated',owner,onOpen});
 await act(async()=>root.render(view(ownerA)));const frame=dom.window.document.querySelector('iframe')!,source=frame.contentWindow!,token=()=>frame.srcdoc.match(/nonce="([a-f0-9]{32})"/)![1],firstToken=token(),oldListener=listeners.at(-1)!;
 const message=(index:unknown,nextToken=token(),nextSource:Window=source)=>new dom.window.MessageEvent('message',{source:nextSource,data:{type:REPORT_SOURCE_MESSAGE,token:nextToken,index,url:'https://generated.invalid',id:'not-a-citation'}});
 await act(async()=>dom.window.dispatchEvent(message(0)));assert.deepEqual(opened,['capture:'+citation.id]);
 await act(async()=>root.render(view(ownerA,[{...citation}])));assert.equal(token(),firstToken,'A polling copy with identical HTML and citation order does not reload');
 for(const value of ['0',-1,1,0.2,Infinity])await act(async()=>dom.window.dispatchEvent(message(value)));assert.equal(opened.length,1);
 await act(async()=>root.render(view(ownerB)));assert.notEqual(token(),firstToken);await act(async()=>{oldListener(message(0,firstToken));dom.window.dispatchEvent(message(0,firstToken));});assert.equal(opened.length,1,'Even an explicitly retained old listener cannot navigate after owner replacement');
 await act(async()=>dom.window.dispatchEvent(message(0)));assert.equal(opened.length,2);
 const other={...citation,id:'22222222-2222-4222-8222-222222222222'},secondToken=token();await act(async()=>root.render(view(ownerB,[other,citation])));assert.notEqual(token(),secondToken);await act(async()=>dom.window.dispatchEvent(message(0)));assert.equal(opened.at(-1),'capture:'+other.id);
 await act(async()=>root.render(null));await act(async()=>dom.window.dispatchEvent(message(0)));assert.equal(opened.length,3,'Unmount removes the navigation listener');
});


test('the fixed bridge reads its nonce and source origin while only current numeric markers produce navigation',()=>{
 const token='d'.repeat(32),dom=new JSDOM(`<body><span data-mote-report-source="${token}" data-mote-report-index="1">2</span><span data-mote-report-source="old" data-mote-report-index="0">old</span><a href="https://generated.invalid/">inert navigation</a></body>`,{url:'about:blank',runScripts:'outside-only'}),window=dom.window;
 const messages:{data:unknown;target:string}[]=[],script=window.document.createElement('script');script.nonce=token;script.src='http://127.0.0.1:54321/insight-report-bridge.js';
 Object.defineProperty(window.document,'currentScript',{value:script});Object.defineProperty(window,'parent',{value:{postMessage:(data:unknown,target:string)=>messages.push({data,target})}});
 Object.defineProperty(window,'ResizeObserver',{value:class{observe(){}}});window.requestAnimationFrame=()=>1;
 try{
  window.eval(readFileSync(new URL('../public/insight-report-bridge.js',import.meta.url),'utf8'));
  const current=window.document.querySelector<HTMLElement>('[data-mote-report-source="'+token+'"]')!;current.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{data:{type:REPORT_SOURCE_MESSAGE,token,index:1},target:'http://127.0.0.1:54321'}]);
  window.document.querySelector<HTMLElement>('[data-mote-report-source="old"]')!.click();
  for(const index of ['-1','1.5','NaN','9007199254740992']){current.setAttribute('data-mote-report-index',index);current.click();}
  assert.equal(messages.length,1);const link=window.document.querySelector('a')!,event=new window.MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
 }finally{window.close();}
});


test('a light-authored report keeps its text and layout while the dark display supplies readable ink and surfaces',()=>{
 const dom=new JSDOM(),before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});
 const html='<style>body{line-height:1.7;color:#18242b;padding:1.2rem}h1{color:#102030}blockquote{padding:.8rem 1rem;background:#eef4f5;border-left:4px solid #376b70}</style><h1>Generated exact title</h1><blockquote><p>Generated literal body ['+citation.id+']</p></blockquote>';
 try{
  const dark=reportDocument(html,[citation],'dark',{token:'e'.repeat(32),parentOrigin:'http://localhost'}),light=reportDocument(html,[citation],'light',{token:'f'.repeat(32),parentOrigin:'http://localhost'});
  assert.ok(dark.indexOf('body{line-height:1.7;color:#18242b;padding:1.2rem}')<dark.indexOf('html,body{color:'+darkTokens.ink+'!important'));
  assert.match(dark,new RegExp('background-color:'+darkTokens.surface+'!important'));
  assert.match(dark,/body a\{color:/);assert.match(dark,/padding:\.8rem 1rem/);assert.match(dark,/Generated literal body/);assert.ok(light.includes('color:#18242b'));
  const view=new JSDOM(dark);assert.equal(view.window.document.querySelector('h1')!.textContent,'Generated exact title');assert.equal(view.window.document.querySelector('p')!.textContent,'Generated literal body 1');assert.equal(view.window.document.querySelectorAll('script[nonce]').length,1);view.window.close();
  assert.equal(html,'<style>body{line-height:1.7;color:#18242b;padding:1.2rem}h1{color:#102030}blockquote{padding:.8rem 1rem;background:#eef4f5;border-left:4px solid #376b70}</style><h1>Generated exact title</h1><blockquote><p>Generated literal body ['+citation.id+']</p></blockquote>','Only the display wrapper changes, not the stored artifact bytes');
 }finally{if(before)Object.defineProperty(globalThis,'document',before);else Reflect.deleteProperty(globalThis,'document');dom.window.close();}
});
