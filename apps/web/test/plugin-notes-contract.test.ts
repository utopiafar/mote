import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {noteSchema,type NoteInput} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import {ApiError,type Api} from '../src/api.js';
import {createNotesController} from '../src/plugins/notes/controller.js';
import {NoteOutbox,type NoteStorage} from '../src/plugins/notes/notes-state.js';

class MemoryStorage implements NoteStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}

async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-notes-contract-'));
  const token = 'generated-plugin-notes-' + randomUUID();
  const node = await buildApp({
    dataDir: join(directory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated Notes contract fixture'); }, close: async () => {}},
  });
  t.after(async () => { await node.app.close(); rmSync(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); });
  return {node, token, headers: {authorization: 'Bearer ' + token}};
}

interface RecordedRequest {path: string; method: string; body?: string}

function apiFor(node: Awaited<ReturnType<typeof buildApp>>, token: string, afterResponse?: (request: RecordedRequest) => void) {
  const calls: RecordedRequest[] = [];
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + token);
    let payload: string | Buffer | undefined;
    if (typeof init.body === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      payload = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      payload = Buffer.from(init.body);
    } else if (ArrayBuffer.isView(init.body)) {
      payload = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    }
    const call = {path, method, ...(typeof payload === 'string' ? {body: payload} : {})};
    calls.push(call);
    const response = await node.app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: path,
      headers: Object.fromEntries(headers),
      ...(payload !== undefined ? {payload} : {}),
    });
    if (response.statusCode >= 400) throw new ApiError(response.body || `HTTP ${response.statusCode}`, response.statusCode);
    afterResponse?.(call);
    return (response.body ? JSON.parse(response.body) : undefined) as T;
  };
  return {api: {request} as Api, calls};
}

const notes = async (node: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) => {
  const response = await node.app.inject({url: '/api/notes?limit=30', headers});
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {items: Array<{id: string}>};
};

test('real server round-trip preserves original, description, owner addition and attachment identity', async t => {
  const {node, token, headers} = await fixture(t);
  const {api} = apiFor(node, token);
  const storage = new MemoryStorage();
  const namespace = 'generated-notes-contract-node';
  const attachmentBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 71, 69, 78]);
  const controller = createNotesController({
    api, namespace, storage, composerOnly: true,
    deviceId: 'generated-notes-contract-device',
    createId: () => randomUUID(),
    now: () => new Date('2026-11-04T02:00:00.000Z'),
  });
  controller.start();
  t.after(() => controller.dispose());
  try {
    const description = '  Generated owner description, kept separate from the original.  ';
    const addition = 'Generated owner addition.';
    const quoted = 'Generated quoted original from the saved conversation.';
    controller.updateDraft({text: addition, mood: '', description});
    await controller.addAttachments([new File([attachmentBytes], 'generated-note-attachment.png', {type: 'image/png', lastModified: Date.parse('2026-11-04T01:00:00.000Z')})]);
    const attachment = controller.getSnapshot().draft.attachments?.[0];
    assert.ok(attachment, 'the real attachment queue produced an identity');

    const prepared = new NoteOutbox(storage, namespace).prepareSubmission(controller.getSnapshot().draft, {
      id: randomUUID(), deviceId: 'generated-notes-contract-device', deviceName: 'Generated Notes contract',
      platform: 'import', client: 'web', capturedAt: '2026-11-04T02:00:00.000Z',
    });
    const serialized = noteSchema.parse({
      ...prepared,
      metadata: {
        ...prepared.metadata,
        noteOrigin: {kind: 'conversation', conversationId: randomUUID(), messageIds: [randomUUID()], text: quoted},
      },
    }) as NoteInput;
    await controller.submit(serialized);
    assert.equal(controller.getSnapshot().queued.length, 0);

    const readResponse = await node.app.inject({url: '/api/notes/' + serialized.id, headers});
    assert.equal(readResponse.statusCode, 200, readResponse.body);
    const read = readResponse.json();
    assert.equal(read.id, serialized.id);
    assert.equal(read.ocrText, addition);
    assert.equal(read.metadata.noteOrigin.text, quoted);
    assert.deepEqual(read.metadata.attachments, [attachment]);
    assert.equal(read.attributionContext.recordContextStatements[0].description, description);
    assert.equal(read.metadata.ownerDescription, undefined, 'description never leaks into the default metadata');
  } finally {
    controller.dispose();
  }
});

test('a lost save ACK keeps the same operation body until an explicit retry, without a duplicate note', async t => {
  const {node, token, headers} = await fixture(t);
  let lose = true;
  const {api, calls} = apiFor(node, token, request => {
    if (lose && request.method === 'POST' && request.path === '/api/notes') {
      lose = false;
      throw new TypeError('Generated committed note with lost ACK');
    }
  });
  const controller = createNotesController({
    api, namespace: 'generated-notes-lost-ack', storage: new MemoryStorage(), composerOnly: true,
    deviceId: 'generated-notes-lost-ack-device',
    createId: () => randomUUID(),
    now: () => new Date('2026-11-04T03:00:00.000Z'),
  });
  controller.start();
  t.after(() => controller.dispose());
  try {
    controller.updateDraft({text: 'Generated note survives a lost acknowledgement.', mood: '', description: 'Generated immutable description.'});
    const saved = controller.save();
    assert.ok(saved);
    await controller.syncNow();
    const pending = controller.getSnapshot().queued;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].unknown, true);
    assert.equal(pending[0].note.id, saved.id);
    const posts = calls.filter(call => call.method === 'POST' && call.path === '/api/notes');
    assert.equal(posts.length, 1);
    assert.deepEqual((await notes(node, headers)).items.map(item => item.id), [saved.id], 'the server committed before the ACK was lost');

    await controller.syncNow();
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/api/notes').length, 1, 'background sync never replays an unknown ACK');

    await controller.retry();
    const retried = calls.filter(call => call.method === 'POST' && call.path === '/api/notes');
    assert.equal(retried.length, 2, 'explicit retry sends the same request again');
    assert.equal(retried[1].body, retried[0].body, 'operation ID and body stay byte-identical');
    assert.equal(JSON.parse(retried[1].body!).id, saved.id);
    assert.equal(controller.getSnapshot().queued.length, 0);
    assert.deepEqual((await notes(node, headers)).items.map(item => item.id), [saved.id], 'idempotent retry never creates a second note');
  } finally {
    controller.dispose();
  }
});
