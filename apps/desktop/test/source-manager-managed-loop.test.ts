import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { builtInSourceAdapters, SourceAdapterRegistry } from '../src/source-adapters';
import { LocalSourceManager } from '../src/source-manager';
import { sourceHash } from '../src/source-sync';
import { DEFAULT_SOURCE_OPTIONS, type ScannedItem } from '../src/source-types';
import { sourceAck } from './fixtures';

let directory: string;
const managers: LocalSourceManager[] = [];
const connection = { serverUrl: 'http://127.0.0.1:9', token: 'generated-managed-token', deviceId: '98ca7a5b-62f4-4273-889c-dfcb9b13d608' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
const generatedFile = (externalId: string, text: string): ScannedItem => ({ externalId, title: externalId, text, kind: 'file', layer: 'snapshot', deleted: false,
  document: { fileIndex: { version: 1, fileId: externalId, contentVersion: sourceHash(text), mode: 'index', parser: 'generated-index', coverage: 'full', status: 'ready', totalCharacters: text.length, offset: 0, length: text.length, allowRead: false } } });

type Request = { path: string; method: string; url: URL; body: any };
function transport(handler: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [], unmatched: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | globalThis.Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(connection.serverUrl);
    const request = { url, path: url.pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(await new Response(init.body).text()) : undefined };
    requests.push(request);
    return handler(request);
  });
  return {
    requests, unmatched,
    reject(request: Request) { unmatched.push(request.method + ' ' + request.path); return response(500, { error: 'Unmatched generated route' }); },
    writes: () => requests.filter(request => request.method !== 'GET' && request.path !== '/api/sources' && !/^\/api\/sources\/local-[a-f0-9-]{36}$/.test(request.path)),
  };
}

async function openManaged(adapters: SourceAdapterRegistry) {
  const app = new LocalSourceManager(join(directory, 'sources'), connection, '/must-not-be-invoked-helper', true, undefined, adapters);
  // This test owns scan/gate order; native watcher delivery has separate coverage.
  vi.spyOn((app as any).watcher, 'setTargets').mockResolvedValue(undefined);
  managers.push(app); await app.initialize(); return app;
}
async function restart(app: LocalSourceManager, adapters: SourceAdapterRegistry) {
  await app.close(); managers.splice(managers.indexOf(app), 1);
  const reopened = await openManaged(adapters);
  // initialize schedules its scan; flushPending may legitimately skip an unread
  // source until that real scan validates access. Join it through the public API.
  await reopened.sync(true);
  return reopened;
}
async function markerCount(sourceId: string) {
  const files = await readdir(directory, { recursive: true });
  const matches = files.filter(entry => entry.endsWith(sourceId + '.json.sqlite'));
  expect(matches).toHaveLength(1);
  const db = new DatabaseSync(join(directory, matches[0]!), { readOnly: true });
  try {
    const rows = db.prepare("SELECT value FROM entries WHERE section='known'").all() as { value: Uint8Array }[];
    return rows.filter(row => Boolean(JSON.parse(Buffer.from(row.value).toString('utf8')).absentWhileInflight)).length;
  } finally { db.close(); }
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-managed-loop-')));
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(async () => {
  for (const manager of managers) await manager.close();
  managers.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('restores producer-marked absence and bounds the real managed loop before head recovery makes progress', async () => {
  let present = true;
  const ids = Array.from({ length: 12 }, (_, index) => `file:managed-${index}`);
  const scans: { items: number; seen: string[]; complete: boolean }[] = [];
  const adapters = new SourceAdapterRegistry().register({
    kind: 'local-files', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false,
    validateConfiguration() {},
    async scan() {
      const items: ScannedItem[] = present ? ids.map((externalId, index) => {
        const text = `body ${index}`;
        return { externalId, title: `managed-${index}`, text, kind: 'file', layer: 'snapshot', deleted: false,
          document: { fileIndex: { version: 1, fileId: externalId, contentVersion: sourceHash(text), mode: 'index', parser: 'generated-index', coverage: 'full', status: 'ready', totalCharacters: text.length, offset: 0, length: text.length, allowRead: false } } };
      }) : [];
      const seen = items.map(item => item.externalId); scans.push({ items: items.length, seen, complete: true });
      return { version: 1, scan: { items, seen, complete: true, skipped: 0 } };
    },
  });
  let sourceId = '', firstCaps = true, headMode: 'error' | 'null' = 'error', clock: number | undefined;
  const entered = deferred(), release = deferred();
  const wire = transport(request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/capabilities') {
      if (firstCaps) { firstCaps = false; entered.resolve(); return release.promise.then(() => response(500, { error: 'Generated preflight failure' })); }
      return response(200, { manifestBatch: 200 });
    }
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId);
      expect(ids).toContain(request.url.searchParams.get('externalId'));
      if (clock !== undefined) clock += 15001;
      return headMode === 'error' ? response(503, { error: 'Generated unavailable head' }) : response(200, { revision: null });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters);
    sourceId = await app.addAdapterSource({ kind: 'local-files', name: 'Generated managed' }, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: true, syncContinuously: true });
    await app.sync(true); expect(app.status()[0]!.pending).toBe(12);
    flushing = app.flushPending(new AbortController().signal); const failed = expect(flushing).rejects.toBeInstanceOf(Error);
    await entered.promise;
    const scansAtGate = scans.length; present = false; await app.sync(true);
    expect(scans.length).toBe(scansAtGate + 1); expect(scans.at(-1)).toEqual({ items: 0, seen: [], complete: true });
    expect(app.status()[0]!.pending).toBe(12); expect(await markerCount(sourceId)).toBe(12);
    release.resolve(); await failed;
    expect(wire.writes()).toHaveLength(0); expect(app.status()[0]!.pending).toBe(12);

    const reopened = await restart(app, adapters);
    expect(reopened.status()[0]!.pending).toBe(12); expect(await markerCount(sourceId)).toBe(12);
    const flush = async () => {
      const start = wire.requests.length; let slices = 0;
      await expect(reopened.flushPending(new AbortController().signal, async () => { slices++; })).resolves.toBeUndefined();
      expect(slices).toBe(1); // ready with unknown work must not immediately requeue.
      return wire.requests.slice(start).filter(request => request.path === '/api/file-sync/v1/head');
    };
    expect(await flush()).toHaveLength(8); expect(reopened.status()[0]!.pending).toBe(12); expect(wire.writes()).toHaveLength(0);
    // Exercise the real UploadSlice clock without waiting15s or replacing flushSlice.
    clock = Date.now(); const now = vi.spyOn(Date, 'now').mockImplementation(() => clock!);
    try { expect(await flush()).toHaveLength(1); } finally { now.mockRestore(); clock = undefined; }
    expect(reopened.status()[0]!.pending).toBe(12); expect(wire.writes()).toHaveLength(0);
    headMode = 'null'; expect(await flush()).toHaveLength(8); expect(reopened.status()[0]!.pending).toBe(4);
    expect(await flush()).toHaveLength(4); expect(reopened.status()[0]!.pending).toBe(0);
    expect(wire.writes()).toHaveLength(0); expect(wire.unmatched).toEqual([]);
  } finally { release.resolve(); await flushing?.catch(() => {}); }
});

it('keeps a real scanner spool across unknown heads and restart, then withdraws only after an explicit null head', async () => {
  const selected = join(directory, 'selected'); await mkdir(selected);
  const file = join(selected, 'generated.txt'), bytes = Buffer.from('Generated immutable source body'); await writeFile(file, bytes);
  const adapters = builtInSourceAdapters(), entered = deferred(), release = deferred();
  let sourceId = '', firstHead = true, headMode: 'error' | 'null' = 'error';
  const wire = transport(request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId);
      if (firstHead) { firstHead = false; entered.resolve(); return release.promise.then(() => response(503, { error: 'Generated preflight failure' })); }
      return headMode === 'error' ? response(503, { error: 'Generated unavailable head' }) : response(200, { revision: null });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters); sourceId = await app.addFiles(selected, { ...DEFAULT_SOURCE_OPTIONS, syncContinuously: true }); await app.sync(true);
    const queued = app.pendingContent()[0]!.item, spool = queued.localOriginal!; expect(spool).toBeDefined(); expect(await readFile(join(spool.directory, '0'))).toEqual(bytes);
    flushing = app.flushPending(new AbortController().signal); const failed = expect(flushing).rejects.toBeInstanceOf(Error); await entered.promise;
    await rm(file); await app.sync(true); expect(await markerCount(sourceId)).toBe(1); release.resolve(); await failed;
    const reopened = await restart(app, adapters); expect(reopened.status()[0]!.pending).toBe(1); expect(await markerCount(sourceId)).toBe(1);
    expect(reopened.pendingContent()[0]!.item.revision).toBe(queued.revision); expect(reopened.pendingContent()[0]!.item.localOriginal).toEqual(spool);
    expect(await readFile(join(spool.directory, '0'))).toEqual(bytes);
    const before = wire.requests.length; await expect(reopened.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(wire.requests.slice(before).filter(request => request.path === '/api/file-sync/v1/head')).toHaveLength(1);
    expect(reopened.status()[0]!.pending).toBe(1); expect(await readFile(join(spool.directory, '0'))).toEqual(bytes); expect(wire.writes()).toHaveLength(0);
    headMode = 'null'; await expect(reopened.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(reopened.status()[0]!.pending).toBe(0); expect(existsSync(spool.directory)).toBe(false); expect(wire.writes()).toHaveLength(0); expect(wire.unmatched).toEqual([]);
  } finally { release.resolve(); await flushing?.catch(() => {}); }
});

it('protects both attempted revisions of an absent identity across history, realtime and restart until heads recover', async () => {
  let text: string | undefined = 'generated A';
  const externalId = 'file:managed-two-revisions', scans: (string | undefined)[] = [];
  const adapters = new SourceAdapterRegistry().register({
    kind: 'local-files', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false,
    validateConfiguration() {},
    async scan() {
      scans.push(text);
      const items: ScannedItem[] = text === undefined ? [] : [{ externalId, title: 'generated', text, kind: 'file', layer: 'snapshot', deleted: false,
        document: { fileIndex: { version: 1, fileId: externalId, contentVersion: sourceHash(text), mode: 'index', parser: 'generated-index', coverage: 'full', status: 'ready', totalCharacters: text.length, offset: 0, length: text.length, allowRead: false } } }];
      return { version: 1, scan: { items, seen: items.map(item => item.externalId), complete: true, skipped: 0 } };
    },
  });
  let sourceId = '', failWrites = true, headMode: 'error' | 'null' = 'error';
  const attempts: { revision: string; text: string }[] = [], entered = deferred(), release = deferred();
  let gateWrite = false;
  const wire = transport(async request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/capabilities') return response(200, { manifestBatch: 200 });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId); expect(request.url.searchParams.get('externalId')).toBe(externalId);
      return headMode === 'error' ? response(503, { error: 'Generated unavailable head' }) : response(200, { revision: null });
    }
    if (request.method === 'POST' && request.path === '/api/file-sync/v1/manifests') {
      expect(request.body.items).toHaveLength(1);
      const item = request.body.items[0].item; attempts.push({ revision: item.revision, text: item.text });
      if (gateWrite) { gateWrite = false; entered.resolve(); await release.promise; }
      if (failWrites) return response(503, { error: 'Generated precommit failure' });
      return response(200, { results: [{ externalId, revision: item.revision, state: 'accepted', ack: sourceAck(sourceId, item, 'file-revision') }] });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters);
    sourceId = await app.addAdapterSource({ kind: 'local-files', name: 'Generated two revisions' }, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: false, syncContinuously: true });
    await app.sync(true);
    await expect(app.flushPending(new AbortController().signal)).rejects.toMatchObject({ httpStatus: 503 });
    expect(attempts.map(item => item.text)).toEqual(['generated A']);
    text = 'generated B'; await app.sync(true);
    expect(app.status()[0]).toMatchObject({ pending: 2, historyPending: 1, realtimePending: 1 });
    // The second attempted revision is realtime; A remains in history. Hold
    // its real write so the complete absence producer runs at a known point.
    gateWrite = true; flushing = app.flushPending(new AbortController().signal); const failed = expect(flushing).rejects.toBeInstanceOf(Error); await entered.promise;
    expect(attempts.map(item => item.text)).toEqual(['generated A', 'generated B']);
    text = undefined; const beforeScan = scans.length; await app.sync(true);
    expect(scans.length).toBe(beforeScan + 1); expect(scans.at(-1)).toBeUndefined();
    expect(await markerCount(sourceId)).toBe(1); release.resolve(); await failed;
    expect(app.status()[0]!.pending).toBe(2);
    // All later writes would be accepted, making any blind publication visible.
    failWrites = false;
    const reopened = await restart(app, adapters);
    expect(reopened.status()[0]!.pending).toBe(2); expect(await markerCount(sourceId)).toBe(1);
    const start = wire.requests.length; let slices = 0;
    await expect(reopened.flushPending(new AbortController().signal, async () => { slices++; })).resolves.toBeUndefined();
    expect(attempts).toHaveLength(2); expect(reopened.status()[0]!.pending).toBe(2);
    expect(slices).toBe(1); expect(wire.requests.slice(start).filter(request => request.path === '/api/file-sync/v1/head')).toHaveLength(2);
    headMode = 'null'; await expect(reopened.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(reopened.status()[0]!.pending).toBe(0); expect(attempts).toHaveLength(2); expect(wire.unmatched).toEqual([]);
  } finally { release.resolve(); await flushing?.catch(() => {}); }
});

it.each(['history', 'realtime'] as const)('withdraws a never-sent sibling while an attempted %s revision commits with a lost ACK', async firstQueue => {
  let text: string | undefined = 'generated A';
  const externalId = 'file:managed-never-sent-sibling', entered = deferred(), release = deferred();
  const adapters = new SourceAdapterRegistry().register({
    kind: 'local-files', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false,
    validateConfiguration() {},
    async scan() {
      const items: ScannedItem[] = text === undefined ? [] : [{ externalId, title: 'generated', text, kind: 'file', layer: 'snapshot', deleted: false,
        syncQueue: text === 'generated A' ? firstQueue : firstQueue === 'history' ? 'realtime' : 'history',
        document: { fileIndex: { version: 1, fileId: externalId, contentVersion: sourceHash(text), mode: 'index', parser: 'generated-index', coverage: 'full', status: 'ready', totalCharacters: text.length, offset: 0, length: text.length, allowRead: false } } }];
      return { version: 1, scan: { items, seen: items.map(item => item.externalId), complete: true, skipped: 0 } };
    },
  });
  let sourceId = '', firstWrite = true, head: string | null = null;
  const attempts: { revision: string; text: string; deleted: boolean; previousRevision: string | null }[] = [];
  const wire = transport(async request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/capabilities') return response(200, { manifestBatch: 200 });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId); expect(request.url.searchParams.get('externalId')).toBe(externalId);
      return head === null ? response(503, { error: 'Generated head unavailable during send' }) : response(200, { revision: head });
    }
    if (request.method === 'POST' && request.path === '/api/file-sync/v1/manifests') {
      expect(request.body.items).toHaveLength(1);
      const { item, previousRevision = null } = request.body.items[0];
      attempts.push({ revision: item.revision, text: item.text, deleted: item.deleted, previousRevision });
      expect(item.text).not.toBe('generated B');
      if (firstWrite) {
        firstWrite = false; entered.resolve(); await release.promise; head = item.revision;
        return response(503, { error: 'Generated committed response loss' });
      }
      const duplicate = item.revision === head;
      if (!duplicate) expect(previousRevision).toBe(head);
      head = item.revision;
      return response(200, { results: [{ externalId, revision: item.revision, state: duplicate ? 'existing' : 'accepted', ack: sourceAck(sourceId, item, 'file-revision', duplicate) }] });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined, failed: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters);
    sourceId = await app.addAdapterSource({ kind: 'local-files', name: 'Generated unattempted sibling' }, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: true, syncContinuously: true });
    await app.sync(true);
    flushing = app.flushPending(new AbortController().signal); failed = expect(flushing).rejects.toMatchObject({ httpStatus: 503 }); await entered.promise;
    text = 'generated B'; await app.sync(true);
    expect(app.status()[0]).toMatchObject({ pending: 2, historyPending: 1, realtimePending: 1 });
    text = undefined; await app.sync(true);
    const afterAbsence = app.status()[0]!.pending;
    expect(attempts).toHaveLength(1); expect(await markerCount(sourceId)).toBe(1);
    release.resolve(); await failed;
    const reopened = await restart(app, adapters);
    await expect(reopened.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(attempts.map(item => item.deleted)).toEqual([false, false, true]);
    expect(attempts[1]!.revision).toBe(attempts[0]!.revision);
    expect(attempts[2]!.previousRevision).toBe(attempts[0]!.revision);
    const reopenedAgain = await restart(reopened, adapters);
    await expect(reopenedAgain.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(attempts).toHaveLength(3); expect(wire.unmatched).toEqual([]);
    expect(reopenedAgain.status()[0]!.pending).toBe(0); expect(afterAbsence).toBe(1);
  } finally { release.resolve(); await flushing?.catch(() => {}); await failed; }
});

it('does not publish an attempted history file newly marked absent during a successful realtime batch', async () => {
  const a = generatedFile('file:absent-during-flush', 'generated A'), c = generatedFile('file:present-during-flush', 'generated C');
  let items = [a], sourceId = '', firstWrite = true, nullHead = false;
  const entered = deferred(), release = deferred(), published: string[] = [];
  const adapters = new SourceAdapterRegistry().register({
    kind: 'local-files', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false, validateConfiguration() {},
    async scan() { return { version: 1, scan: { items, seen: items.map(item => item.externalId), complete: true, skipped: 0 } }; },
  });
  const wire = transport(async request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/capabilities') return response(200, { manifestBatch: 200 });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId); expect(request.url.searchParams.get('externalId')).toBe(a.externalId);
      return nullHead ? response(200, { revision: null }) : response(503, { error: 'Generated unavailable head' });
    }
    if (request.method === 'POST' && request.path === '/api/file-sync/v1/manifests') {
      expect(request.body.items).toHaveLength(1); const item = request.body.items[0].item;
      if (firstWrite) { firstWrite = false; expect(item.externalId).toBe(a.externalId); return response(503, { error: 'Generated precommit failure' }); }
      if (item.externalId === c.externalId) { entered.resolve(); await release.promise; }
      published.push(item.externalId);
      return response(200, { results: [{ externalId: item.externalId, revision: item.revision, state: 'accepted', ack: sourceAck(sourceId, item, 'file-revision') }] });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters);
    sourceId = await app.addAdapterSource({ kind: 'local-files', name: 'Generated mid-flush absence' }, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: false, syncContinuously: true });
    await app.sync(true); await expect(app.flushPending(new AbortController().signal)).rejects.toMatchObject({ httpStatus: 503 });
    items = [a, c]; await app.sync(true); expect(app.status()[0]).toMatchObject({ historyPending: 1, realtimePending: 1 });
    flushing = app.flushPending(new AbortController().signal); await entered.promise;
    items = [c]; await app.sync(true); expect(await markerCount(sourceId)).toBe(1);
    release.resolve(); await flushing;
    expect(published).toEqual([c.externalId]); expect(app.status()[0]!.pending).toBe(1);
    await expect(app.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(published).toEqual([c.externalId]); expect(app.status()[0]!.pending).toBe(1);
    nullHead = true; await expect(app.flushPending(new AbortController().signal)).resolves.toBeUndefined();
    expect(app.status()[0]!.pending).toBe(0); expect(published).toEqual([c.externalId]); expect(wire.unmatched).toEqual([]);
  } finally { release.resolve(); await flushing?.catch(() => {}); }
});

it('commits each resolved null head before the real managed slice budget expires on the next admission', async () => {
  const files = [0, 1, 2].map(index => generatedFile(`file:slow-head-${index}`, `generated ${index}`));
  let present = true, sourceId = '', firstCaps = true, clock: number | undefined;
  const entered = deferred(), release = deferred();
  const adapters = new SourceAdapterRegistry().register({
    kind: 'local-files', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false, validateConfiguration() {},
    async scan() { const items = present ? files : []; return { version: 1, scan: { items, seen: items.map(item => item.externalId), complete: true, skipped: 0 } }; },
  });
  const wire = transport(request => {
    if (request.method === 'POST' && request.path === '/api/sources') return response(200, { id: sourceId, enabled: true });
    if (request.method === 'PATCH' && request.path === '/api/sources/' + sourceId) return response(200, { id: sourceId });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/recovery') return response(200, { items: [] });
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/capabilities' && firstCaps) {
      firstCaps = false; entered.resolve(); return release.promise.then(() => response(503, { error: 'Generated preflight failure' }));
    }
    if (request.method === 'GET' && request.path === '/api/file-sync/v1/head') {
      expect(request.url.searchParams.get('sourceId')).toBe(sourceId);
      expect(files.map(item => item.externalId)).toContain(request.url.searchParams.get('externalId'));
      if (clock !== undefined) clock += 15001;
      return response(200, { revision: null });
    }
    return wire.reject(request);
  });
  let flushing: Promise<void> | undefined, failed: Promise<void> | undefined;
  try {
    const app = await openManaged(adapters);
    sourceId = await app.addAdapterSource({ kind: 'local-files', name: 'Generated slow head resolution' }, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: false, syncContinuously: true });
    await app.sync(true);
    flushing = app.flushPending(new AbortController().signal); failed = expect(flushing).rejects.toMatchObject({ httpStatus: 503 }); await entered.promise;
    present = false; await app.sync(true); expect(await markerCount(sourceId)).toBe(3); release.resolve(); await failed;
    clock = Date.now(); const now = vi.spyOn(Date, 'now').mockImplementation(() => clock!);
    try {
      for (const pending of [2, 1, 0]) {
        const start = wire.requests.length; let slices = 0;
        await expect(app.flushPending(new AbortController().signal, async () => { slices++; })).resolves.toBeUndefined();
        expect(slices).toBe(1); expect(wire.requests.slice(start).filter(request => request.path === '/api/file-sync/v1/head')).toHaveLength(1);
        expect(app.status()[0]!.pending).toBe(pending);
      }
    } finally { now.mockRestore(); clock = undefined; }
    expect(wire.writes()).toHaveLength(0); expect(wire.unmatched).toEqual([]);
  } finally { release.resolve(); await flushing?.catch(() => {}); await failed; }
});
