import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {MaterialDetail,type Material} from '../src/Materials';
import {noteMaterialPage,noteAssetTarget,noteQuoteCaptureId,type NoteReadSpan} from '../src/note-material-render';
import {createApi,type Api} from '../src/api';
import {featuresReady} from '../src/features/bootstrap';
import {resources} from '../src/resource-cache';
import {noteMaterialFixture} from './note-material-fixture';
import {materialId} from '../../server/src/materials.js';
function span(blockId:string,start:number,end:number,format='plain'):NoteReadSpan{return{blockId,kind:'text',format,pageRange:{start,end},materialRange:{start,end},memberIds:[]};}
async function quoteTick(t:import('node:test').TestContext,ms=0){await act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});}
function quoteVisibility(d:Document){
 let hidden=false;Object.defineProperty(d,'hidden',{get:()=>hidden,configurable:true});
 return async(value:boolean)=>{hidden=value;await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));};
}
async function settle(check:()=>boolean){for(let n=0;n<80&&!check();n++)await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));assert.equal(check(),true,'actual Note Material view settled');}
async function fixture(t:import('node:test').TestContext){
 await featuresReady;const directory=await mkdtemp(join(tmpdir(),'mote-note-material-contract-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50}));const node=await noteMaterialFixture(directory),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale(),seen:string[]=[];
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true});configureLocale(()=> 'zh-CN');
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}dom.window.scrollTo=()=>{};
 let hold:((path:string,value:Response)=>Promise<Response>|undefined)|undefined;
 t.mock.method(globalThis,'fetch',async(path:string,init:RequestInit={})=>{seen.push(path);const response=await node.app.inject({method:(init.method??'GET') as 'GET'|'POST',url:path,headers:Object.fromEntries(new Headers(init.headers)),...(init.body?{payload:String(init.body)}:{})}),value=new Response(response.body,{status:response.statusCode,headers:{'content-type':String(response.headers['content-type']??'')}});return hold?.(path,value)??value;});
 const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[],api=createApi({token:node.token});
 t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();await node.app.close();assert.equal(node.modelCalls(),0);await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 const render=(material:Material,owner:Api=api)=>act(async()=>root.render(React.createElement(MaterialDetail,{key:material.ref,api:owner,material,onOpen:ref=>opened.push(ref)})));
 const click=(label:string)=>act(async()=>{const button=[...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label);assert.ok(button,label);button.click();});
 const savedOpened:string[]=[];const renderSplit=(material:Material)=>act(async()=>root.render(React.createElement(MaterialDetail,{key:material.ref,api,material,onOpen:ref=>opened.push(ref),onOpenSavedOrigin:ref=>savedOpened.push(ref)})));
 return{...node,d:dom.window.document,api,opened,savedOpened,seen,render,renderSplit,click,hold:(next:typeof hold)=>hold=next};
}
test('declared complete UTF-16 plain spans preserve literal JSON and reject malformed ranges instead of guessing metadata',()=>{
 const text='{"text":"literal"}😀\nSECRET-METADATA',length='{"text":"literal"}😀\n'.length,page=noteMaterialPage({text,spans:[span('record',0,length),span('record-metadata',length,text.length,'json'),span('record',-1,text.length),span('record',0.5,4),span('record',0,text.length+1)]});assert.deepEqual(page.records,[text.slice(0,length)]);assert.deepEqual(page.quotes,[]);assert.equal(page.records[0].includes('SECRET'),false);
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',materialId='mat_'+'a'.repeat(64),revision='b'.repeat(64),quoteSpan={...span('shared-original',0,4),evidenceOffset:0,memberIds:[id]},quotePage={text:'test',textRange:{offset:0},material:{id:materialId,revision,ref:`material:${materialId}@${revision}`,kind:'mote.note',schemaVersion:2,origin:{externalId:id}}};
 assert.equal(noteQuoteCaptureId(quotePage,quoteSpan),id);assert.equal(noteQuoteCaptureId({...quotePage,material:{...quotePage.material,revision:'c'.repeat(64)}},quoteSpan),undefined);assert.equal(noteQuoteCaptureId(quotePage,{...quoteSpan,evidenceOffset:5}),undefined);assert.equal(noteQuoteCaptureId(quotePage,{...quoteSpan,memberIds:['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']}),undefined);assert.equal(noteQuoteCaptureId({...quotePage,textRange:{offset:1}},quoteSpan),undefined);
 const asset={...span('attachment:'+id,0,0),kind:'asset' as const,locator:{fileId:id},asset:{hash:'a'.repeat(64),mimeType:'text/plain'}};assert.deepEqual(noteAssetTarget(asset),{kind:'archive',id});assert.equal(noteAssetTarget({...asset,blockId:'record-metadata'}),undefined);assert.equal(noteAssetTarget({...asset,asset:{...asset.asset,hash:'bad'}}),undefined);
});
test('real authored Note keeps original, pinned description and hash-bound attachment separate from default technical metadata',async t=>{
 const f=await fixture(t);await f.render(f.short.material);await settle(()=>Boolean(f.d.querySelector('.note-material-record pre')));assert.equal(f.d.querySelector('.note-material-record pre')!.textContent,f.literal+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-record script')),false);assert.equal(f.d.querySelector<HTMLDetailsElement>('.note-material-technical')!.open,false);assert.match(f.d.querySelector('.note-material-technical')!.textContent!,/captureId/);assert.equal(f.d.querySelector<HTMLDetailsElement>('.note-material-description')!.open,false);assert.match(f.d.querySelector('.note-material-description')!.textContent!,/Generated separate description/);assert.doesNotMatch(f.d.querySelector('.note-material-record')!.textContent!,/separate description|captureId/);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='下载原件')));assert.match(f.d.querySelector('.note-material-assets')!.textContent!,/generated-note-attachment.txt/);assert.ok(f.seen.includes('/api/archived-files/'+f.short.file!.id));assert.ok(f.d.querySelector('.material-reader-ask'));await f.click('来源与处理');await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看原始记录')));await f.click('查看原始记录');assert.equal(f.opened.at(-1),'capture:'+f.short.id);
});
test('Saved Q&A quote precedes personal addition and closes independently of description and technical data',async t=>{
 const f=await fixture(t);await f.render(f.shared.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote')));const quote=f.d.querySelector<HTMLDetailsElement>('.note-material-quote')!;assert.equal(quote.open,true);assert.equal(quote.querySelector('pre')!.textContent,f.quoted+'\n');assert.match(f.d.querySelector('.note-material-record h3')!.textContent!,/我的补充/);assert.equal(Boolean(quote.compareDocumentPosition(f.d.querySelector('.note-material-record')!)&4),true);await act(async()=>quote.querySelector('summary')!.click());assert.equal(quote.open,false);assert.equal(f.d.querySelector<HTMLDetailsElement>('.note-material-description')!.open,false);assert.equal(f.d.querySelector<HTMLDetailsElement>('.note-material-technical')!.open,false);await f.render(f.shared.material);assert.equal(f.d.querySelector<HTMLDetailsElement>('.note-material-quote')!.open,false);
});
test('metadata-only current page continues to the complete body and long originals never use a 240-character preview',async t=>{
 const f=await fixture(t);await f.render(f.paged);await settle(()=>Boolean(f.d.querySelector('.note-material-body')));assert.match(f.d.querySelector('.note-material-body')!.textContent!,/本页暂无文字正文/);assert.equal(Boolean(f.d.querySelector('.note-material-record')),false);await f.click('继续展开');await settle(()=>Boolean(f.d.querySelector('.note-material-record')));assert.equal(f.d.querySelector('.note-material-record pre')!.textContent,'Generated body on the following page.\n');assert.ok(f.seen.some(path=>path.includes('revision='+f.paged.revision)&&path.includes('offset=4000')));
 await f.render(f.long.material);await settle(()=>Boolean(f.d.querySelector('.note-material-record pre')?.textContent?.startsWith('Generated long original')));assert.ok(f.d.querySelector('.note-material-record pre')!.textContent!.length>3900);assert.equal(f.d.querySelector('.note-material-record pre')!.textContent!.includes('END OF GENERATED'),false);await f.click('继续展开');await settle(()=>Boolean(f.seen.find(path=>path.includes(f.long.material.id)&&/offset=3999|offset=4000/.test(path))));assert.ok(f.d.querySelector('.note-material-record pre')!.textContent!.length>3000);assert.equal(f.seen.some(path=>path.includes('length=240')),false);
});
test('historical body and description never retarget to current data, and owner changes fence late plaintext',async t=>{
 const f=await fixture(t),old=f.short.material;const next=f.materials.publish({id:old.id,kind:old.kind,schemaVersion:old.schemaVersion,title:'Generated new title',origin:old.origin,members:[{id:f.short.id,kind:'capture',ref:'capture:'+f.short.id}],blocks:[{id:'record',kind:'text',format:'plain',text:'NEW HEAD MUST NOT REPLACE OLD BODY',memberIds:[f.short.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:old.revision});
 await f.render(old);await settle(()=>Boolean(f.d.querySelector('.note-material-record')));assert.equal(f.d.querySelector('.note-material-record pre')!.textContent,f.literal+'\n');assert.match(f.d.body.textContent!,/这是历史版本/);assert.doesNotMatch(f.d.querySelector('.note-material-body')!.textContent!,/NEW HEAD/);assert.equal(Boolean(f.d.querySelector('.material-reader-ask')),false);await f.click('查看当前版本');assert.equal(f.opened.at(-1),next.ref);
 let release!:()=>void,started=false;f.hold((path,response)=>{if(path.includes('/read?')){started=true;return new Promise(done=>release=()=>done(response));}});await act(async()=>resources(f.api).invalidate(path=>path.includes('/read?')));await settle(()=>started);await f.render(old,createApi({token:'generated-denied-owner'}));await settle(()=>!f.d.querySelector('.note-material-record'));await act(async()=>release());assert.equal(Boolean(f.d.querySelector('.note-material-record')),false);assert.doesNotMatch(f.d.body.textContent!,/literal owner prose/);
});

test('exact saved conversation in a Note Material renders a readable answer, verifies the cited original, and retains saved bytes',async t=>{
 const f=await fixture(t);await f.render(f.exact.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote .quoted-answer-markdown h2')));
 const quote=f.d.querySelector('.note-material-quote')!;assert.equal(quote.querySelector('h2')!.textContent,'Generated heading');assert.match(quote.textContent!,/Generated saved question\?.*Generated answer/s);assert.doesNotMatch(quote.textContent!,/##|\*\*|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);assert.equal(f.d.querySelector('.note-material-record pre')!.textContent,'Generated exact Android addition.\n');assert.match(f.d.querySelector('.note-material-description')!.textContent!,/Generated exact separate description/);
 const stored=(await f.app.inject({url:'/api/capture-browser/'+f.exact.id,headers:f.headers})).json();assert.equal(stored.metadata.noteOrigin.text,f.exactSnapshot);assert.equal(stored.metadata.noteOrigin.messageIds[0],f.exactTurn.turnId);
 await act(async()=>quote.querySelector<HTMLButtonElement>('nav button')!.click());assert.deepEqual(f.opened,['capture:'+f.short.id]);assert.ok(f.seen.some(path=>path.includes('/references/'+f.short.id)),'the same conversation reference gate is required');
 f.hold((path)=>path.includes('/references/'+f.short.id)?Promise.resolve(new Response(JSON.stringify({id:f.short.id,available:false}),{status:200,headers:{'content-type':'application/json'}})):undefined);await act(async()=>quote.querySelector<HTMLButtonElement>('nav button')!.click());assert.deepEqual(f.opened,['capture:'+f.short.id]);assert.match(quote.textContent!,/引用不可用/);
});

test('a 100000-character saved quote stays paged until explicit bounded verification, then formats the exact full turn',async t=>{
 const f=await fixture(t);assert.equal(f.longSnapshot.length,100000);await f.render(f.longQuote.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote pre')&&[...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));
 const first=f.d.querySelector('.note-material-quote pre')!.textContent!;assert.ok(first.length<4001);assert.match(first,/## Generated long answer/);assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);assert.equal(f.seen.some(path=>path.includes(f.longQuote.material.id)&&path.includes('length=12000')),false,'initial page never expands automatically');
 await f.click('查看全部内容');await settle(()=>Boolean(f.d.querySelector('.note-material-quote .quoted-answer-markdown h2')));const quote=f.d.querySelector('.note-material-quote')!;assert.equal(quote.querySelector('h2')!.textContent,'Generated long answer');assert.match(quote.querySelector('code')!.textContent!,/\*\*Literal code\*\*/);assert.ok(quote.querySelector('code')!.textContent!.includes(f.short.id),'citation-like literal inside code is not guessed');assert.equal(quote.querySelectorAll('.quoted-citation').length,1);const reads=f.seen.filter(path=>path.includes(f.longQuote.material.id)&&path.includes('/read?')&&path.includes('length=12000'));assert.ok(reads.length>=8,'long quote was verified through bounded pinned pages');assert.ok(reads.every(path=>path.includes('revision='+f.longQuote.material.revision)));const offsets=reads.map(path=>Number(new URL(path,'http://generated.local').searchParams.get('offset')));assert.equal(offsets[1]-offsets[0],11999,'continuation follows the host boundary before a split Unicode pair');assert.equal((await f.app.inject({url:'/api/capture-browser/'+f.longQuote.id,headers:f.headers})).json().metadata.noteOrigin.text,f.longSnapshot);
 await f.click('收起');assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,first,'collapse returns to the exact original page slice');await f.click('继续展开');await settle(()=>Boolean(f.seen.find(path=>path.includes(f.longQuote.material.id)&&path.includes('offset=4000'))));const second=f.d.querySelector('.note-material-quote pre')!.textContent!;assert.ok(second.length<=4000);assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);assert.equal(first+second,f.longSnapshot.slice(0,first.length+second.length));
});

test('a mismatched quote or a different declared member stays a literal pinned snapshot and never invents a citation',async t=>{
 const f=await fixture(t),base=f.exact.material,make=(suffix:string,quote:string,memberId:string)=>f.materials.publish({id:materialId('generated-'+suffix,base.origin.externalId!),kind:'mote.note',schemaVersion:2,title:'Generated mismatched quote',origin:{...base.origin,sourceId:'generated-'+suffix},members:[{id:memberId,kind:'capture',ref:'capture:'+memberId}],blocks:[{id:'shared-original',kind:'text',format:'plain',text:quote,memberIds:[memberId]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 const changed='Generated saved question?\n\n## Other answer ['+f.short.id+']',mismatched=make('generated-changed-snapshot',changed,f.exact.id);await f.render(mismatched);await settle(()=>Boolean(f.d.querySelector('.note-material-quote pre')));assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,changed+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);assert.deepEqual(f.opened,[]);
 const wrongMember=make('generated-wrong-member',f.exactSnapshot,f.short.id);const start=f.seen.length;await f.render(wrongMember);await settle(()=>Boolean(f.d.querySelector('.note-material-quote pre')));assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,f.exactSnapshot+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);assert.equal(f.seen.slice(start).includes('/api/capture-browser/'+f.exact.id),false,'a non-member capture is never looked up from metadata');
});

test('denied saved record or source turn keeps the pinned quote literal with a truthful unavailable state',async t=>{
 const f=await fixture(t);f.hold(path=>path==='/api/capture-browser/'+f.exact.id?Promise.resolve(new Response('{"error":"forbidden"}',{status:403,headers:{'content-type':'application/json'}})):undefined);await f.render(f.exact.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote [role=status]')));assert.match(f.d.querySelector('.note-material-quote [role=status]')!.textContent!,/原文暂不可用/);assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,f.exactSnapshot+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);
 await f.render(f.short.material);f.hold(path=>path==='/api/conversations/'+f.exactTurn.conversationId?Promise.resolve(new Response('{"error":"forbidden"}',{status:403,headers:{'content-type':'application/json'}})):undefined);await f.render(f.exact.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote [role=status]')?.textContent?.includes('原始对话或轮次暂不可读')));assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,f.exactSnapshot+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);assert.deepEqual(f.opened,[]);
});

test('a late saved-record read cannot cross an owner switch even if transport ignores abort',async t=>{
 const f=await fixture(t);let release!:()=>void,started=false;f.hold((path,response)=>{if(path==='/api/capture-browser/'+f.exact.id){started=true;return new Promise(done=>release=()=>done(response));}});await f.render(f.exact.material);await settle(()=>started);await f.render(f.exact.material,createApi({token:'generated-denied-owner'}));await settle(()=>!f.d.querySelector('.note-material-body'));await act(async()=>release());assert.equal(Boolean(f.d.querySelector('.note-material-body')),false);assert.doesNotMatch(f.d.body.textContent!,/Generated answer/);assert.deepEqual(f.opened,[]);
});

test('only a verified conversation citation uses the saved-origin navigation callback; attachments keep the ordinary callback',async t=>{
 const f=await fixture(t),base=f.exact.material,file=f.short.file!;
 const material=f.materials.publish({id:materialId('generated-attachment-and-quote',base.origin.externalId!),kind:'mote.note',schemaVersion:2,title:'Generated quote and attachment',origin:{...base.origin,sourceId:'generated-attachment-and-quote'},members:[{id:f.exact.id,kind:'capture',ref:'capture:'+f.exact.id},{id:f.short.id,kind:'capture',ref:'capture:'+f.short.id}],blocks:[{id:'shared-original',kind:'text',format:'plain',text:f.exactSnapshot,memberIds:[f.exact.id]},{id:'record-attachment:'+f.short.id,kind:'asset',hash:file.hash,mimeType:file.mimeType,memberIds:[f.short.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 await f.renderSplit(material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote nav button')&&f.d.querySelector('.note-material-assets button')));await act(async()=>f.d.querySelector<HTMLButtonElement>('.note-material-quote nav button')!.click());assert.deepEqual(f.savedOpened,['capture:'+f.short.id]);assert.deepEqual(f.opened,[]);await act(async()=>f.d.querySelector<HTMLButtonElement>('.note-material-assets button')!.click());assert.deepEqual(f.opened,['capture:'+f.short.id]);assert.deepEqual(f.savedOpened,['capture:'+f.short.id]);
});

test('privacy erasure of the exact turn never reconstructs it from an independently saved Note Material',async t=>{
 const f=await fixture(t);await f.render(f.exact.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote nav button')));f.store.invalidateConversationAnswers([f.short.id],true);
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.note-material-quote nav button')!.click());assert.deepEqual(f.opened,[]);assert.match(f.d.querySelector('.note-material-quote')!.textContent!,/引用不可用/);
 await f.render(f.short.material);await f.render(f.exact.material);await settle(()=>Boolean(f.d.querySelector('.note-material-quote [role=status]')?.textContent?.includes('原始对话或轮次暂不可读')));assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,f.exactSnapshot+'\n');assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);const saved=(await f.app.inject({url:'/api/capture-browser/'+f.exact.id,headers:f.headers})).json();assert.equal(saved.metadata.noteOrigin.text,f.exactSnapshot);
});

test('cancelling a held quote expansion or changing page fences its late response and retains the page',async t=>{
 const f=await fixture(t);let release!:()=>void,started=false;const hold=()=>f.hold((path,response)=>{if(path.includes(f.longQuote.material.id)&&path.includes('length=12000')){started=true;return new Promise(done=>release=()=>done(response));}});
 hold();await f.render(f.longQuote.material);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));const first=f.d.querySelector('.note-material-quote pre')!.textContent!;await f.click('查看全部内容');await settle(()=>started);await f.click('取消');await act(async()=>release());assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,first);assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);
 started=false;hold();await f.click('查看全部内容');await settle(()=>started);await f.click('继续展开');await settle(()=>Boolean(f.seen.find(path=>path.includes(f.longQuote.material.id)&&path.includes('offset=4000'))));const second=f.d.querySelector('.note-material-quote pre')!.textContent!;await act(async()=>release());assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,second);assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);
});

test('a changed pinned chunk or an erased turn never upgrades a paged snapshot to a fabricated full answer',async t=>{
 const f=await fixture(t);let changed=false;f.hold((path,response)=>{if(!changed&&path.includes(f.longQuote.material.id)&&path.includes('length=12000')){changed=true;return response.text().then(body=>{const value=JSON.parse(body);value.text='Z'+value.text.slice(1);return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});});}});
 await f.render(f.longQuote.material);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));const original=f.d.querySelector('.note-material-quote pre')!.textContent;await f.click('查看全部内容');await settle(()=>Boolean(f.d.querySelector('.note-material-quote [role=status]')?.textContent?.includes('原文暂不可用')));assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,original);assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);
 f.hold(undefined);await f.render(f.short.material);await f.render(f.longQuote.material);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));f.store.invalidateConversationAnswers([f.short.id],true);await f.click('查看全部内容');await settle(()=>Boolean(f.d.querySelector('.note-material-quote [role=status]')?.textContent?.includes('原始对话或轮次暂不可读')));assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);assert.equal(Boolean(f.d.querySelector('.note-material-quote nav')),false);
});

test('an owner switch while expansion is held cannot publish the old full snapshot',async t=>{
 const f=await fixture(t);let release!:()=>void,started=false;f.hold((path,response)=>{if(path.includes(f.longQuote.material.id)&&path.includes('length=12000')){started=true;return new Promise(done=>release=()=>done(response));}});await f.render(f.longQuote.material);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));await f.click('查看全部内容');await settle(()=>started);await f.render(f.longQuote.material,createApi({token:'generated-denied-owner'}));await settle(()=>!f.d.querySelector('.note-material-body'));await act(async()=>release());assert.equal(Boolean(f.d.querySelector('.note-material-body')),false);assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);
});

test('switching to a new Material revision during a held expansion cannot reveal the old quote',async t=>{
 const f=await fixture(t),old=f.longQuote.material;let release!:()=>void,started=false;f.hold((path,response)=>{if(path.includes(old.id)&&path.includes('length=12000')){started=true;return new Promise(done=>release=()=>done(response));}});await f.render(old);await settle(()=>Boolean([...f.d.querySelectorAll('button')].find(button=>button.textContent==='查看全部内容')));await f.click('查看全部内容');await settle(()=>started);
 const next=f.materials.publish({id:old.id,kind:old.kind,schemaVersion:old.schemaVersion,title:'Generated new pinned revision',origin:old.origin,members:[{id:f.longQuote.id,kind:'capture',ref:'capture:'+f.longQuote.id}],blocks:[{id:'record',kind:'text',format:'plain',text:'Generated new revision only',memberIds:[f.longQuote.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:old.revision});await f.render(next);await settle(()=>Boolean(f.d.querySelector('.note-material-record pre')?.textContent?.includes('Generated new revision only')));await act(async()=>release());assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);assert.doesNotMatch(f.d.body.textContent!,/Generated long answer/);assert.match(f.d.querySelector('.note-material-record')!.textContent!,/Generated new revision only/);
});

test('a mounted saved quote stops timer reads for 60s hidden and coalesces its foreground refresh',async t=>{
 const f=await fixture(t),visible=quoteVisibility(f.d),path='/api/capture-browser/'+f.exact.id;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await f.render(f.exact.material);await quoteTick(t);assert.ok(f.d.querySelector('.note-material-quote nav'));
  const count=()=>f.seen.filter(value=>value===path).length;assert.equal(count(),1);
  await visible(true);await quoteTick(t,60000);assert.equal(count(),1,'hidden timers must not read the saved quote');
  await visible(false);await visible(false);await quoteTick(t);assert.equal(count(),2,'one foreground transition reads the exact quote once');
  await quoteTick(t,4999);assert.equal(count(),2);await quoteTick(t,1);assert.equal(count(),3,'visible 5s safety revalidation remains');
  assert.equal(f.d.querySelector('.note-material-quote pre')!.textContent,'Generated saved question?');
  assert.ok(f.seen.some(value=>value.includes('/read?revision='+f.exact.material.revision)),'the Material revision stays pinned');
 }finally{t.mock.timers.reset();}
});

test('foreground quote revalidation lets a held read finish then performs one fresh follow-up',async t=>{
 const f=await fixture(t),visible=quoteVisibility(f.d),path='/api/capture-browser/'+f.exact.id;let release!:()=>void;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await f.render(f.exact.material);await quoteTick(t);assert.ok(f.d.querySelector('.note-material-quote nav'));
  f.hold((value,response)=>value===path?new Promise(done=>{release=()=>done(response);}):undefined);
  await quoteTick(t,5000);const count=()=>f.seen.filter(value=>value===path).length;assert.equal(count(),2);
  await visible(true);await quoteTick(t,60000);await visible(false);await visible(false);assert.equal(count(),2,'do not replace the held read');
  f.hold(undefined);await act(async()=>release());await quoteTick(t);assert.equal(count(),3,'coalesce visibility hints into one fresh read after completion');
  assert.ok(f.d.querySelector('.note-material-quote nav'));
  await quoteTick(t,5000);assert.equal(count(),4);
 }finally{t.mock.timers.reset();}
});

test('an old Api cannot publish its held quote or run a queued foreground refresh after owner switch',async t=>{
 const f=await fixture(t),visible=quoteVisibility(f.d),path='/api/capture-browser/'+f.exact.id;let release!:()=>void;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await f.render(f.exact.material);await quoteTick(t);
  f.hold((value,response)=>value===path?new Promise(done=>{release=()=>done(response);}):undefined);
  await quoteTick(t,5000);assert.equal(typeof release,'function');await visible(true);await visible(false);
  f.hold(undefined);await f.render(f.exact.material,createApi({token:'generated-denied-owner'}));await quoteTick(t);
  await act(async()=>release());await quoteTick(t,60000);
  assert.equal(f.seen.filter(value=>value===path).length,2,'the detached owner must not run its queued follow-up');
  assert.equal(Boolean(f.d.querySelector('.note-material-body')),false);assert.doesNotMatch(f.d.body.textContent!,/Generated answer/);assert.deepEqual(f.opened,[]);
 }finally{t.mock.timers.reset();}
});

for(const status of [401,403,404,409])test('foreground quote HTTP '+status+' preserves the literal snapshot and removes source navigation',async t=>{
 const f=await fixture(t),visible=quoteVisibility(f.d),path='/api/capture-browser/'+f.exact.id;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await f.render(f.exact.material);await quoteTick(t);assert.ok(f.d.querySelector('.note-material-quote nav'));
  await visible(true);f.hold(value=>value===path?Promise.resolve(new Response('{"error":"generated-unavailable"}',{status,headers:{'content-type':'application/json'}})):undefined);
  await visible(false);await quoteTick(t);
  const quote=f.d.querySelector('.note-material-quote')!;
  assert.match(quote.textContent!,/原文暂不可用/);assert.equal(quote.querySelector('nav'),null);
  assert.equal(quote.querySelector('pre')!.textContent,f.exactSnapshot+'\n');assert.deepEqual(f.opened,[]);
 }finally{t.mock.timers.reset();}
});
