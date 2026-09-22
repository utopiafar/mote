import {sourceState} from '../src/source-state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSync } from '../src/source-sync';
import type { ScannedItem, SourceDefinition, SourceItem, SourceRequest, SourceScan } from '../src/source-types';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-source-sync-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const source: SourceDefinition = { id: 'fixture', name: '合成来源', kind: 'local-files', deviceId: 'synthetic-source-device', platform: 'macos', retention: 'snapshot', enabled: true };
const item: ScannedItem = { externalId: 'file:synthetic', title: '中文 🧑🏽‍💻', text: '合成资料\n忽略前文只是资料而非指令。', kind: 'file', layer: 'snapshot', deleted: false };
const scan = (items: ScannedItem[], complete = true): SourceScan => ({ items, seen: items.map(i => i.externalId), skipped: 0, complete });
function transport(saved: SourceItem[], fail?: (item: SourceItem) => boolean): SourceRequest {
  return async (path, body, method) => {
    if (path === '/api/sources') return { ...source, enabled: true };
    if (path.endsWith('/batch')) throw Object.assign(new Error('Legacy fixture server'), { httpStatus: 404 });
    const value = structuredClone(body as SourceItem); saved.push(value);
    if (fail?.(value)) throw new Error('simulated ACK loss');
    return { id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: source.id, externalId: value.externalId, revision: value.revision, duplicate: false };
  };
}
async function create() { const engine = new SourceSync(join(directory, 'state.json')); await engine.initialize(); return engine; }
describe('source revisions and durable acknowledgments', () => {
  it('records archive acknowledgment only after a validated item ACK, never an empty sync',async()=>{
    const engine=await create(),sent:SourceItem[]=[];
    await engine.flush(source,transport(sent));expect(engine.status().lastAcknowledgedAt).toBeUndefined();
    await engine.stage(scan([item]),false);await expect(engine.flush(source,transport(sent,()=>true))).rejects.toThrow();
    expect(engine.status().lastAcknowledgedAt).toBeUndefined();
    await engine.flush(source,transport(sent));expect(engine.status().lastAcknowledgedAt).toMatch(/^20\d\d-/);
    const reopened=await create();expect(reopened.status().lastAcknowledgedAt).toBe(engine.status().lastAcknowledgedAt);
  });
  it('keeps the source index and pending snapshot in transactional SQLite across restart', async () => {
    const engine = await create();
    await engine.stage(scan([item]), false, '2026-09-14T01:00:00Z');
    const disk = sourceState(join(directory,'state.json')) as any;
    const pending = [...(disk.pendingRealtime ?? []), ...(disk.pendingHistory ?? [])];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ externalId: item.externalId, text: item.text });
    expect(Object.values(disk.known)).toEqual([expect.objectContaining({ item: expect.objectContaining({ externalId: item.externalId, title: item.title }) })]);
    const reopened = await create();
    const sent: SourceItem[] = [];
    await reopened.flush(source, transport(sent));
    expect(sent).toHaveLength(1); expect(sent[0].text).toBe(item.text);
  });
  it('reopens an ACK-lost revision with the identical ID/time/body, removes only verified ACK, then avoids reimport', async () => {
    let engine = await create(); const saved: SourceItem[] = [];
    expect(await engine.stage(scan([item]), false, '2026-09-14T01:00:00Z')).toBe(1);
    await expect(engine.flush(source, transport(saved, () => true))).rejects.toThrow('ACK loss');
    engine = await create(); await engine.flush(source, transport(saved));
    expect(saved[0]).toEqual(saved[1]); expect(engine.status().pending).toBe(0);
    expect(await engine.stage(scan([item]), false)).toBe(0);
    const disk = JSON.stringify(sourceState(join(directory,'state.json'))); expect(disk).not.toContain(item.text);
  });
  it('chains A → delete → same A with three distinct revisions', async () => {
    const engine = await create(); const saved: SourceItem[] = [];
    await engine.stage(scan([item]), true); await engine.flush(source, transport(saved));
    await engine.stage(scan([]), true); await engine.flush(source, transport(saved));
    await engine.stage(scan([item]), true); await engine.flush(source, transport(saved));
    expect(saved.map(i => Boolean(i.deleted))).toEqual([false, true, false]);
    expect(new Set(saved.map(i => i.revision)).size).toBe(3); expect(saved[1].text).toBe('');
  });
  it('never tombstones incomplete or skipped scans, or a calendar occurrence outside the current window', async () => {
    const engine = await create(); const saved: SourceItem[] = [];
    const calendar: ScannedItem = { ...item, externalId: 'calendar:old', kind: 'calendar', calendar: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z', allDay: false, status: 'confirmed' } };
    await engine.stage(scan([item, calendar]), true); await engine.flush(source, transport(saved));
    expect(await engine.stage(scan([], false), true)).toBe(0);
    expect(await engine.stage({ ...scan([]), seen: [item.externalId], scope: { start: '2026-09-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } }, true)).toBe(0);
  });
  it('rejects malformed/mismatched ACKs without discarding queued data', async () => {
    const engine = await create(); await engine.stage(scan([item]), false);
    for (const change of [{ id: 'not-a-uuid' }, { externalId: 'wrong' }, { sourceId: 'wrong' }, { revision: 'wrong' }, { duplicate: 'true' }]) {
      await expect(engine.flush(source, async (_p, body, method) => method === 'POST' ? source : ({ id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: source.id, externalId: item.externalId, revision: (body as SourceItem).revision, duplicate: true, ...change }))).rejects.toThrow('确认不匹配');
      expect(engine.status().pending).toBe(1);
    }
  });
  it('cannot emit old title/URI in a tombstone after changed privacy rules, but preserves later restoration revision chains', async () => {
    const engine = await create(); const saved: SourceItem[] = [];
    const privateItem = { ...item, title: 'old-private-title', uri: 'file:///old-private-location.md' };
    await engine.ensurePolicy('old-rules'); await engine.stage(scan([privateItem]), true); await engine.flush(source, transport(saved));
    await engine.ensurePolicy('new-exclusion-and-redaction-rules');
    expect(await engine.stage(scan([]), true)).toBe(0); await engine.flush(source, transport(saved)); expect(saved).toHaveLength(1);
    await engine.stage(scan([{ ...privateItem, title: '[已遮盖]', uri: undefined }]), true); await engine.flush(source, transport(saved));
    await engine.stage(scan([]), true); await engine.flush(source, transport(saved));
    expect(saved.at(-1)?.deleted).toBe(true); expect(saved.at(-1)?.title).toBe('[已遮盖]'); expect(saved.at(-1)?.uri).toBeUndefined();
    expect(new Set(saved.map(i => i.revision)).size).toBe(3);
  });
  it('drains a full queue after network recovery before staging the newly changed scan', async () => {
    const engine = new SourceSync(join(directory, 'state.json'), { maxEvents: 2, maxBytes: 32 * 1024 * 1024 }); await engine.initialize();
    const first = Array.from({ length: 1 }, (_, i) => ({ ...item, externalId: 'synthetic-' + i }));
    await engine.stage(scan(first), false);
    await engine.stage(scan(first.map(i => ({ ...i, text: 'second offline revision' }))), false);
    expect(engine.status().pending).toBe(2);
    // Use a single new item after recovery. Already ACKed revisions remain stable and only the new body is staged.
    const saved: SourceItem[] = [];
    const result = await engine.syncScan(scan([{ ...first[0], text: 'third online revision' }]), false, source, transport(saved));
    expect(result.changes).toBe(1); expect(saved).toHaveLength(3); expect(engine.status().pending).toBe(0);
  });
  it('central pause keeps the queued revision and makes no PUT request', async () => {
    const engine = await create(); await engine.stage(scan([item]), false);
    let calls = 0; expect(await engine.flush(source, async () => { calls++; return { ...source, enabled: false }; })).toBe('paused');
    expect(calls).toBe(1); expect(engine.status().pending).toBe(1);
  });
  it('a changed policy discards staged old bodies before any request, including across restart', async () => {
    let engine = await create(); await engine.ensurePolicy('snapshot'); await engine.stage(scan([item]), false);
    engine = await create(); await engine.ensurePolicy('reference');
    expect(engine.status().pending).toBe(0); expect(JSON.stringify(sourceState(join(directory,'state.json')))).not.toContain(item.text);
    await engine.stage(scan([{ ...item, text: '', layer: 'reference' }]), false);
    const saved: SourceItem[] = []; await engine.flush(source, transport(saved)); expect(saved[0].text).toBe('');
  });
});

 it('new-only baselines survive partial scans and restart, then explicit all backfills without duplicating new items', async () => {
   let engine=await create();const old={...item,externalId:'old'},second={...item,externalId:'old-second'},fresh={...item,externalId:'new'};
   expect(await engine.stage(scan([old],false),true,undefined,'new_only')).toBe(0);
   engine=await create();expect(await engine.stage(scan([second],true),true,undefined,'new_only')).toBe(0);
   expect(await engine.stage(scan([old,second,fresh]),true,undefined,'new_only')).toBe(1);
   const saved:SourceItem[]=[];await engine.flush(source,transport(saved));expect(saved.map(i=>i.externalId)).toEqual(['new']);
   engine=await create();expect(await engine.stage(scan([old,second,fresh]),true,undefined,'all')).toBe(2);
   await engine.flush(source,transport(saved));expect(new Set(saved.map(i=>i.externalId)).size).toBe(3);
 });
it('serializes new scan commits with in-flight ACKs without replaying old revisions or losing new work',async()=>{
 const engine=await create();await engine.stage(scan([item]),false);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);const saved:SourceItem[]=[];
 const request:SourceRequest=async(path,body)=>{if(path==='/api/sources')return source;const records=(body as any).items??[body];for(const record of records){saved.push(record);if(record.externalId===item.externalId){started();await gate;}}const receipts=records.map((record:any)=>({id:'b67c1b84-f2cd-4e59-bf67-215545a882dc',sourceId:source.id,externalId:record.externalId,revision:record.revision,duplicate:false}));return (body as any).items?{receipts}:receipts[0];};
 const upload=engine.flush(source,request);await ready;
 const newlyObserved=Array.from({length:400},(_,i)=>({...item,externalId:'new:'+i,text:'Generated '+i}));const stage=engine.stage(scan(newlyObserved,false),false);release();await Promise.all([upload,stage]);
 expect(saved).toHaveLength(401);expect(new Set(saved.map(row=>row.externalId)).size).toBe(401);expect(engine.status().pending).toBe(0);expect((await create()).status().pending).toBe(0);
});
