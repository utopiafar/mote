import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Store} from '../../server/src/store.js';
import {SourceStore} from '../../server/src/sources.js';
import {ArchivedFileStore} from '../../server/src/archived-files.js';
import {Vault} from '../src/Vault.js';
import type {Api,Status} from '../src/api.js';
configureLocale(()=> 'zh-CN');

async function fixture(t:any){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document};
}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===text)!;
const status=(store:Store)=>({storage:store.stats(),agent:{configured:false,provider:'fixture',model:null},index:{mode:'text',model:null},retentionDays:0,insightIntervalHours:0,serverTime:'2026-10-05T00:00:00Z'}) as unknown as Status;
async function select(d:Document,file:File){const input=d.querySelector<HTMLInputElement>('[aria-label="导入 Mote 归档"]')!;Object.defineProperty(input,'files',{value:[file],configurable:true});await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));}

test('the actual Vault component imports its current v2 JSON download with original bytes, links and idempotency intact',async t=>{
 const {root,d}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'mote-vault-ui-')),origin=new Store(join(directory,'origin')),restored=new Store(join(directory,'restored'));
 t.after(()=>{origin.close();restored.close();rmSync(directory,{recursive:true,force:true});});
 const originals=new ArchivedFileStore(origin),sources=new SourceStore(origin),bytes=Buffer.from('Generated fixture original bytes'),file=originals.put({name:'generated-original.txt',mimeType:'text/plain',bytes});
 sources.register({id:'generated-upload',name:'Generated portable source',kind:'upload',deviceId:'fixture',platform:'import',retention:'archive'});
 const capture=await sources.upsert('generated-upload',{externalId:'1',revision:'1',observedAt:'2026-10-05T00:00:00Z',kind:'file',layer:'original',text:'Generated portable text',document:{fileId:file.id,contentRole:'authored'}});originals.attach(capture.id,[file.id]);
 const downloads:Blob[]=[],imports:unknown[]=[];let changed=0,downloadName='';
 const objectURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,click=domAnchorClick(d);
 URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:generated-vault';};URL.revokeObjectURL=()=>{};
 d.defaultView!.HTMLAnchorElement.prototype.click=function(){downloadName=this.download;};
 t.after(()=>{URL.createObjectURL=objectURL;URL.revokeObjectURL=revokeURL;d.defaultView!.HTMLAnchorElement.prototype.click=click;});
 const api={raw:async(path:string)=>{assert.equal(path,'/api/export');return new Response(JSON.stringify(origin.exportArchive(1_000_000)),{headers:{'content-type':'application/json'}});},request:async(path:string,init?:RequestInit)=>{assert.equal(path,'/api/import');assert.equal(init?.method,'POST');const raw=JSON.parse(String(init.body));imports.push(raw);return restored.importArchive(raw);},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Vault,{api,status:status(origin),refresh:()=>changed++,disconnect:()=>{}})));
 await act(async()=>button(d,'导出').click());assert.match(downloadName,/^mote-\d{4}-\d{2}-\d{2}\.json$/);assert.equal(downloads.length,1);
 const raw=await downloads[0].text(),archive=JSON.parse(raw);assert.equal(archive.version,2);
 await select(d,new File([raw],'generated-export.json',{type:'application/json'}));assert.equal(imports.length,1);assert.deepEqual(imports[0],archive);
 assert.match(d.body.textContent!,/已导入 1 条记录，跳过 0 条重复记录/);assert.equal(restored.evidence([capture.id])[0].ocrText,'Generated portable text');
 const restoredFiles=new ArchivedFileStore(restored);assert.deepEqual(restoredFiles.read(file.id),bytes);assert.deepEqual(restoredFiles.listForCapture(capture.id).map(item=>item.id),[file.id]);
 await select(d,new File([raw],'generated-export.json',{type:'application/json'}));assert.match(d.body.textContent!,/已导入 0 条记录，跳过 1 条重复记录/);assert.equal(restored.stats().captures,1);assert.equal(changed,3);
});
function domAnchorClick(d:Document){return d.defaultView!.HTMLAnchorElement.prototype.click;}

test('Vault rejects legacy versions and incomplete v2 files before posting a partial archive',async t=>{
 const {root,d}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'mote-vault-ui-invalid-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});let posts=0;
 const api={request:async()=>{posts++;return {imported:0,duplicates:0};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Vault,{api,status:status(store),refresh:()=>{},disconnect:()=>{}})));
 for(const archive of [{version:1,captures:[]},{version:2,captures:[]},null]){
  await select(d,new File([JSON.stringify(archive)],'generated-invalid.json',{type:'application/json'}));assert.match(d.body.textContent!,/请选择 Mote v2 JSON 归档文件/);assert.equal(posts,0);
 }
 assert.match(d.body.textContent!,/合并 Mote v2 JSON 归档/);assert.doesNotMatch(d.body.textContent!,/v1 JSON/);
});
