import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {GlobalRetrieval,SearchWorkspace} from '../src/plugins/search';
import {MemoryTopics} from '../src/plugins/memory/index';
import type {Api} from '../src/api';
import {modelView} from './fixtures/model-settings';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/search?query=generated',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 // React was imported before jsdom; its fallback input listener expects these legacy hooks.
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=()=>{};const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document,w:dom.window};
}
test('global retrieval keyboard focuses search without opening a modal or issuing an empty query',async t=>{
 const {root,d,w}=await fixture(t),pages:string[]=[];
 await act(async()=>root.render(React.createElement(GlobalRetrieval,{onPage:page=>pages.push(page)})));
 w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));assert.equal(d.activeElement,d.querySelector('input'));
 await act(async()=>d.querySelector('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(w.location.hash,'#/search?query=generated');assert.deepEqual(pages,[]);assert.equal(d.querySelector('[role=dialog]'),null);
});
test('search opens a pinned result with evidence then returns to its result list',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path==='/api/model-settings')return modelView();if(path==='/api/memory-settings')return {settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};if(path.startsWith('/api/library/browse?'))return {items:[],sources:[],nextCursor:null};if(path.startsWith('/api/memories?'))return {items:[{id:'generated',title:'Generated result',statement:'Generated evidence preview',status:'published'}],nextCursor:null};if(path.startsWith('/api/memories/generated?'))return {id:'generated',title:'Generated result',statement:'Generated original evidence',status:'published',createdAt:'2026-01-01T00:00:00Z',evidence:[],evidenceIds:[]};return {items:[],nextCursor:null};}} as Api;
 await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated original evidence/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.memory-detail-back')!.click());assert.equal(d.querySelector('.library-browser')!.classList.contains('has-selection'),false);assert.match(d.querySelector('.library-master')!.textContent!,/Generated result/);assert.equal(reads.filter(path=>path.startsWith('/api/memories?')&&path.includes('query=generated')).length,1);
});
test('search round trips through an exact reader preserve the query and page, while a new owner cannot inherit them',async t=>{
 const {root,d,w}=await fixture(t),first='memory:generated-first',second='memory:generated-second',reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path==='/api/model-settings')return modelView();if(path==='/api/memory-settings')return {settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};if(path.startsWith('/api/library/browse?'))return {items:[],sources:[],nextCursor:null};if(path.startsWith('/api/memories?'))return {items:[{id:path.includes('cursor=')?'generated-second':'generated-first',title:path.includes('cursor=')?'Generated second page':'Generated first page',status:'published'}],nextCursor:path.includes('cursor=')?null:'generated-page'};if(path.startsWith('/api/memories/generated-second?'))return {id:'generated-second',title:'Generated second page',statement:'Generated pinned second original',status:'published',createdAt:'2026-01-01T00:00:00Z',evidence:[],evidenceIds:[]};return {items:[],nextCursor:null};}} as Api;
 const view=(owner:Api)=>React.createElement(SearchWorkspace,{api:owner,onOpen:()=>{}});await act(async()=>root.render(view(api)));
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='下一页')!.click());
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());const returnHash=w.location.hash;assert.equal(new URLSearchParams(returnHash.split('?')[1]).get('evidence'),second);assert.equal(new URLSearchParams(returnHash.split('?')[1]).get('memoryCursor'),'generated-page');
 await act(async()=>{root.render(React.createElement('div'));w.history.replaceState(null,'','#/ask?fromMemory=generated-second');});await act(async()=>{w.history.replaceState(null,'',returnHash);root.render(view(api));});assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated pinned second original/);await act(async()=>d.querySelector<HTMLButtonElement>('.memory-detail-back')!.click());assert.match(d.querySelector('.library-master')!.textContent!,/Generated second page/);assert.equal(reads.filter(path=>path.startsWith('/api/memories?')&&path.includes('query=generated')&&!path.includes('cursor=')).length,1,'returning never resets to the first result page');assert.equal(reads.filter(path=>path.startsWith('/api/memories?')&&path.includes('query=generated')).at(-1)?.includes('cursor=generated-page'),true,'the mounted result page revalidates its exact cursor');
 const otherReads:string[]=[],other={request:async(path:string)=>{otherReads.push(path);return {items:[],missingRefs:[]};}} as Api;await act(async()=>root.render(view(other)));assert.equal(w.location.hash,'#/search');assert.deepEqual(otherReads,['/api/features'],'only the new node capability inventory is read; no previous query or reference crosses owners');assert.doesNotMatch(d.body.textContent!,/Generated second page|Generated pinned second original/);
});
test('plugin topic dimensions use supplied exact IDs without replacing or guessing membership',async t=>{
 const {root,d}=await fixture(t),selections:string[][]=[];
 const api={request:async()=>({items:[{id:'topics',version:'1',label:'主题',nodes:[{id:'generated-topic',label:'Generated topic'}]},{id:'plugin-dimension',version:'1',label:'Generated dimension',nodes:[{id:'plugin-node',label:'Generated node'}]}]})} as unknown as Api;
 await act(async()=>root.render(React.createElement(MemoryTopics,{api,treeId:'plugin-dimension',nodeId:'',onChange:(tree,node)=>selections.push([tree,node])})));
 await act(async()=>Array.from(d.querySelectorAll('button')).find(node=>node.textContent==='Generated node')!.click());assert.deepEqual(selections,[['plugin-dimension','plugin-node']]);assert.equal(d.querySelector('select')!.value,'plugin-dimension');
});

test('saving a conversation requires editor confirmation and keeps quoted model output separate from the owner comment',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];
 const {SaveConversationRecord}=await import('../src/plugins/ask/SaveConversationRecord');
 const api={request:async(path:string,init:RequestInit)=>{writes.push({path,body:JSON.parse(String(init.body))});return {id:writes.at(-1).body.id};}} as unknown as Api;
 await act(async()=>root.render(React.createElement(SaveConversationRecord,{api,conversationId:'generated-conversation',messageId:'generated-message',question:'Generated question',answer:'Generated untrusted model output',onOpen:()=>{}})));
 assert.equal(writes.length,0);await act(async()=>d.querySelector<HTMLButtonElement>('button')!.click());assert.equal(writes.length,0);assert.match(d.querySelector('details')!.textContent!,/Generated untrusted model output/);
 await act(async()=>d.querySelector('form')!.dispatchEvent(new d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/notes');assert.equal(writes[0].body.text,'');assert.equal(writes[0].body.metadata.noteOrigin.kind,'conversation');assert.equal(writes[0].body.metadata.noteOrigin.text,'Generated question\n\nGenerated untrusted model output');assert.deepEqual(writes[0].body.metadata.noteOrigin.messageIds,['generated-message']);assert.match(d.body.textContent!,/查看已保存记录/);
});

test('shared content remains attributed as a quote and safely rendered',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');const {NoteOrigin}=await import('../src/NoteOrigin');
 const html=renderToStaticMarkup(React.createElement(NoteOrigin,{capture:{metadata:{version:1,observedAt:'2026-10-01T00:00:00Z',noteOrigin:{kind:'share',text:'Generated <script>quoted assertion</script>',app:'Generated external app'}},ocrText:'Generated owner comment'} as any}));
 assert.match(html,/分享内容/);assert.match(html,/&lt;script&gt;quoted assertion&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Generated external app/);assert.doesNotMatch(html,/Generated owner comment/);
});

test('clearing Ask scope changes only the next submitted turn and history navigation resets the pending override',async t=>{
 const {root,d,w}=await fixture(t);w.HTMLElement.prototype.scrollIntoView=()=>{};
 const {Conversations}=await import('../src/plugins/ask/Conversations');const {modelView}=await import('./fixtures/model-settings');
 const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',evidence='33333333-3333-4333-8333-333333333333',when='2026-10-01T00:00:00Z';
 const summary=(value:string)=>({id:value,title:value===id?'Generated scoped conversation':'Generated other conversation',createdAt:when,updatedAt:when,turnCount:0,scope:value===id?{evidenceIds:[evidence]}:{},status:'completed'});
 const scopedRecord={...summary(id),revision:1,turns:[],nextCursor:null},otherRecord={...summary(other),revision:1,turns:[],nextCursor:null};
 const writes:any[]=[];const settingsView={revision:1,domains:[{id:'conversations',effective:{multipleConversations:true,context:{historyRatio:0.5,lowWatermarkRatio:0.5,contextWindow:null,contextWindowSource:'conservative'}},saved:{},fields:[],status:'applied'}]};const api={request:async(path:string,init?:RequestInit)=>{
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/configuration')return settingsView;
  if(path==='/api/conversations/main')return {id};
  if(path==='/api/conversations?limit=30')return {items:[summary(id),summary(other)],nextCursor:null};
  if(path==='/api/conversations/messages'&&init?.method==='POST'){const input=JSON.parse(String(init.body));writes.push(input);return {id:crypto.randomUUID(),...input,revision:1,status:'accepted',seq:0,createdAt:when};}
  if(path.startsWith('/api/conversations/')&&!path.includes('/messages/'))return path.split('/').pop()===id?scopedRecord:otherRecord;
  if(path==='/api/query-runs')return {items:[]};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  if(path.startsWith('/api/owner-questions'))return {items:[],nextCursor:null};
  throw Error('Unexpected generated scope fixture path '+path);
 },setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],onOpen:()=>{},renderAnswer:()=>null})));
 const choose=async(title:string)=>act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('.conversation-item')).find(button=>button.querySelector('strong')?.textContent===title)!.click());
 await choose('Generated scoped conversation');
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/1 条证据/);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='清除范围')!.click());
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/全部资料/);assert.equal(writes.length,0,'clear is a pending selection, not an API mutation');assert.deepEqual(scopedRecord.scope.evidenceIds,[evidence]);
 await choose('Generated other conversation');await choose('Generated scoped conversation');
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/1 条证据/,'opening history resets the unsent clear override');
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='清除范围')!.click());
 await act(async()=>{const input=d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!;Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Generated next unscoped question');input.dispatchEvent(new w.Event('input',{bubbles:true}));});
 await act(async()=>d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!.closest('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,1);assert.equal(writes[0].conversationId,id);assert.equal(writes[0].scope.kind,'all');assert.equal(Object.hasOwn(writes[0].scope,'evidenceIds'),false,'the actual public transport explicitly clears inherited scope');assert.equal(writes[0].question,'Generated next unscoped question');assert.deepEqual(scopedRecord.scope.evidenceIds,[evidence],'historical scope remains unchanged');
 assert.equal(d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!.disabled,false,'accepted message releases the composer for the next queued turn');
});

test('search keeps independent real material and Memory cursors and literal filters while withdrawing a 403 page',async t=>{
 const {root,d,w}=await fixture(t),reads:string[]=[];let denied=false;
 w.history.replaceState(null,'','#/search?query=literal&deviceId=generated-device&sourceId=generated-source&after=2026-01-01T00%3A00%3A00Z');
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/library/browse?')){if(denied){const {ApiError}=await import('../src/api');throw new ApiError('Generated forbidden',403);}return {items:[{entryType:'capture',ref:'capture:generated-note',contentAt:'2026-01-02T00:00:00Z',revision:'pinned-note',capture:{windowTitle:'Generated actual note',deviceName:'Generated device',textPreview:'Literal saved original'}}],sources:[{id:'generated-source',label:'Generated source'}],nextCursor:path.includes('cursor=material-next')?null:'material-next'};}if(path.startsWith('/api/memories?'))return {items:[{id:'generated-memory',title:'Generated actual Memory',statement:'Stored statement',status:'published'}],nextCursor:path.includes('cursor=memory-next')?null:'memory-next'};throw Error(path);}} as Api;
 await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));const groups=()=>d.querySelectorAll('.search-result-group');assert.equal(groups().length,2);assert.equal(groups()[0].querySelector('.section-head span')!.textContent,'本页 1 项');assert.doesNotMatch(groups()[0].querySelector('.section-head span')!.textContent!,/\+/);
 const clickNext=async(index:number)=>act(async()=>groups()[index].querySelector<HTMLButtonElement>('.search-pagination button:last-child')!.click());
 await clickNext(0);await clickNext(1);const q=new URLSearchParams(w.location.hash.split('?')[1]);assert.equal(q.get('cursor'),'material-next');assert.equal(q.get('memoryCursor'),'memory-next');for(const path of reads.filter(path=>path.startsWith('/api/library/browse?')||path.startsWith('/api/memories?'))){const p=new URLSearchParams(path.split('?')[1]);assert.equal(p.get('query'),'literal');assert.equal(p.get('sourceId'),'generated-source');assert.equal(p.get('deviceId'),'generated-device');assert.equal(p.get('after'),'2026-01-01T00:00:00Z');}assert.equal(reads.some(path=>path.startsWith('/api/context/search')),false);
 denied=true;const {resources}=await import('../src/resource-cache');await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/library/browse?')));assert.doesNotMatch(d.body.textContent!,/Generated actual note/);assert.match(d.body.textContent!,/Generated actual Memory/);assert.ok(d.querySelector('[role=alert]'));assert.equal(new URLSearchParams(w.location.hash.split('?')[1]).get('cursor'),'material-next');
});

test('preparing a Home or search question preserves an existing unsent question and attachments when switching is cancelled',async t=>{
 const {w}=await fixture(t),{openQuestionDraft}=await import('../src/open-question-draft'),{unsentDrafts}=await import('../src/plugins/ask/chat-drafts');
 const api={} as Api,attachment={id:'11111111-1111-4111-8111-111111111111',name:'Generated attachment',mimeType:'image/png'},draft={question:'Generated later question',attachments:[attachment]};unsentDrafts.set(api,draft);let prompts=0;w.confirm=()=>{prompts++;return false;};const hash=w.location.hash;
 openQuestionDraft(api,'Generated search question');assert.equal(w.location.hash,hash);assert.equal(unsentDrafts.get(api),draft);assert.deepEqual(unsentDrafts.get(api)?.attachments,[attachment]);assert.equal(prompts,1);
 w.confirm=()=>true;openQuestionDraft(api,'Generated search question');assert.equal(new URLSearchParams(w.location.hash.split('?')[1]).get('questionDraft'),'Generated search question');assert.equal(unsentDrafts.get(api),draft,'preparing navigation never edits or submits the existing composer');
});

test('search previews a pinned authored span without raw metadata and fences a late previous revision',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[],id='mat_'+ '1'.repeat(64),a='a'.repeat(64),b='b'.repeat(64);let revision=a,resolveOld!:(value:unknown)=>void;
 const material=()=>({id,ref:'material:'+id+'@'+revision,revision,kind:'mote.note',schemaVersion:2,title:'Generated source note',textLength:100,blockCount:2,origin:{sourceId:'generated-source'},coverage:{state:'complete'},retention:{original:'retained'}});
 const api={request:async(path:string)=>{reads.push(path);if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/materials/:id/read',state:'active',version:'1',surface:'data',featureId:'mote.sources'}]};if(path.startsWith('/api/library/browse?'))return {items:[{entryType:'material',ref:material().ref,contentAt:'2026-01-01T00:00:00Z',material:material()}],types:[],sources:[],nextCursor:null};if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};if(path.includes('/read?')){if(path.includes('revision='+a))return new Promise(resolve=>resolveOld=resolve);const text='Generated current authored body'+JSON.stringify({captureId:'generated-private-metadata'});return {material:{ref:'material:'+id+'@'+b},text,spans:[{kind:'text',format:'plain',pageRange:{start:0,end:31}},{kind:'text',format:'json',pageRange:{start:31,end:text.length}}]};}throw Error('Unexpected source preview '+path);}} as Api;
 await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));assert.ok(resolveOld);revision=b;const {resources}=await import('../src/resource-cache');await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/library/browse?')));assert.match(d.body.textContent!,/Generated current authored body/);
 await act(async()=>resolveOld({material:{ref:'material:'+id+'@'+a},text:'Generated obsolete body',spans:[{kind:'text',format:'plain',pageRange:{start:0,end:23}}]}));assert.doesNotMatch(d.body.textContent!,/Generated obsolete body|captureId|generated-private-metadata|generated-old-metadata/);assert.ok(reads.filter(path=>path.includes('/read?')).every(path=>new URLSearchParams(path.split('?')[1]).get('length')==='240'));assert.equal(reads.filter(path=>/\/read\?/.test(path)).length,2,'each exact revision is read once; metadata is excluded by declared span format');
});

test('a changed material cursor can return to its first page without resetting the independent Memory page',async t=>{
 const{root,d,w}=await fixture(t);w.history.replaceState(null,'','#/search?query=generated&cursor=material-old&memoryCursor=memory-current');const reads:string[]=[];const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/library/browse?')){if(path.includes('cursor=material-old')){const{ApiError}=await import('../src/api');throw new ApiError('Generated browse changed',409,undefined,'invalid_cursor');}return{items:[],sources:[],nextCursor:null};}if(path.startsWith('/api/memories?'))return{items:[{id:'generated-memory',title:'Generated retained Memory page',status:'published'}],nextCursor:null};return{items:[]};}}as Api;
 await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));assert.match(d.querySelector('[role=alert]')!.textContent!,/资料目录已变化/);assert.match(d.body.textContent!,/Generated retained Memory page/);await act(async()=>d.querySelector<HTMLButtonElement>('[role=alert] button')!.click());const q=new URLSearchParams(w.location.hash.split('?')[1]);assert.equal(q.get('cursor'),null);assert.equal(q.get('memoryCursor'),'memory-current');assert.equal(q.get('query'),'generated');assert.equal(reads.filter(path=>path.startsWith('/api/memories?')).length,1,'resetting the material stream never replays the Memory stream');assert.equal(d.querySelector('[role=alert]'),null);
});
