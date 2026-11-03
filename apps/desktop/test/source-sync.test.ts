import {sourceState} from '../src/source-state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSync, sourceHash } from '../src/source-sync';
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
function fileTransport(sent: { item: SourceItem; previousRevision: string | null }[], fail?: (item: SourceItem) => number, failBeforeCommit = false) {
  const committed = new Map<string, string>();
  return async (path: string, body: any) => {
    if (path === '/api/sources') return { ...source, enabled: true };
    // Above the default batch size so these cases use the manifest batch path.
    if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
    if (path.startsWith('/api/file-sync/v1/head')) {
      const externalId = decodeURIComponent(new URL(path, 'http://x').searchParams.get('externalId') ?? '');
      return { revision: committed.get(externalId) ?? null };
    }
    if (path === '/api/file-sync/v1/manifests') {
      const results = (body.items as { item: SourceItem; previousRevision?: string | null }[]).map(manifest => {
        sent.push({ item: manifest.item, previousRevision: manifest.previousRevision ?? null });
        // Validate the predecessor against the simulated node head: an update
        // must chain from the committed revision, a duplicate is idempotent.
        const head = committed.get(manifest.item.externalId) ?? null;
        if (manifest.item.revision !== head && (manifest.previousRevision ?? null) !== head) throw new Error('predecessor mismatch (409)');
        const failOn = fail?.(manifest.item);
        if (failOn && failBeforeCommit) throw new Error('simulated ACK loss');
        committed.set(manifest.item.externalId, manifest.item.revision);
        if (failOn) throw new Error('simulated ACK loss');
        return { externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, manifest.item.document?.fileIndex ? 'file-revision' : 'source-item') };
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
    // Fail only the queued update's single attempt, after A was accepted.
    const wire = fileTransport(sent, (item) => (sent.filter(entry => entry.item.revision === item.revision).length === 1 && sent.length === 2 ? 1 : 0));
    await engine.stage(scan([fileItem]), false);
    await engine.flush(source, wire);
    const first = sent[0].item;
    expect(sent[0].previousRevision).toBe(null);
    const edited = { ...fileItem, text: 'edited before removal' };
    await engine.stage(scan([edited]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    const attempted = sent.at(-1)!.item;
    const durable = sourceState(join(directory, 'state.json')) as any;
    expect(Object.hasOwn(durable.predecessors ?? {}, attempted.revision)).toBe(true);
    // Restart keeps the attempted revision and its predecessor, so the retry can
    // still resolve the real Central head.
    const reopened = await create();
    expect(reopened.status().pending).toBe(1);
    // Removing the file must not drop the attempted revision: its ACK was lost.
    await reopened.syncScan(scan([]), true, source, wire);
    expect(reopened.status().pending).toBe(0);
    const retried = sent.at(-2)!.item;
    const tombstone = sent.at(-1)!.item;
    expect(tombstone.deleted).toBe(true);
    // The tombstone chains from the revision Central actually accepted.
    expect(sent.at(-1)!.previousRevision).toBe(retried.revision);
    expect(tombstone.revision).not.toBe(first.revision);
  });
  it('tombstones a first upload whose ACK was lost instead of leaving it active', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let failedOnce = false;
    const wire = fileTransport(sent, () => (!failedOnce ? ((failedOnce = true), 1) : 0));
    await engine.stage(scan([fileItem]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    await engine.syncScan(scan([]), true, source, wire);
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
  it('does not publish a removed file after a failed attempt when deletion tracking is off', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), false);
    await expect(engine.flush(source, fileTransport(sent, () => 1))).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    expect(Object.hasOwn((sourceState(join(directory, 'state.json')) as any).predecessors ?? {}, sent.at(-1)!.item.revision)).toBe(true);
    const uploaded = sent.length;
    // Complete scan after removal, deletion tracking off: the uncertain upload
    // must be withdrawn rather than retried into an active remote file.
    expect(await engine.syncScan(scan([]), false, source, fileTransport(sent))).toEqual({ changes: 0, state: 'ready' });
    expect(engine.status().pending).toBe(0);
    expect(sent).toHaveLength(uploaded);
  });
  it('withdraws an attempted upload that never committed centrally', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let failures = 1;
    const wire = fileTransport(sent, () => (failures-- > 0 ? 1 : 0), true);
    await engine.stage(scan([fileItem]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    expect(Object.hasOwn((sourceState(join(directory, 'state.json')) as any).predecessors ?? {}, sent.at(-1)!.item.revision)).toBe(true);
    const uploaded = sent.length;
    // The node head does not contain the attempted revision: the removal wins.
    await engine.syncScan(scan([]), true, source, wire);
    expect(engine.status().pending).toBe(0);
    expect(sent).toHaveLength(uploaded);
  });
  it('keeps an attempted revision when the head answer is unknown or advanced', async () => {
    for (const mode of ['error', 'advanced'] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'mote-ambig-'));
      const engine = new SourceSync(join(dir, 'state.json')); await engine.initialize();
      const sent: { item: SourceItem; previousRevision: string | null }[] = [];
      const wire = async (path: string, body: any) => {
        if (path === '/api/sources') return { ...source, enabled: true };
        if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
        if (path.startsWith('/api/file-sync/v1/head')) {
          if (mode === 'error') throw new Error('head unavailable');
          return { revision: 'later-revision' };
        }
        if (path === '/api/file-sync/v1/manifests') {
          sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
          throw new Error('simulated ACK loss');
        }
        if (path === '/api/file-sync/v1/revisions') throw new Error('simulated ACK loss');
        throw new Error('unexpected ' + path);
      };
      await engine.stage(scan([fileItem]), false);
      await expect(engine.flush(source, wire as any)).rejects.toThrow('ACK loss');
      const spool = join(dir, 'spool-ambig'); await mkdir(spool, { recursive: true }); await writeFile(join(spool, '0'), 'x');
      // Ambiguous delivery is neither withdrawn nor rewound.
      await expect(engine.syncScan(scan([]), true, source, wire as any)).rejects.toThrow();
      expect(engine.status().pending).toBe(1);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('withdraws an uncommitted absent attempt on the managed flush path', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let fail = true;
    const wire = fileTransport(sent, () => (fail ? 1 : 0), true);
    await engine.stage(scan([fileItem]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    expect(engine.status().pending).toBe(1);
    // Managed scans stage the absence with deletion tracking on and supply the
    // head resolver; flushPending then calls flush() directly without syncScan.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => null);
    expect(engine.status().pending).toBe(0);
    fail = false;
    const uploaded = sent.length;
    await engine.flush(source, wire);
    expect(sent).toHaveLength(uploaded);
  });
  it('keeps a committed update whose ACK was lost so reappearance chains from it', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let failures = 0;
    const wire = fileTransport(sent, () => (sent.length === 2 && failures++ === 0 ? 1 : 0));
    await engine.stage(scan([fileItem]), false);
    await engine.flush(source, wire);
    await engine.stage(scan([{ ...fileItem, text: 'update B' }]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    // Withdrawal is not required: the node holds B, so keep it and let the retry
    // confirm the duplicate receipt.
    await engine.syncScan(scan([]), false, source, wire);
    const update = sent.at(-2)!.item;
    await engine.stage(scan([{ ...fileItem, text: 'revision C' }]), false);
    await engine.flush(source, wire);
    expect(sent.at(-1)!.previousRevision).toBe(update.revision);
  });
  it('queues the deletion after a managed flush acknowledges an absent first upload', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    // Managed stage sees the absence and a head that already holds the revision.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    await engine.flush(source, wire);
    expect(sent.at(-1)!.item.deleted).toBe(true);
    expect(sent.at(-1)!.previousRevision).toBe(sent.at(-2)!.item.revision);
  });
  it('re-uploads an identical file restored after a managed tombstone', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    // A repeated absent scan must not queue another deletion from the same entry.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    await engine.flush(source, wire);
    const tombstone = sent.at(-1)!.item;
    expect(tombstone.deleted).toBe(true);
    // The same bytes return: the identity must queue again instead of staying deleted.
    expect(await engine.stage(scan([fileItem]), true)).toBe(1);
    await engine.flush(source, wire);
    expect(sent.at(-1)!.item.deleted).toBe(false);
    expect(sent.at(-1)!.item.revision).not.toBe(tombstone.revision);
  });
  it('cancels the pending deletion when the file returns before the acknowledgement', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    // The same file comes back unchanged before the retry is acknowledged.
    expect(await engine.stage(scan([fileItem]), true)).toBe(0);
    // The cancellation is durable: a restart must not resurrect the tombstone.
    const reopened = await create();
    await reopened.flush(source, wire);
    expect(sent.every(entry => !entry.item.deleted)).toBe(true);
    expect(reopened.status().pending).toBe(0);
  });
  it('never marks a deletion from an incomplete scan', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    // An incomplete scan cannot prove absence, so no pending deletion is set.
    await engine.stage(scan([], false), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    await engine.flush(source, wire);
    expect(sent.every(entry => !entry.item.deleted)).toBe(true);
  });
  it('withdraws a precommit update on the managed path when the head is its predecessor', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let attempts = 0;
    const wire = fileTransport(sent, () => (++attempts === 2 ? 1 : 0), true);
    await engine.stage(scan([fileItem]), false);
    await engine.flush(source, wire);
    const acknowledged = sent.at(-1)!.item;
    await engine.stage(scan([{ ...fileItem, text: 'update B' }]), false);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    const uploaded = sent.length;
    // Managed stage: the head still equals the acknowledged predecessor A.
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => acknowledged.revision);
    expect(engine.status().pending).toBe(0);
    await engine.flush(source, wire);
    expect(sent).toHaveLength(uploaded);
  });
  it('keeps recovery state while an upload is still in flight', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      if (path === '/api/file-sync/v1/manifests') {
        entered = true; await gate;
        sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
        throw new Error('ACK loss');
      }
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), true);
    const flushing = engine.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    // Absence scan while the commit request may still land.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => null);
    expect(engine.status().pending).toBe(1);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
  });
  it('keeps the new revision when a changed file returns and clears the pending deletion', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    // The file returns with changed content: it must queue the new revision
    // without losing it to the stale known record.
    expect(await engine.stage(scan([{ ...fileItem, text: 'changed after return' }]), true)).toBe(1);
    await engine.flush(source, wire);
    expect(sent.every(entry => !entry.item.deleted)).toBe(true);
    // The following scan must not queue the same upload again.
    expect(await engine.stage(scan([{ ...fileItem, text: 'changed after return' }]), true)).toBe(0);
  });
  it('keeps a first upload that is in flight before its predecessor is persisted', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let capabilityEntered = false, lostAck = true;
    const wire = fileTransport(sent, () => (lostAck ? 1 : 0));
    const gated = async (path: string, body: any) => {
      if (path === '/api/file-sync/v1/capabilities') { capabilityEntered = true; await gate; }
      return wire(path, body);
    };
    await engine.stage(scan([fileItem]), true);
    const flushing = engine.flush(source, gated as any).catch(error => error);
    while (!capabilityEntered) await new Promise(resolve => setTimeout(resolve, 5));
    // Absence arrives while capabilities (and therefore the predecessor write)
    // are still pending: the selected upload must stay queued.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => null);
    expect(engine.status().pending).toBe(1);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
    // The acknowledgement then completes the promised deletion.
    lostAck = false;
    await engine.flush(source, wire);
    expect(sent.at(-1)!.item.deleted).toBe(true);
  });
  it('defers a deletion until a history-queue update is acknowledged', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let failOnce = false;
    const wire = fileTransport(sent, () => (failOnce ? ((failOnce = false), 1) : 0));
    await engine.stage(scan([fileItem]), true);
    await engine.flush(source, wire);
    failOnce = true;
    await engine.stage(scan([{ ...fileItem, text: 'history update B' }]), true, undefined, 'all', 'history');
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    const update = sent.at(-1)!.item;
    // Managed absence: the head already holds B, so no tombstone may chain from A.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => update.revision);
    const before = sent.length;
    await engine.flush(source, wire);
    expect(engine.status().pending).toBe(0);
    const tombstone = sent.slice(before).find(entry => entry.item.deleted);
    expect(tombstone).toBeDefined();
    expect(tombstone!.previousRevision).toBe(update.revision);
  });
  it('keeps the staged revision when a changed file returns and cancels deletion', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let firstFailure = true;
    const wire = fileTransport(sent, () => { if (firstFailure) { firstFailure = false; return 1; } return 0; });
    await engine.stage(scan([fileItem]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => sent.at(-1)!.item.revision);
    const changed = { ...fileItem, text: 'changed content after return' };
    expect(await engine.stage(scan([changed]), true)).toBe(1);
    await engine.flush(source, wire);
    const uploaded = sent.at(-1)!.item;
    // Restart keeps B as the known revision; another identical scan queues nothing.
    const reopened = await create();
    expect(await reopened.stage(scan([changed]), true)).toBe(0);
    const state = sourceState(join(directory, 'state.json')) as any;
    const knownEntry = Object.values(state.known as Record<string, any>).find(value => value.item.externalId === changed.externalId);
    expect(knownEntry?.revision).toBe(uploaded.revision);
  });
  it('withdraws a removed file whose preflight request failed', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') {
        entered = true; await gate;
        if (!preflightFailed) { preflightFailed = true; throw new Error('capabilities failed'); }
        return { manifestBatch: 200 };
      }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      if (path === '/api/file-sync/v1/manifests') { sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null }))); throw new Error('ACK loss'); }
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), false);
    const flushing = engine.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    // Absence is observed while the preflight request is still pending.
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => null);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
    // The preflight never committed: the next flush must withdraw, not publish.
    await engine.flush(source, wire);
    expect(engine.status().pending).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it('stages the acknowledged deletion in the same scan that withdraws an unattempted update', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    const wire = fileTransport(sent);
    await engine.stage(scan([fileItem]), true);
    await engine.flush(source, wire);
    await engine.stage(scan([{ ...fileItem, text: 'queued but never sent' }]), true);
    // Complete absence withdraws the unattempted update; the deletion of the
    // acknowledged revision must be staged in this same pass.
    await engine.stage(scan([]), true);
    const state = sourceState(join(directory, 'state.json')) as any;
    const queued = [...state.pendingRealtime, ...state.pendingHistory];
    expect(queued.some((entry: SourceItem) => entry.deleted)).toBe(true);
    const before = sent.length;
    await engine.flush(source, wire);
    const deletion = sent.slice(before).find(entry => entry.item.deleted);
    expect(deletion).toBeDefined();
    expect(engine.status().pending).toBe(0);
  });
  it('tombstones the acknowledged base in the same cycle after a precommit update is withdrawn', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let attempts = 0;
    const wire = fileTransport(sent, () => (++attempts === 2 ? 1 : 0), true);
    await engine.stage(scan([fileItem]), true);
    await engine.flush(source, wire);
    const acknowledged = sent.at(-1)!.item;
    await engine.stage(scan([{ ...fileItem, text: 'update B fails precommit' }]), true);
    await expect(engine.flush(source, wire)).rejects.toThrow('ACK loss');
    // Head still equals A: the managed stage withdraws B and must stage A's
    // deletion in the same cycle.
    await engine.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => acknowledged.revision);
    const uploaded = sent.length;
    await engine.flush(source, wire);
    const sentNow = sent.slice(uploaded);
    expect(sentNow.some(entry => entry.item.revision && !entry.item.deleted)).toBe(false);
    const deletion = sentNow.find(entry => entry.item.deleted);
    expect(deletion).toBeDefined();
    expect(deletion!.previousRevision).toBe(acknowledged.revision);
    expect(engine.status().pending).toBe(0);
  });
  it('uploads a returned file after a preflight failure cleared the absence flag', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') {
        entered = true; await gate;
        if (!preflightFailed) { preflightFailed = true; throw new Error('capabilities failed'); }
        return { manifestBatch: 200 };
      }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      if (path === '/api/file-sync/v1/manifests') { sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null }))); return { results: body.items.map((manifest: any) => ({ externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, 'file-revision') })) }; }
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), false);
    const flushing = engine.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    // Absence observed while preflight is pending, then the preflight fails.
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => null);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
    // The unchanged file returns before the retry: the absence flag must clear.
    expect(await engine.stage(scan([fileItem]), false)).toBe(0);
    const reopened = await create();
    await reopened.flush(source, wire as any);
    expect(sent).toHaveLength(1);
    expect(sent[0].item.deleted).toBe(false);
    expect(reopened.status().pending).toBe(0);
  });
  it('withdraws an in-flight update when the head still equals its predecessor', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), false);
    await engine.flush(source, fileTransport(sent));
    const acknowledged = sent.at(-1)!.item;
    // Fresh engine so the manifest capability is resolved inside the gated flush.
    const reopened = await create();
    await reopened.stage(scan([{ ...fileItem, text: 'update B' }]), false);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; entered = true; await gate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: acknowledged.revision };
      if (path === '/api/file-sync/v1/manifests') { sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null }))); throw new Error('ACK loss'); }
      throw new Error('unexpected ' + path);
    };
    const flushing = reopened.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    await reopened.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => acknowledged.revision);
    release();
    await flushing;
    expect(reopened.status().pending).toBe(1);
    const before = sent.length;
    await reopened.flush(source, wire as any);
    expect(reopened.status().pending).toBe(0);
    expect(sent).toHaveLength(before);
  });
  it('tombstones the acknowledged base when an in-flight update never committed', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), true);
    await engine.flush(source, fileTransport(sent));
    const acknowledged = sent.at(-1)!.item;
    const reopened = await create();
    await reopened.stage(scan([{ ...fileItem, text: 'update B' }]), true);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; entered = true; await gate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: acknowledged.revision };
      if (path === '/api/file-sync/v1/manifests') {
        sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
        if (body.items.some((manifest: any) => !manifest.item.deleted)) throw new Error('ACK loss');
        return { results: body.items.map((manifest: any) => ({ externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, 'file-revision') })) };
      }
      throw new Error('unexpected ' + path);
    };
    const flushing = reopened.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    await reopened.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => acknowledged.revision);
    release();
    await flushing;
    const before = sent.length;
    await reopened.flush(source, wire as any);
    const now = sent.slice(before);
    expect(now.some(entry => !entry.item.deleted)).toBe(false);
    const deletion = now.find(entry => entry.item.deleted);
    expect(deletion).toBeDefined();
    expect(deletion!.previousRevision).toBe(acknowledged.revision);
    expect(reopened.status().pending).toBe(0);
  });
  it('keeps the file when it returns while the reconciliation head is pending', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let releaseCaps!: () => void; const capsGate = new Promise<void>(resolve => { releaseCaps = resolve; });
    let capsEntered = false, preflightFailed = false;
    const gatedCaps = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; capsEntered = true; await capsGate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), false);
    const first = engine.flush(source, gatedCaps as any).catch(error => error);
    while (!capsEntered) await new Promise(resolve => setTimeout(resolve, 5));
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => null);
    releaseCaps();
    await first;
    expect(engine.status().pending).toBe(1);
    // The file returns while the reconciliation head request is pending.
    let releaseHead!: () => void; const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
    let headEntered = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
      if (path.startsWith('/api/file-sync/v1/head')) { headEntered = true; await headGate; return { revision: null }; }
      if (path === '/api/file-sync/v1/manifests') {
        sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
        return { results: body.items.map((manifest: any) => ({ externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, 'file-revision') })) };
      }
      throw new Error('unexpected ' + path);
    };
    const flushing = engine.flush(source, wire as any).catch(error => error);
    while (!headEntered) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await engine.stage(scan([fileItem]), false)).toBe(0);
    releaseHead();
    await flushing;
    expect(sent).toHaveLength(1);
    expect(sent[0].item.deleted).toBe(false);
    expect(engine.status().pending).toBe(0);
  });
  it('keeps a newer revision when the file returns during an update reconciliation head', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    await engine.stage(scan([fileItem]), true);
    await engine.flush(source, fileTransport(sent));
    const acknowledged = sent.at(-1)!.item;
    const reopened = await create();
    await reopened.stage(scan([{ ...fileItem, text: 'update B' }]), true);
    let releaseCaps!: () => void; const capsGate = new Promise<void>(resolve => { releaseCaps = resolve; });
    let capsEntered = false, preflightFailed = false;
    const gatedCaps = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; capsEntered = true; await capsGate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: acknowledged.revision };
      throw new Error('unexpected ' + path);
    };
    const first = reopened.flush(source, gatedCaps as any).catch(error => error);
    while (!capsEntered) await new Promise(resolve => setTimeout(resolve, 5));
    await reopened.stage(scan([]), true, undefined, 'all', 'realtime', false, async () => acknowledged.revision);
    releaseCaps();
    await first;
    expect(reopened.status().pending).toBe(1);
    // The file returns with NEW content while the reconciliation head is pending.
    let releaseHead!: () => void; const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
    let headEntered = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
      if (path.startsWith('/api/file-sync/v1/head')) { headEntered = true; await headGate; return { revision: acknowledged.revision }; }
      if (path === '/api/file-sync/v1/manifests') {
        sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
        return { results: body.items.map((manifest: any) => ({ externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, 'file-revision') })) };
      }
      throw new Error('unexpected ' + path);
    };
    const flushing = reopened.flush(source, wire as any).catch(error => error);
    while (!headEntered) await new Promise(resolve => setTimeout(resolve, 5));
    const changed = { ...fileItem, text: 'revision C after return' };
    expect(await reopened.stage(scan([changed]), true)).toBe(1);
    releaseHead();
    await flushing;
    expect(sent.every(entry => !entry.item.deleted)).toBe(true);
    const uploads = sent.filter(entry => !entry.item.deleted);
    const latest = uploads.at(-1)!;
    // Whatever revision is accepted last must chain from the accepted head and
    // the durable known entry must describe it.
    expect(latest.previousRevision).toBe(uploads.at(-2)!.item.revision);
    const state = sourceState(join(directory, 'state.json')) as any;
    const knownEntry = Object.values(state.known as Record<string, any>).find(value => value.item.externalId === changed.externalId);
    expect(knownEntry?.revision).toBe(latest.item.revision);
    expect(reopened.status().pending).toBe(0);
  });
  it('withdraws an older in-flight revision whose queued successor was withdrawn', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; entered = true; await gate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      if (path === '/api/file-sync/v1/manifests') { sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null }))); throw new Error('ACK loss'); }
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), false);
    const flushing = engine.flush(source, wire as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    // A changed revision is staged while the first upload is in flight, so the
    // known entry's revision is no longer the queued revision.
    await engine.stage(scan([{ ...fileItem, text: 'changed while uploading' }]), false);
    // Complete absence: the in-flight revision stays, the newer queued one goes.
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => null);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
    await engine.flush(source, wire as any);
    expect(engine.status().pending).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it('yields the slice instead of swallowing slice control during reconciliation', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    // Produce an absent in-flight candidate through the real path.
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, preflightFailed = false;
    const gated = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') { if (preflightFailed) return { manifestBatch: 200 }; preflightFailed = true; entered = true; await gate; throw new Error('capabilities failed'); }
      if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
      throw new Error('unexpected ' + path);
    };
    await engine.stage(scan([fileItem]), false);
    const flushing = engine.flush(source, gated as any).catch(error => error);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    await engine.stage(scan([]), false, undefined, 'all', 'realtime', false, async () => null);
    release();
    await flushing;
    expect(engine.status().pending).toBe(1);
    // The head read yields the slice; flushSlice must surface that, not drop it.
    const { UploadSliceYield } = await import('../src/upload-slice');
    const sliceWire = async (path: string) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path.startsWith('/api/file-sync/v1/head')) throw new UploadSliceYield();
      return { manifestBatch: 200 };
    };
    const slice = await engine.flushSlice(source, sliceWire as any, undefined);
    expect(slice.state).toBe('yielded');
    expect(engine.status().pending).toBe(1);
    expect(sent).toHaveLength(0);
  });
  it('makes progress with more absent candidates than a slice request budget', async () => {
    const engine = await create(), sent: { item: SourceItem; previousRevision: string | null }[] = [];
    const items = Array.from({ length: 100 }, (_, index) => ({ ...fileItem, externalId: `file:generated-${index}`, title: `file-${index}` }));
    await engine.stage(scan(items), false);
    expect(engine.status().pending).toBe(100);
    // Mark every identity as observed absent while its upload was in flight.
    const state = sourceState(join(directory, 'state.json')) as any;
    const patches = items.map(item => ({ section: 'known' as const, key: sourceHash(item.externalId), value: { ...state.known[sourceHash(item.externalId)], absentWhileInflight: state.known[sourceHash(item.externalId)].revision } }));
    sourceState(join(directory, 'state.json'), patches);
    const reopened = await create();
    let heads = 0;
    const wire = async (path: string, body: any) => {
      if (path === '/api/sources') return { ...source, enabled: true };
      if (path === '/api/file-sync/v1/capabilities') return { manifestBatch: 200 };
      if (path.startsWith('/api/file-sync/v1/head')) { heads++; throw new Error('head unavailable'); }
      if (path === '/api/file-sync/v1/manifests') {
        sent.push(...body.items.map((manifest: any) => ({ item: manifest.item, previousRevision: manifest.previousRevision ?? null })));
        return { results: body.items.map((manifest: any) => ({ externalId: manifest.item.externalId, revision: manifest.item.revision, state: 'accepted', ack: sourceAck(source.id, manifest.item, 'file-revision') })) };
      }
      throw new Error('unexpected ' + path);
    };
    const slice = await reopened.flushSlice(source, wire as any, undefined);
    // Bounded head work, yet the slice still reaches its uploads.
    expect(heads).toBeLessThanOrEqual(8);
    expect(sent.length).toBeGreaterThan(0);
    expect(['ready', 'yielded']).toContain(slice.state);
    const remaining = reopened.status().pending;
    expect(remaining).toBeLessThan(100);
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
