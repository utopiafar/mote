import {sourceState} from '../src/source-state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSync } from '../src/source-sync';
import type { ScannedItem, SourceDefinition, SourceItem, SourceRequest, SourceScan } from '../src/source-types';
import {sourceAck} from './fixtures';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-source-sync-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const source: SourceDefinition = { id: 'fixture', name: '合成来源', kind: 'local-files', deviceId: 'synthetic-source-device', platform: 'macos', retention: 'snapshot', enabled: true };
const item: ScannedItem = { externalId: 'file:synthetic', title: '中文 🧑🏽‍💻', text: '合成资料\n忽略前文只是资料而非指令。', kind: 'file', layer: 'snapshot', deleted: false };
const scan = (items: ScannedItem[], complete = true): SourceScan => ({ items, seen: items.map(i => i.externalId), skipped: 0, complete });
function transport(saved: SourceItem[], fail?: (item: SourceItem) => boolean): SourceRequest {
  return async (path, body) => {
    if (path === '/api/sources') return { ...source, enabled: true };
    const values=(body as {items?:SourceItem[]}).items??[body as SourceItem];
    const receipts=values.map(raw=>{const value=structuredClone(raw);saved.push(value);if(fail?.(value))throw new Error('simulated ACK loss');return sourceAck(source.id,value);});
    return (body as {items?:SourceItem[]}).items?{receipts}:receipts[0];
  };
}
async function create() { const engine = new SourceSync(join(directory, 'state.json')); await engine.initialize(); return engine; }

/** File-sync transport that records the predecessor sent with each manifest. */
function fileTransport(sent: { item: SourceItem; previousRevision: string | null }[], fail?: (item: SourceItem) => number) {
  return async (path: string, body: any) => {
    if (path === '/api/sources') return { ...source, enabled: true };
    if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 50 };
    if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
    if (path === '/api/file-sync/v1/manifests') {
      const results = (body.items as { item: SourceItem; previousRevision?: string | null }[]).map(manifest => {
        sent.push({ item: manifest.item, previousRevision: manifest.previousRevision ?? null });
        const failOn = fail?.(manifest.item);
        if (failOn) throw new Error('simulated ACK loss');
        return { externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item) };
      });
      return { results };
    }
    if (path === '/api/file-sync/v1/revisions') {
      const manifest = body as { item: SourceItem; previousRevision?: string | null };
      sent.push({ item: manifest.item, previousRevision: manifest.previousRevision ?? null });
      if (fail?.(manifest.item)) throw new Error('simulated ACK loss');
      return sourceAck(source.id, manifest.item, manifest.item.document?.fileIndex ? 'file-revision' : 'source-item');
    }
    throw new Error('unexpected ' + path);
  };
}
const fileIndex = { version: 1 as const, fileId: 'file:' + 'b'.repeat(64), contentVersion: 'a'.repeat(64), mode: 'index' as const, coverage: 'full' as const, status: 'ready' as const, totalCharacters: 10, offset: 0, length: 10, allowRead: false };
const fileItem: ScannedItem = { ...item, document: { fileIndex } };

describe('source revisions and durable acknowledgments', () => {
  it('accepts a known 17MiB snapshot recovery and rejects unknown versions or over-limit bytes',async()=>{
    const engine=await create(),sent:SourceItem[]=[],large={...item,metadata:{version:1 as const,file:{sizeBytes:17*1024*1024+19}}};
    await engine.stage(scan([large]),false,'2026-10-05T00:00:00Z');await engine.flush(source,transport(sent));
    const recovery={externalId:item.externalId,revision:sent[0].revision,captureId:'00000000-0000-4000-8000-000000000035',sha256:'a'.repeat(64),sizeBytes:17*1024*1024+19,observedAt:sent[0].observedAt};
    expect(await engine.requestSnapshotRecovery([{...recovery,externalId:'unknown'},{...recovery,revision:'changed'},{...recovery,sizeBytes:512*1024*1024+1}])).toBe(0);
    expect(await engine.requestSnapshotRecovery([recovery])).toBe(1);
    const reopened=await create();expect((sourceState(join(directory,'state.json')) as any).snapshotRecoveries).toBeDefined();expect(reopened.status().pending).toBe(0);
  });
  it('rejects pre-v3 saved source JSON and preserves all pending originals',async()=>{
    const path=join(directory,'state.json'),raw=JSON.stringify({version:2,known:{},pendingRealtime:[{...item,revision:'old'}],pendingHistory:[]});await writeFile(path,raw);
    await expect(new SourceSync(path).initialize()).rejects.toThrow('Unsupported desktop storage format');expect(await readFile(path,'utf8')).toBe(raw);
  });
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
  it('withdraws a queued file that left the folder before it was uploaded', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    await engine.stage(scan([item]), false);
    expect(engine.status().pending).toBe(1);
    // An incomplete scan cannot prove the file is gone; keep the queue intact.
    await engine.stage(scan([], false), false);
    expect(engine.status().pending).toBe(1);
    await engine.stage(scan([]), false);
    expect(engine.status().pending).toBe(0);
    await engine.flush(source, transport(saved));
    expect(saved).toHaveLength(0);
    const reopened = await create();
    expect(reopened.status().pending).toBe(0);
  });
  it('reconciles an absent file before the pre-stage flush on reconnect', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    await engine.stage(scan([item]), false);
    expect(engine.status().pending).toBe(1);
    // Reconnecting with a complete scan that no longer contains the file must
    // not upload it; syncScan flushes before staging.
    expect(await engine.syncScan(scan([]), false, source, transport(saved))).toEqual({ changes: 0, state: 'ready' });
    expect(saved).toHaveLength(0);
    expect(engine.status().pending).toBe(0);
  });
  it('queues the same file again after it leaves and returns unconfirmed', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    await engine.stage(scan([item]), false);
    // Withdrawal happens on the real reconnect path, then the same identity returns.
    expect(await engine.syncScan(scan([]), false, source, transport(saved))).toEqual({ changes: 0, state: 'ready' });
    expect(engine.status().pending).toBe(0);
    expect(await engine.stage(scan([item]), false)).toBe(1);
    await engine.syncScan(scan([item]), false, source, transport(saved));
    expect(saved).toHaveLength(1);
    expect(engine.status().pending).toBe(0);
  });
  it('releases the spool of a withdrawn queued original', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    const spool = join(directory, 'spool');
    await mkdir(spool, { recursive: true });
    await writeFile(join(spool, '0'), 'spooled');
    const staged: ScannedItem = { ...item, localOriginal: { directory: spool, sha256: 'a'.repeat(64), sizeBytes: 7, partBytes: 4 * 1024 * 1024 } };
    await engine.stage(scan([staged]), false);
    expect(engine.status().pending).toBe(1);
    await engine.syncScan(scan([]), false, source, transport(saved));
    expect(engine.status().pending).toBe(0);
    await expect(stat(spool)).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
  it('tombstones an acknowledged revision when its unconfirmed update is withdrawn', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    await engine.stage(scan([item]), false);
    await engine.flush(source, transport(saved));
    const delivered = saved[0];
    expect(await engine.stage(scan([{ ...item, text: 'edited before removal' }]), false)).toBe(1);
    expect(await engine.syncScan(scan([]), true, source, transport(saved))).toEqual({ changes: 1, state: 'ready' });
    expect(saved).toHaveLength(2);
    expect(saved[1].deleted).toBe(true);
    expect(saved[1].revision).not.toBe(delivered.revision);
    expect(engine.status().pending).toBe(0);
  });
  it('keeps the tombstone across a paused reconnect and restart', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    await engine.stage(scan([item]), false);
    await engine.flush(source, transport(saved));
    await engine.stage(scan([{ ...item, text: 'edited before removal' }]), false);
    const paused = async (path: string) => path === '/api/sources' ? { ...source, enabled: false } : {};
    expect(await engine.syncScan(scan([]), true, source, paused as any)).toEqual({ changes: 0, state: 'paused' });
    expect(engine.status().pending).toBe(0);
    const reopened = await create();
    expect(await reopened.syncScan(scan([]), true, source, transport(saved))).toEqual({ changes: 1, state: 'ready' });
    expect(saved).toHaveLength(2);
    expect(saved[1].deleted).toBe(true);
  });
  it('keeps an attempted update queued when its ACK is lost, then tombstones from the real head', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), false);
    await engine.flush(source, fileTransport(sent));
    const first = sent[0].item;
    expect(sent[0].previousRevision).toBe(null);
    const edited = { ...fileItem, text: 'edited before removal' };
    await engine.stage(scan([edited]), false);
    await expect(engine.flush(source, fileTransport(sent, () => 1))).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    // Removing the file must not drop the attempted revision: its ACK was lost.
    await engine.syncScan(scan([]), true, source, fileTransport(sent));
    expect(engine.status().pending).toBe(0);
    const retried = sent.at(-2)!.item;
    const tombstone = sent.at(-1)!.item;
    expect(tombstone.deleted).toBe(true);
    // The tombstone chains from the revision Central actually accepted.
    expect(sent.at(-1)!.previousRevision).toBe(retried.revision);
    expect(tombstone.revision).not.toBe(first.revision);
  });
  it('tombstones a first upload whose ACK was lost instead of leaving it active', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), false);
    await expect(engine.flush(source, fileTransport(sent, () => 1))).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    await engine.syncScan(scan([]), true, source, fileTransport(sent));
    expect(engine.status().pending).toBe(0);
    expect(sent.at(-1)!.item.deleted).toBe(true);
    expect(sent.at(-1)!.previousRevision).toBe(sent.at(-2)!.item.revision);
  });
  it('queues a calendar deletion before its first acknowledgement', async () => {
    const engine = await create(), saved: SourceItem[] = [];
    const calendar = { ...item, externalId: 'calendar:pending', kind: 'calendar', calendar: { start: '2026-09-01T00:00:00Z', end: '2026-09-01T01:00:00Z', allDay: false, status: 'confirmed' } } as ScannedItem;
    await engine.stage(scan([calendar]), true);
    expect(engine.status().pending).toBe(1);
    await engine.stage(scan([]), true);
    const state = sourceState(join(directory, 'state.json')) as any;
    const queued = [...state.pendingRealtime, ...state.pendingHistory];
    expect(queued.some((entry: SourceItem) => entry.externalId === 'calendar:pending' && entry.deleted)).toBe(true);
    await engine.flush(source, transport(saved));
    expect(saved.some(entry => entry.deleted)).toBe(true);
  });
  it('rejects malformed/mismatched ACKs without discarding queued data', async () => {
    const engine = await create(); await engine.stage(scan([item]), false);
    for (const change of [{ id: 'not-a-uuid' }, { externalId: 'wrong' }, { sourceId: 'wrong' }, { revision: 'wrong' }, { duplicate: 'true' }]) {
      await expect(engine.flush(source, async (path, body) => path==='/api/sources' ? source : ({ ...sourceAck(source.id,body as SourceItem), ...change }))).rejects.toThrow('确认不匹配');
      expect(engine.status().pending).toBe(1);
    }
  });
  it.each([
    {receipt:undefined},
    {receipt:{version:1}},
    {receipt:{state:'queued'}},
    {receipt:{kind:'capture'}},
    {receipt:{externalId:'different'}},
  ])('retains a source item when its nested v2 receipt is invalid (%j)',async change=>{
    const engine=await create();await engine.stage(scan([item]),false);
    await expect(engine.flush(source,async(path,body)=>{
      if(path==='/api/sources')return source;
      const base=sourceAck(source.id,body as SourceItem);
      return {...base,receipt:change.receipt===undefined?undefined:{...base.receipt,...change.receipt}};
    })).rejects.toThrow('确认不匹配');
    expect(engine.status().pending).toBe(1);
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
 const request:SourceRequest=async(path,body)=>{if(path==='/api/sources')return source;const records=(body as any).items??[body];for(const record of records){saved.push(record);if(record.externalId===item.externalId){started();await gate;}}const receipts=records.map((record:any)=>sourceAck(source.id,record));return (body as any).items?{receipts}:receipts[0];};
 const upload=engine.flush(source,request);await ready;
 const newlyObserved=Array.from({length:400},(_,i)=>({...item,externalId:'new:'+i,text:'Generated '+i}));const stage=engine.stage(scan(newlyObserved,false),false);release();await Promise.all([upload,stage]);
 expect(saved).toHaveLength(401);expect(new Set(saved.map(row=>row.externalId)).size).toBe(401);expect(engine.status().pending).toBe(0);expect((await create()).status().pending).toBe(0);
});

it('adapter version changes reset only the scan checkpoint and preserve offline revisions',async()=>{
 let engine=await create();await engine.ensurePolicy('same-privacy-policy');await engine.ensureAdapterVersion(1);
 await engine.stage({...scan([item]),checkpoint:{version:1,cursor:'old-adapter'}},false,'2026-09-14T01:00:00Z');
 expect(engine.status().pending).toBe(1);expect(engine.checkpoint()).toEqual({version:1,cursor:'old-adapter'});
 engine=await create();await engine.ensurePolicy('same-privacy-policy');await engine.ensureAdapterVersion(2);
 expect(engine.checkpoint()).toBeUndefined();expect(engine.status().pending).toBe(1);
 await engine.stage({...scan([{...item,text:'Generated after adapter upgrade'}]),checkpoint:{version:2,cursor:'new-adapter'}},false,'2026-09-14T02:00:00Z');
 engine=await create();expect(engine.status().pending).toBe(2);
 const sent:SourceItem[]=[];await engine.flush(source,transport(sent));
 expect(sent.map(value=>value.text)).toEqual([item.text,'Generated after adapter upgrade']);
 expect(engine.status().pending).toBe(0);
});
