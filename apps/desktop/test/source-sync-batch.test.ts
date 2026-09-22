import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSync } from '../src/source-sync';
import type { ScannedItem, SourceDefinition } from '../src/source-types';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mote-source-batch-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const source: SourceDefinition = { id: 'fixture', name: 'fixture', kind: 'coding-agent', deviceId: 'device', platform: 'macos', retention: 'snapshot', enabled: true };
const item = (index: number, syncQueue: 'realtime' | 'history'): ScannedItem => ({ externalId: `event-${index}`, title: `event ${index}`, text: `generated ${index}`, kind: 'message', layer: 'snapshot', syncQueue });
const receipt = (value: ScannedItem & { revision: string }) => ({ id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: source.id, externalId: value.externalId, revision: value.revision, duplicate: false });
const indexedFile=(index:number):ScannedItem=>({...item(index,'realtime'),kind:'file',layer:'reference',text:'',document:{fileIndex:{version:1,fileId:'file-'+index,contentVersion:'generated',mode:'catalog',coverage:'none',parser:'none',status:'ready',totalCharacters:0,offset:0,length:0,allowRead:false}}});

it('schedules ordinary source records by admitted bytes and checkpoints per batch', async () => {
  const engine = new SourceSync(join(root, 'state.json'));
  await engine.initialize();
  await engine.stage({ items: [...Array.from({ length: 900 }, (_, i) => ({...item(i, 'realtime'),text:'x'.repeat(24000)})), ...Array.from({ length: 100 }, (_, i) => item(i + 900, 'history'))], seen: [], complete: true, skipped: 0 }, false);
  const paths: string[] = [], firstIds: string[] = [];
  const request = async (path: string, body: unknown, method: 'GET' | 'POST' | 'PUT') => {
    paths.push(`${method} ${path}`);
    if (path === '/api/sources') return { id: source.id, enabled: true };
    const records = (body as { items: Array<ScannedItem & { revision: string }> }).items;
    firstIds.push(records[0]!.externalId);
    return { receipts: records.map(receipt) };
  };
  for(let turn=0;engine.status().pending&&turn<20;turn++)await engine.flushSlice(source,request);
  const batches = paths.filter(path => path.includes('/items/batch'));
  expect(batches).toHaveLength(10);
  expect(firstIds.slice(0, 8).every(id => Number(id.replace('event-', '')) < 900)).toBe(true);
  expect(Number(firstIds[8]!.replace('event-', ''))).toBeGreaterThanOrEqual(900);
  expect(engine.status()).toMatchObject({ pending: 0, realtimePending: 0, historyPending: 0 });
},30000);

it('does not remove a batch when the central acknowledgement has the wrong identity', async () => {
  const engine = new SourceSync(join(root, 'state.json'));
  await engine.stage({ items: [item(1, 'realtime'), item(2, 'realtime')], seen: [], complete: true, skipped: 0 }, false);
  await expect(engine.flush(source, async (path, body) => {
    if (path === '/api/sources') return { id: source.id, enabled: true };
    const records = (body as { items: Array<ScannedItem & { revision: string }> }).items;
    return { receipts: records.map(value => ({ ...receipt(value), externalId: 'not-the-record' })) };
  })).rejects.toThrow('确认');
  expect(engine.status().pending).toBe(2);
});

it.each([404, 405])('falls back to verified individual receipts only when source batching is absent (%s)', async status => {
  const engine = new SourceSync(join(root, 'state.json'), { concurrency: 1 });
  await engine.initialize();
  const calls: string[] = [];
  const request = async (path: string, body: unknown) => {
    calls.push(path);
    if (path === '/api/sources') return { id: source.id, enabled: true };
    if (path.endsWith('/batch')) throw Object.assign(new Error('Route unavailable'), { httpStatus: status });
    return receipt(body as ScannedItem & { revision: string });
  };
  for (let offset = 0; offset < 4; offset += 2) {
    await engine.stage({ items: [item(offset, 'realtime'), item(offset + 1, 'realtime')], seen: [], complete: false, skipped: 0 }, false);
    await engine.flush(source, request);
  }
  expect(calls.filter(path => path.endsWith('/batch'))).toHaveLength(1);
  expect(calls.filter(path => path.endsWith('/items'))).toHaveLength(4);
  expect(engine.status().pending).toBe(0);
  const restored = new SourceSync(join(root, 'state.json'));
  await restored.initialize();
  expect(restored.status().pending).toBe(0);
});

it.each([401, 403, 413, 429, 500])('retains source batches after HTTP %s without changing endpoints', async status => {
  const engine = new SourceSync(join(root, 'state.json'), { concurrency: 1 });
  await engine.initialize();
  await engine.stage({ items: [item(1, 'realtime'), item(2, 'realtime')], seen: [], complete: false, skipped: 0 }, false);
  const calls: string[] = [];
  await expect(engine.flush(source, async path => {
    calls.push(path);
    if (path === '/api/sources') return { id: source.id, enabled: true };
    throw Object.assign(new Error('Rejected batch'), { httpStatus: status });
  })).rejects.toMatchObject({ httpStatus: status });
  expect(calls).toEqual(['/api/sources', '/api/sources/fixture/items/batch']);
  expect(engine.status().pending).toBe(2);
});

it.each([undefined, {}, { receipts: [] }, { receipts: 'invalid' }])('does not treat a malformed source batch ACK as protocol negotiation: %j', async response => {
  const engine = new SourceSync(join(root, 'state.json'), { concurrency: 1 });
  await engine.initialize();
  await engine.stage({ items: [item(1, 'realtime'), item(2, 'realtime')], seen: [], complete: false, skipped: 0 }, false);
  const calls: string[] = [];
  await expect(engine.flush(source, async path => {
    calls.push(path);
    return path === '/api/sources' ? { id: source.id, enabled: true } : response;
  })).rejects.toThrow('确认');
  expect(calls).toEqual(['/api/sources', '/api/sources/fixture/items/batch']);
  const restored = new SourceSync(join(root, 'state.json'));
  await restored.initialize();
  expect(restored.status().pending).toBe(2);
});

it('settles 99 accepted manifests and quarantines one forgotten file before sending the next batch',async()=>{
 const engine=new SourceSync(join(root,'state.json'));await engine.initialize();
 await engine.stage({items:Array.from({length:200},(_,i)=>indexedFile(i)),seen:[],complete:false,skipped:0},false);
 const requests:string[][]=[];
 await engine.flush(source,async(path,body)=>{
   if(path==='/api/sources')return {id:source.id,enabled:true};
   if(path.endsWith('/capabilities'))return {manifestBatch:100};
   const entries=(body as {items:{item:ScannedItem&{revision:string}}[]}).items;
   requests.push(entries.map(value=>value.item.externalId));
   return {results:entries.map(({item})=>({externalId:item.externalId,revision:item.revision,...(item.externalId==='event-37'?{state:'rejected',status:410}:{state:'accepted',ack:receipt(item)})}))};
 });
 expect(requests.map(batch=>batch.length)).toEqual([100,100]);expect(engine.status()).toMatchObject({pending:0,blocked:1,failures:[{externalId:'event-37',status:410}]});
 const reopened=new SourceSync(join(root,'state.json'));await reopened.initialize();expect(reopened.status()).toMatchObject({pending:0,blocked:1});
});

it('defers only transiently rejected manifests while unrelated batches continue',async()=>{
 const engine=new SourceSync(join(root,'state.json'));await engine.initialize();
 await engine.stage({items:Array.from({length:101},(_,i)=>indexedFile(i)),seen:[],complete:false,skipped:0},false);
 const requests:string[][]=[];
 const request=async(path:string,body:unknown)=>{
   if(path==='/api/sources')return {id:source.id,enabled:true};
   if(path.endsWith('/capabilities'))return {manifestBatch:100};
   const entries=(body as {items:{item:ScannedItem&{revision:string}}[]}).items;requests.push(entries.map(value=>value.item.externalId));
   return {results:entries.map(({item})=>({externalId:item.externalId,revision:item.revision,...(item.externalId==='event-0'&&requests.length===1?{state:'rejected',status:503}:{state:'accepted',ack:receipt(item)})}))};
 };
 await expect(engine.flush(source,request)).rejects.toMatchObject({httpStatus:503});expect(requests.map(batch=>batch.length)).toEqual([100,1]);expect(engine.status()).toMatchObject({pending:1,blocked:0});
 await engine.flush(source,request);expect(requests.at(-1)).toEqual(['event-0']);expect(engine.status().pending).toBe(0);
});

it('validates every manifest identity before applying accepted and rejected results',async()=>{
 const engine=new SourceSync(join(root,'state.json'));await engine.initialize();
 await engine.stage({items:[indexedFile(1),indexedFile(2)],seen:[],complete:false,skipped:0},false);
 await expect(engine.flush(source,async(path,body)=>{
   if(path==='/api/sources')return {id:source.id,enabled:true};if(path.endsWith('/capabilities'))return {manifestBatch:100};
   const entries=(body as {items:{item:ScannedItem&{revision:string}}[]}).items;
   return {results:entries.map(({item},index)=>({externalId:index?'wrong':item.externalId,revision:item.revision,...(index?{state:'rejected',status:410}:{state:'accepted',ack:receipt(item)})}))};
 })).rejects.toThrow('manifest acknowledgement');expect(engine.status()).toMatchObject({pending:2,blocked:0});
});
