import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DurableQueue} from '../src/queue';
import {defaultConfig} from '../src/config';
import {centralContentPage,localContentPage} from '../src/content-library';
import type {LocalSourceManager} from '../src/source-manager';
import {event} from './fixtures';

vi.mock('../src/background',()=>({previewWork:{run:vi.fn()},sourceWork:{run:vi.fn()}}));
let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'mote-content-search-'));});
afterEach(async()=>{vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});
it('finds queued records beyond the first 30 and paginates the filtered set',async()=>{
  const queue=new DurableQueue(join(directory,'queue'),defaultConfig());await queue.initialize();
  for(let i=0;i<65;i++)await queue.enqueue({...event(randomUUID()),source:'note',durationMs:0,imageMime:undefined,privacy:{excluded:false,redacted:false,mode:'none'},capturedAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),appName:'Generated notes',ocrText:i<32?'Needle older record '+i:'Unrelated recent record '+i});
  const sources={pendingContentSummaries:()=>[]} as unknown as LocalSourceManager;
  expect(localContentPage(queue,sources).items.every(row=>row.preview.startsWith('Unrelated'))).toBe(true);
  const first=localContentPage(queue,sources,0,'NEEDLE');expect(first.total).toBe(32);expect(first.items).toHaveLength(30);expect(first.nextOffset).toBe(30);
  const next=localContentPage(queue,sources,first.nextOffset,'needle');expect(next.items).toHaveLength(2);expect(next.nextOffset).toBeUndefined();
  expect(new Set([...first.items,...next.items].map(row=>row.key)).size).toBe(32);
  expect(localContentPage(queue,sources,0,'missing').total).toBe(0);
});
it('uses the existing capture search with exact device scope and carries its cursor without inventing a total',async()=>{
  const config={...defaultConfig(),serverUrl:'http://127.0.0.1:9999',token:'generated-test-token'},captureId=randomUUID();
  const card={id:captureId,ref:`capture:${captureId}`,title:'Generated title',snippet:'Generated match',origin:{deviceId:config.deviceId,source:'note',durationMs:0,imageMime:undefined,privacy:{excluded:false,redacted:false,mode:'none'},capturedAt:'2026-10-29T00:00:00.000Z'}};
  const fetch=vi.fn(async()=>new Response(JSON.stringify({items:[card],nextCursor:'generated-next',coverage:{recordsReturned:1}})));vi.stubGlobal('fetch',fetch);
  const page=await centralContentPage(config,'generated-current','Needle');
  const url=new URL(String(fetch.mock.calls[0][0]));expect(url.pathname).toBe('/api/context/search');expect(url.searchParams.get('deviceId')).toBe(config.deviceId);expect(url.searchParams.get('query')).toBe('needle');expect(url.searchParams.get('cursor')).toBe('generated-current');
  expect(page.items[0].key).toBe(`capture:${captureId}`);expect(page.nextCursor).toBe('generated-next');expect(page.total).toBeUndefined();
  fetch.mockImplementation(async()=>new Response(JSON.stringify({items:[{...card,origin:{...card.origin,deviceId:randomUUID()}}]})));
  await expect(centralContentPage(config,undefined,'needle')).rejects.toThrow('记录不属于当前设备');
  fetch.mockImplementation(async()=>new Response(JSON.stringify({items:[{...card,ref:'memory:'+captureId}]})));
  await expect(centralContentPage(config,undefined,'needle')).rejects.toThrow('记录不属于当前设备');
});
