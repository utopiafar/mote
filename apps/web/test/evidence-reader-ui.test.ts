import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {EvidenceDialog} from '../src/shell-components.js';
import {ReferenceDetail} from '../src/plugins/reader/index.js';
import {ApiError,dateTime,type Api,type Capture} from '../src/api.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generated:Capture={deletion:{available:true,kind:'capture'},id,source:'note',platform:'import',capturedAt:'2026-10-13T00:00:00Z',appName:'Generated note app',windowTitle:'Generated first line',deviceId:'generated-device',deviceName:'Generated device',ocrText:'Generated first line\n  Literal screen / media / file words <script>untrusted()</script>\n',durationMs:0,blobHash:null,indexingStatus:'pending',privacy:{redacted:false,mode:'standard'}};
async function fixture(t:any,capture:Capture,readMedia?:(path:string,signal?:AbortSignal)=>Promise<unknown>,conversations?:(path:string)=>unknown){
 const dom=new JSDOM('<!doctype html><main><button id="origin">Open generated original</button></main><div id="root"></div>',{url:'http://localhost/#/library?source=note',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 const root=createRoot(dom.window.document.querySelector('#root')!),writes:string[]=[],opened:string[]=[],imageReads:string[]=[],origin=dom.window.document.querySelector<HTMLButtonElement>('#origin')!;
 const api={request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(path==='/api/capture-browser/'+capture.id)return capture;if(path.startsWith('/api/conversations?'))return conversations?.(path)??{items:[],nextCursor:null};if(path.startsWith('/api/materials/')&&readMedia)return readMedia(path,init?.signal??undefined);if(init?.method==='DELETE'){writes.push(path);return {deleted:1};}throw Error('Unexpected generated path '+path);},
  raw:async(path:string)=>{imageReads.push(path);return new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}));},setAgentTimeout:()=>{}} as unknown as Api;
 origin.focus();await act(async()=>root.render(React.createElement(EvidenceDialog,{api,id:'capture:'+capture.id,onOpen:ref=>opened.push(ref),onClose:()=>root.render(null),onDeleted:()=>{}})));
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 return {document:dom.window.document,origin,writes,opened,root,api,imageReads};
}
const settle=()=>act(async()=>{for(let turn=0;turn<6;turn++)await new Promise(resolve=>setTimeout(resolve,0));});
const factRow=(d:Document,label:string)=>Array.from(d.querySelectorAll('.evidence-aside .evidence-facts>div')).find(row=>row.querySelector('dt')?.textContent===label);
test('note reader leads with the exact original, keeps real source facts and returns focus after Close',async t=>{
 const before=structuredClone(generated),{document:d,origin,writes}=await fixture(t,generated),body=d.querySelector('.evidence-text pre')!;
 assert.equal(d.querySelector('.evidence-back')!.getAttribute('aria-label'),'关闭证据详情');
 await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());const help=d.querySelector<HTMLDetailsElement>('.evidence-processing-help')!;
 assert.equal(d.querySelector('.evidence-heading h2')!.textContent,generated.windowTitle);assert.equal(d.querySelector('.evidence-body-heading')!.textContent,'用户原文');
 assert.equal(body.textContent,generated.ocrText);assert.equal(body.querySelector('script'),null,'untrusted original remains literal');
 assert.match(d.querySelector('.evidence-aside .evidence-facts')!.textContent!,/Generated note app/);assert.match(d.querySelector('.evidence-aside .evidence-facts')!.textContent!,/Generated device/);assert.equal(d.querySelector('.evidence-caption time')!.textContent,dateTime(generated.capturedAt));assert.equal(d.querySelector('time')!.getAttribute('datetime'),generated.capturedAt);
 assert.equal(d.querySelector<HTMLDetailsElement>('.reader-source-details')!.open,false,'original text leads while source facts remain available on demand');
 const facts=Array.from(d.querySelectorAll('.reader-source-details>dl>div'));
 assert.ok(facts.some(row=>row.querySelector('dt')!.textContent==='窗口标题'&&row.querySelector('dd')!.textContent===generated.windowTitle));
 assert.ok(facts.some(row=>row.textContent==='索引状态等待索引'));assert.ok(facts.some(row=>row.textContent==='隐私处理未标记脱敏'));
 // Source facts and processing explanation remain available on demand.
 assert.equal(d.querySelector('[data-archive-state]')!.textContent,'资料已归档');assert.equal(d.querySelector('[data-processing-state]')!.getAttribute('data-processing-state'),'unknown');assert.equal(help.open,false);assert.equal(help.querySelector('summary')!.textContent,'归档与处理说明');
 assert.ok(body.compareDocumentPosition(help)&d.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING);const menu=d.querySelector('.reader-menu')!;assert.equal(d.querySelector('.reader-more-button')!.getAttribute('aria-controls'),menu.id,'source actions open from the ⋯ control');assert.ok(menu.contains(d.querySelector('.evidence-source-actions')));
 help.open=true;assert.match(help.textContent!,/OCR、索引和记忆分别处理/);
 const route=d.querySelector('.evidence-source-actions a')!.getAttribute('href')!;assert.equal(new URLSearchParams(route.split('?')[1]).get('memorySource'),'capture:'+id);
 await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());assert.equal(d.querySelector('.reader-menu'),null);await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="关闭证据详情"]')!.click());assert.equal(d.querySelector('[role=dialog]'),null);assert.equal(d.activeElement,origin);assert.equal(d.querySelector('main')!.hasAttribute('inert'),false);assert.deepEqual(writes,[]);assert.deepEqual(generated,before);
});
test('screen reader keeps authored title, failed OCR/index/privacy facts and the actual delete confirmation',async t=>{
 const capture:Capture={...generated,source:'screen',platform:'macos',windowTitle:'Generated authored window',ocrText:'Exact generated OCR\n  final line ',indexingStatus:'failed',ocr:{status:'failed',updatedAt:'2026-10-13T00:01:00Z'},privacy:{redacted:true,mode:'standard'}},before=structuredClone(capture),{document:d,writes}=await fixture(t,capture);
 assert.equal(d.querySelector('.evidence-heading h2')!.textContent,capture.windowTitle);assert.equal(d.querySelector('.evidence-body-heading')!.textContent,'OCR 全文');assert.equal(d.querySelector('.evidence-text pre')!.textContent,capture.ocrText);
 assert.match(d.querySelector('.evidence-caption')!.textContent!,/屏幕采样/);assert.match(d.querySelector('.evidence-ocr-status')!.textContent!,/OCR 失败/);assert.match(d.querySelector('.reader-source-details>dl')!.textContent!,/索引失败/);assert.match(d.querySelector('.reader-source-details>dl')!.textContent!,/客户端报告已脱敏/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());await act(async()=>d.querySelector<HTMLButtonElement>('.danger-text')!.click());assert.match(d.querySelector('.evidence-footer')!.textContent!,/此操作无法撤销/);assert.deepEqual(writes,[]);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('.evidence-footer button')).find(button=>button.textContent==='取消')!.click());assert.deepEqual(writes,[]);assert.equal(d.querySelector('.evidence-text pre')!.textContent,capture.ocrText);
 await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());await act(async()=>d.querySelector<HTMLButtonElement>('.danger-text')!.click());await act(async()=>d.querySelector<HTMLButtonElement>('.evidence-footer .danger')!.click());assert.deepEqual(writes,['/api/captures/'+id]);assert.equal(d.querySelector('[role=dialog]'),null);assert.deepEqual(capture,before);
});

test('a declared exact media citation renders readable body and keeps canonical bytes only in collapsed technical details',async t=>{
 const ref='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),base={...generated,source:'file' as const,libraryVersion:ref+'#chunk:d78f66ea-b068-4747-a305-53c21c9b9cbf',provenance:{sourceId:'generated-source',externalId:'generated',revision:'b'.repeat(64),layer:'derived' as const,deleted:false,uri:ref+'#chunk:d78f66ea-b068-4747-a305-53c21c9b9cbf'}};const value={...base,id,ocrText:'{"speaker":"SPEAKER_0"}\n  Exact quoted speech <script>literal</script>\n',revisionState:'historical' as const},pin=value.libraryVersion!,m=/^(material:(mat_[a-f0-9]{64})@([a-f0-9]{64}))#(.+)$/.exec(pin)!;
 const text=value.ocrText+'\n',calls:string[]=[],page={material:{id:m[2],ref:m[1],revision:m[3],kind:'mote.file',schemaVersion:2,textLength:text.length,blockCount:1},text,textRange:{offset:0,total:text.length,nextOffset:null},spans:[{blockId:m[4],kind:'text',format:'speech-text',evidenceId:id,evidenceOffset:0,pageRange:{start:0,end:text.length},materialRange:{start:0,end:text.length},locator:{chunkId:m[4].slice(6),textStart:0,textEnd:value.ocrText.length}}]};
 const {document:d,writes}=await fixture(t,value,async path=>{calls.push(path);return page;});assert.equal(d.querySelector('.evidence-text>pre')!.textContent,'  Exact quoted speech <script>literal</script>\n');assert.equal(d.querySelector('.evidence-text>pre script'),null);assert.equal(d.querySelector('.evidence-main .evidence-canonical')===null,true,'canonical bytes never join the reading column');assert.equal(d.querySelector('.evidence-speaker')!.textContent,'SPEAKER_0');assert.match(d.body.textContent!,/历史证据/);assert.equal(calls.length,1);assert.ok(calls[0].includes('revision='+m[3]));assert.equal(d.querySelector('.file-detail'),null,'never redirect an exact historical citation to a current file');
 const details=d.querySelector<HTMLDetailsElement>('.reader-source-details')!,technical=details.querySelector<HTMLDetailsElement>('.evidence-canonical')!;assert.equal(details.open,false);assert.equal(technical.open,false);assert.equal(technical.querySelector('pre')!.textContent,value.ocrText);assert.deepEqual(writes,[]);
});
test('file-looking plain JSON remains literal without inventing a media declaration',async t=>{
 const value={...generated,source:'file' as const,ocrText:'{"speaker":"SPEAKER_0"}\nOwner-authored JSON must stay literal'};const {document:d}=await fixture(t,value);assert.equal(d.querySelector('.evidence-text>pre')!.textContent,value.ocrText);
});

test('an exact media declaration denied by owner HTTP stays literal and does not try a current file',async t=>{
 const ref='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),pin=ref+'#chunk:d78f66ea-b068-4747-a305-53c21c9b9cbf',capture={...generated,source:'file' as const,libraryVersion:pin,ocrText:'{"speaker":"SPEAKER_0"}\nExact retained canonical',provenance:{sourceId:'generated-source',externalId:'generated',revision:'b'.repeat(64),layer:'derived' as const,deleted:false,uri:pin}},calls:string[]=[];
 const {document:d}=await fixture(t,capture,async path=>{calls.push(path);throw Error('Generated exact revision denied');});assert.equal(d.querySelector('.evidence-text>pre')!.textContent,capture.ocrText);assert.equal(calls.length,1);assert.ok(calls[0].includes('revision='+'b'.repeat(64)));assert.equal(d.querySelector('.file-detail'),null);
});

test('a late old-owner media page cannot replace the next owner literal original',async t=>{
 const ref='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),chunk='d78f66ea-b068-4747-a305-53c21c9b9cbf',pin=ref+'#chunk:'+chunk,capture={...generated,source:'file' as const,libraryVersion:pin,ocrText:'{"speaker":"SPEAKER_0"}\nOld owner speech',provenance:{sourceId:'generated-source',externalId:'generated',revision:'b'.repeat(64),layer:'derived' as const,deleted:false,uri:pin}};
 let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve),{document:d,root}=await fixture(t,capture,async()=>pending),next={...generated,ocrText:'{"speaker":"a literal new owner record"}'};
 const api={request:async(path:string)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:next} as Api;await act(async()=>root.render(React.createElement(EvidenceDialog,{api,id:'capture:'+id,onOpen:()=>{},onClose:()=>{},onDeleted:()=>{}})));
 const text=capture.ocrText+'\n';await act(async()=>finish({material:{id:'mat_'+'a'.repeat(64),revision:'b'.repeat(64),ref,kind:'mote.file',schemaVersion:2,textLength:text.length,blockCount:1},text,textRange:{offset:0,total:text.length,nextOffset:null},spans:[{blockId:'chunk:'+chunk,kind:'text',format:'speech-text',evidenceId:id,evidenceOffset:0,pageRange:{start:0,end:text.length},materialRange:{start:0,end:text.length},locator:{chunkId:chunk,textStart:0,textEnd:capture.ocrText.length}}]}));assert.equal(d.querySelector('.evidence-text>pre')!.textContent,next.ocrText);assert.doesNotMatch(d.body.textContent!,/Old owner speech/);assert.equal(d.querySelector('.evidence-canonical'),null);
});

test('a standalone direct speech declaration does not extend exact media projection',async t=>{
 const capture={...generated,source:'file' as const,evidencePresentation:'speech-json-v1' as const,ocrText:'{"speaker":"Vendor A","text":"Literal provider words"}'},calls:string[]=[];
 const {document:d}=await fixture(t,capture,async path=>{calls.push(path);throw Error('Unexpected extra lookup');});assert.equal(d.querySelector('.evidence-text>pre')!.textContent,capture.ocrText);assert.deepEqual(calls,[]);await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());assert.equal(d.querySelector('.evidence-canonical'),null);
});

test('a revoked exact reference clears the readable body and explains why it cannot continue',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const d=dom.window.document,root=createRoot(d.querySelector('#root')!),ref='artifact:generated:revision-1';let revoked=false,reads=0;
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const api={request:async(path:string,init?:RequestInit)=>{if(path!=='/api/context/read')throw Error('Unexpected generated path '+path);reads++;if(revoked)throw new ApiError('generated access revoked',403);const body=JSON.parse(String(init?.body));return {items:[{id:'generated',ref,title:'Generated exact',kind:'artifact',text:'Generated exact body',textRange:{offset:body.offset,total:20,nextOffset:8}}],missingRefs:[]};},setAgentTimeout:()=>{}} as Api;
 const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated reader did not settle');};
 await act(async()=>root.render(React.createElement(ReferenceDetail,{api,reference:ref,onOpen:()=>{}})));await until(()=>d.body.textContent!.includes('Generated exact body'));
 revoked=true;await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='继续展开')!.click());await until(()=>Boolean(d.querySelector('[role=alert]')));
 assert.equal(reads,2);assert.doesNotMatch(d.body.textContent!,/Generated exact body/);assert.match(d.querySelector('[role=alert]')!.textContent!,/generated access revoked/);
});

test('an owner-confirmed speaker name remains visible above the exact speech body',async t=>{
 const chunk='d78f66ea-b068-4747-a305-53c21c9b9cbf',material='mat_'+'a'.repeat(64),revision='b'.repeat(64),ref=`material:${material}@${revision}`,pin=ref+'#chunk:'+chunk;
 const capture={...generated,source:'file' as const,libraryVersion:pin,ocrText:JSON.stringify({speaker:'SPEAKER_0',speakerAttribution:{name:'Generated confirmed speaker',confirmedBy:'owner',confirmationId:'11111111-1111-4111-8111-111111111111',confirmedAt:'2026-10-30T00:00:00Z'}})+'\nExact speaker words',provenance:{sourceId:'generated-source',externalId:material,revision,layer:'derived' as const,deleted:false,uri:pin}},text=capture.ocrText+'\n';
 const {document:d}=await fixture(t,capture,async()=>({material:{id:material,revision,ref,kind:'mote.file',schemaVersion:2,textLength:text.length,blockCount:1},text,textRange:{offset:0,total:text.length,nextOffset:null},spans:[{blockId:'chunk:'+chunk,kind:'text',format:'speech-text',evidenceId:id,evidenceOffset:0,pageRange:{start:0,end:text.length},materialRange:{start:0,end:text.length},locator:{chunkId:chunk,textStart:0,textEnd:capture.ocrText.length}}]}));
 assert.equal(d.querySelector('.evidence-speaker')!.textContent,'已确认说话人：Generated confirmed speaker');assert.equal(d.querySelector('.evidence-text>pre')!.textContent,'Exact speaker words');
});

test('the aside shows only declared descriptions and every conversation that cites this record or its Material',async t=>{
 const other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',materialRef='material:mat_'+'c'.repeat(64)+'@'+'d'.repeat(64),reads:string[]=[];
 const capture:Capture={...generated,memoryMaterialRef:materialRef,attributionContext:{
  recordContextDeclarations:[{captureId:id,version:1,fingerprint:'e'.repeat(64)}],
  recordContextStatements:[{captureId:id,version:1,description:'Generated owner description\nsecond line'},{captureId:other,version:1,description:'Undeclared generated description'}]}};
 const pages:Record<string,unknown>={
  '/api/conversations?limit=100':{items:[{id:'generated-anchor',title:'Generated anchored talk',scope:{anchorEvidenceIds:[id]}},{id:'generated-other',title:'Generated unrelated talk',scope:{evidenceIds:[other]}}],nextCursor:'generated-next'},
  '/api/conversations?limit=100&cursor=generated-next':{items:[{id:'generated-cited',title:'Generated cited talk',scope:{evidenceIds:[id]}},{id:'generated-material',title:'Generated material talk',scope:{anchorMaterialRef:materialRef}},{id:'generated-unscoped',title:'Generated unscoped talk',scope:{}}],nextCursor:null}};
 const {document:d}=await fixture(t,capture,undefined,path=>{reads.push(path);return pages[path];});await settle();
 assert.deepEqual(Array.from(factRow(d,'资料说明')!.querySelectorAll('dd p')).map(item=>item.textContent),['Generated owner description\nsecond line']);
 assert.deepEqual(Array.from(factRow(d,'引用它的对话')!.querySelectorAll('a')).map(item=>[item.textContent,item.getAttribute('href')]),[
  ['Generated anchored talk','#/ask?conversation=generated-anchor'],['Generated cited talk','#/ask?conversation=generated-cited'],['Generated material talk','#/ask?conversation=generated-material']]);
 assert.deepEqual(reads,Object.keys(pages),'every page is read once, in cursor order');
});

test('a record nobody cites says 0 and shows no description row',async t=>{
 const {document:d}=await fixture(t,generated);await settle();
 assert.equal(factRow(d,'资料说明'),undefined);assert.equal(factRow(d,'引用它的对话')!.querySelector('dd')!.textContent,'0');
});

test('a failed conversation read says — without hiding the original',async t=>{
 const {document:d}=await fixture(t,generated,undefined,()=>{throw new ApiError('Generated conversation failure',500);});await settle();
 assert.equal(factRow(d,'引用它的对话')!.querySelector('dd')!.textContent,'—');assert.equal(d.querySelector('.evidence-text pre')!.textContent,generated.ocrText);
});

test('a screenshot leads whole, and 查看原图 opens the same authorized image for close reading',async t=>{
 const capture:Capture={...generated,source:'screen',platform:'macos',blobHash:'f'.repeat(64),ocrText:'Generated screen words'};
 const {document:d,imageReads}=await fixture(t,capture);await settle();
 const figure=d.querySelector('.original-image')!,viewport=figure.querySelector('.original-image-viewport')!;
 assert.ok(viewport.querySelector('img'),'the screenshot is on the page without a click');assert.equal(viewport.getAttribute('role'),null);
 assert.ok(figure.compareDocumentPosition(d.querySelector('.evidence-text pre')!)&d.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING,'the image leads its recognized words');
 assert.deepEqual(imageReads,['/api/capture-browser/'+id+'/image'],'the hero reads the full image, not the thumbnail');
 const control=(label:string)=>Array.from(figure.querySelectorAll<HTMLButtonElement>('.original-image-controls button')).find(button=>button.textContent===label)!;
 await act(async()=>control('查看原图').click());
 assert.ok(figure.classList.contains('open'));assert.equal(viewport.getAttribute('role'),'region');assert.equal(viewport.getAttribute('tabindex'),'0');
 await act(async()=>control('原始尺寸').click());assert.ok(viewport.classList.contains('native-size'));
 await act(async()=>control('收起原图').click());assert.ok(!figure.classList.contains('open'));assert.ok(!viewport.classList.contains('native-size'));
 assert.equal(imageReads.length,1,'opening and closing reuse the loaded image');
});
