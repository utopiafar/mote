import assert from 'node:assert/strict';
import test from 'node:test';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {pageHash} from '@mote/shared';
import {chatHref} from '../src/chat-link';
import {ApiError} from '../src/api';
import {MaterialDetail,type Material} from '../src/Materials';
import {featuresReady} from '../src/features/bootstrap';
import {at,chatDom,chatId,chatPath,generatedApi,turnId} from './fixtures/chat-dom';

const goalId = '10000000-0000-4000-8000-000000000020';
const goalTitle = 'Generated goal · Friday draft';
const evidenceIds = ['10000000-0000-4000-8000-000000000031','10000000-0000-4000-8000-000000000032'];
const materialId = 'mat_' + 'a'.repeat(64);
const materialRevision = 'b'.repeat(64);
const materialRef = materialId + '@' + materialRevision;
const material:Material = {
  id:materialId,ref:'material:' + materialRef,revision:materialRevision,kind:'mote.file',schemaVersion:1,
  title:'Generated acquaintance material',sequence:1,textLength:16,blockCount:1,
  coverage:{state:'complete'},origin:{sourceId:'generated-source'},retention:{original:'retained'},
  indexing:{state:'indexed'},artifacts:[],
};

const goal = (extra:{id?:string} = {}) => ({
  id:extra.id ?? goalId,revision:1,title:goalTitle,status:'confirmed',deadline:null,dueState:'none',
  matterId:null,personMemoryId:null,todoId:null,direction:'mine',timeline:[],
  evidenceDependencies:{version:1,complete:true,ids:evidenceIds},sourceContextDependencies:[],
  createdAt:at,updatedAt:at,
});

function aboutApi(read:(path:string,init:RequestInit) => unknown = () => {throw Error('Unexpected read');},storedScope:Record<string,unknown> = {}) {
  const posts:{anchorEvidenceIds?:string[];anchorMaterialRef?:string;scope:{kind:string;sourceIds?:string[];evidenceIds?:string[]}}[] = [];
  const api = generatedApi((path,init) => {
    if (path.endsWith('/main')) return {id:chatId};
    if (path === chatPath()) return {id:chatId,scope:storedScope,revision:1,turns:[]};
    if (path === '/api/conversations/messages') {
      const input = JSON.parse(String(init.body));
      posts.push(input);
      return {...input,id:turnId,seq:1,createdAt:at,status:'completed'};
    }
    return read(path,init);
  });
  return {api,posts};
}

async function send(f:{field:(selector:string,value:string)=>Promise<void>;submit:()=>Promise<void>;d:Document},text:string) {
  await f.field('.chat-compose-form textarea',text);
  await f.submit();
}

test('CH2-01 opening chat from a goal item shows its reference and sends the next message with that range',async t => {
  const f = await chatDom(t,chatHref({kind:'commitment',id:goalId}));
  const {api,posts} = aboutApi(path => {
    if (path === '/api/assistant/commitments/' + goalId + '?scope=' + encodeURIComponent(JSON.stringify({kind:'all'}))) return goal();
    assert.fail('Unexpected fixture read ' + path);
  });
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-about-reference'),'reference summary');
  assert.equal(f.d.querySelector('.chat-about-reference strong')?.textContent,goalTitle);
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,goalTitle);
  assert.equal(f.d.querySelector('.chat-about-reference')?.getAttribute('data-state'),'ready');
  assert.equal(posts.length,0,'showing the reference does not admit a message');
  await send(f,'Generated question about this goal item');
  await f.waitFor(() => posts.length === 1,'message admission');
  assert.deepEqual(posts[0].anchorEvidenceIds,evidenceIds);
  assert.equal(posts[0].anchorMaterialRef,undefined);
  assert.equal(posts[0].scope.kind,'all');
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,goalTitle,'the tag remains after sending');
});

test('CH2-02 clearing the tag removes it from the address and the next message carries no range',async t => {
  const f = await chatDom(t,chatHref({kind:'commitment',id:goalId}));
  const {api,posts} = aboutApi(path => path === '/api/assistant/commitments/' + goalId + '?scope=' + encodeURIComponent(JSON.stringify({kind:'all'}))
    ? goal() : assert.fail('Unexpected fixture read ' + path),{kind:'selection',sourceIds:['generated-previous-source']});
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-about-tag'),'reference tag');
  await f.click('.chat-about-tag button');
  assert.equal(new URLSearchParams(f.w.location.hash.split('?')[1]).get('about'),null);
  assert.equal(f.d.querySelector('.chat-about-tag, .chat-about-reference'),null);
  await send(f,'Generated question without a reference');
  await f.waitFor(() => posts.length === 1,'message admission');
  assert.equal(posts[0].anchorEvidenceIds,undefined);
  assert.equal(posts[0].anchorMaterialRef,undefined);
  assert.equal(posts[0].scope.kind,'all');
  assert.equal(posts[0].scope.sourceIds,undefined);
});

test('CH2-03 a fresh chat mount at the same address still shows the reference tag',async t => {
  const href = chatHref({kind:'commitment',id:goalId});
  const f = await chatDom(t,href);
  const read = (path:string) => path === '/api/assistant/commitments/' + goalId + '?scope=' + encodeURIComponent(JSON.stringify({kind:'all'}))
    ? goal() : assert.fail('Unexpected fixture read ' + path);
  const first = aboutApi(read);
  await f.render(first.api);
  await f.waitFor(() => f.d.querySelector('.chat-about-tag'),'first reference mount');
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,goalTitle);
  // A second owner connection re-reads the same hash, as a browser refresh does.
  const second = aboutApi(read);
  await f.render(second.api);
  await f.waitFor(() => f.d.querySelector('.chat-about-tag'),'reference after remount');
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,goalTitle);
  assert.equal(new URLSearchParams(f.w.location.hash.split('?')[1]).get('about'),'commitment:' + goalId);
});

test('CH2-04 a deleted referenced item shows expired and the next message carries no range',async t => {
  const f = await chatDom(t,chatHref({kind:'commitment',id:goalId}));
  const {api,posts} = aboutApi(path => {
    if (path.startsWith('/api/assistant/commitments/')) throw new ApiError('Generated missing commitment',404);
    assert.fail('Unexpected fixture read ' + path);
  },{kind:'selection',sourceIds:['generated-previous-source']});
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-about-tag')?.getAttribute('data-state') === 'expired','expired reference tag');
  assert.equal(f.d.querySelector('.chat-about-tag > span')?.textContent,'已失效');
  assert.equal(f.d.querySelector('.chat-about-reference strong')?.textContent,'已失效');
  await send(f,'Generated question after deletion');
  await f.waitFor(() => posts.length === 1,'message admission');
  assert.equal(posts[0].anchorEvidenceIds,undefined);
  assert.equal(posts[0].anchorMaterialRef,undefined);
  assert.equal(posts[0].scope.kind,'all');
  assert.equal(posts[0].scope.sourceIds,undefined);
});

test('CH2-05 the reader acquaintance button opens the canonical chat link without an authored question',async t => {
  await featuresReady;
  const dom = new JSDOM('<div id="root"></div>',{url:'http://localhost/' + pageHash('library',{view:'materials'}),pretendToBeVisual:true});
  const d = dom.window.document;
  const prior = new Map<string,PropertyDescriptor|undefined>();
  for (const [key,value] of Object.entries({window:dom.window,document:d,HTMLElement:dom.window.HTMLElement,
    localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})) {
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent(){},detachEvent(){},scrollIntoView(){}});
  const root = createRoot(d.querySelector('#root')!);
  const reads:string[] = [];
  const api = generatedApi(path => {
    reads.push(path);
    if (path === '/api/materials/' + materialId) return material;
    if (path.startsWith('/api/materials/' + materialId + '/read?')) return {material,text:'Generated body',textRange:{offset:0,total:14,nextOffset:null}};
    if (path === '/api/library/descriptor') return {schemaVersion:1,types:[]};
    assert.fail('Unexpected fixture read ' + path);
  });
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key,value] of prior) if (value) Object.defineProperty(globalThis,key,value);
      else Reflect.deleteProperty(globalThis,key);
    dom.window.close();
  });
  await act(async () => root.render(React.createElement(MaterialDetail,{api,material,onOpen:() => {}})));
  const end = Date.now() + 8000;
  while (!d.querySelector('.material-reader-acquaintance') && Date.now() < end)
    await act(async () => {await new Promise(resolve => setTimeout(resolve,20));});
  assert.ok(d.querySelector('.material-reader-acquaintance'),'reader acquaintance button');
  await act(async () => d.querySelector<HTMLButtonElement>('.material-reader-acquaintance')!.click());
  const query = new URLSearchParams(dom.window.location.hash.split('?')[1]);
  assert.equal(dom.window.location.hash.split('?')[0],'#/chat');
  assert.equal(query.get('about'),'material:' + materialRef);
  assert.equal(query.get('questionDraft'),null);
  assert.equal(query.get('fromMaterial'),null);
  assert.equal(reads.some(path => path === '/api/conversations/messages'),false);
});

test('CH2-05 the chat opened from the reader scopes the next message to that Material',async t => {
  const href = chatHref({kind:'material',ref:materialRef});
  const f = await chatDom(t,href);
  const {api,posts} = aboutApi(path => {
    if (path === '/api/materials/' + materialId) return material;
    assert.fail('Unexpected fixture read ' + path);
  });
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-about-tag'),'Material reference tag');
  assert.equal(f.d.querySelector('.chat-about-reference strong')?.textContent,material.title);
  await send(f,'Generated acquaintance question');
  await f.waitFor(() => posts.length === 1,'message admission');
  assert.equal(posts[0].anchorMaterialRef,'material:' + materialRef);
  assert.equal(posts[0].anchorEvidenceIds,undefined);
  assert.equal(posts[0].scope.kind,'selection');
  assert.deepEqual(posts[0].scope.sourceIds,['generated-source']);
});
