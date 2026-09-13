import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteCapture, noteSchema } from '@mote/shared';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mote-notes-test-'));
  const config: Config = { dataDir, token: 'synthetic-notes-token-never-use-in-production', tokenPath: 'fixture-only', host: '127.0.0.1', port: 47832, maxStorageBytes: 10_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '' };
  const result = await buildApp(config, { agent: { configured: false, query: async () => { throw Error('No model in protocol fixture'); }, close: async () => {} } });
  t.after(async () => { await result.app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { ...result, headers: { authorization: `Bearer ${config.token}` } };
}
const note = (changes: Record<string, unknown> = {}) => ({ id: randomUUID(), deviceId: 'synthetic-note-device', deviceName: '合成测试设备', platform: 'android', capturedAt: '2026-09-12T12:00:00.000Z', text: '  合成随手记：\n想起一件杂事，原样保存。  ', ...changes });

test('notes preserve original words and explicit mood, share capture ACKs, and remain ordinary retrievable evidence', async t => {
  const { app, store, headers } = await fixture(t);
  const input = note({ mood: '我自己标注的平静' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', payload: input })).statusCode, 401);
  const created = await app.inject({ method: 'POST', url: '/api/notes', headers, payload: input });
  assert.equal(created.statusCode, 201); assert.equal(created.json().id, input.id);
  assert.equal((await app.inject({ method: 'POST', url: '/api/captures', headers, payload: noteCapture(noteSchema.parse(input)) })).statusCode, 200);
  const saved = (await app.inject({ url: `/api/notes/${input.id}`, headers })).json();
  assert.equal(saved.source, 'note'); assert.equal(saved.durationMs, 0); assert.equal(saved.blobHash, null);
  assert.equal(saved.ocrText, input.text); assert.equal(saved.mood, input.mood);
  assert.equal(store.evidence([input.id])[0].ocrText, input.text);
  assert.deepEqual(store.search({ query: '杂事' }).map(record => record.id), [input.id]);
  assert.deepEqual(store.search({ query: '平静' }).map(record => record.id), [input.id]);
  assert.equal(store.activity().totalDurationMs, 0); assert.equal(store.activity().captures, 0);
  const archive = store.exportArchive(1_000_000);
  assert.equal(archive.captures[0].ocrText, input.text); assert.equal(archive.captures[0].mood, input.mood);
  assert.deepEqual(await store.importArchive(archive), { imported: 0, duplicates: 1 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { ...input, mood: '改动后的标签' } })).statusCode, 409);
});

test('notes listing is source-scoped and same-time pagination is complete; source routes cannot delete a screen', async t => {
  const { app, store, headers } = await fixture(t);
  const ids = new Set<string>();
  for (let i = 0; i < 4; i++) { const input = note({ text: `合成条目 ${i}`, ...(i === 0 ? { deviceId: 'other-device' } : {}) }); ids.add(input.id); await app.inject({ method: 'POST', url: '/api/notes', headers, payload: input }); }
  const screen = { ...noteCapture(noteSchema.parse(note())), id: randomUUID(), source: 'screen' };
  await store.ingest(screen);
  assert.equal((await app.inject({ url: `/api/notes/${screen.id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${screen.id}`, headers })).statusCode, 404);
  const read = new Set<string>(); let cursor: string | null = null;
  do {
    const page = (await app.inject({ url: `/api/notes?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers })).json();
    for (const record of page.items) { assert.ok(!read.has(record.id)); read.add(record.id); }
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(read, ids);
  assert.equal((await app.inject({ url: '/api/notes?deviceId=other-device', headers })).json().items.length, 1);
  assert.equal((await app.inject({ url: '/api/captures?source=note', headers })).json().items.length, 4);
  assert.equal((await app.inject({ url: '/api/notes?before=2026-09-12T11:00:00Z', headers })).json().items.length, 0);
});

test('note deletion invalidates evidence and cannot be resurrected by an offline retry; mood is never inferred', async t => {
  const { app, store, headers } = await fixture(t);
  const input = note({ text: '合成文本：焦虑、开心、待办都是本条原文，没有自动分类。' });
  await app.inject({ method: 'POST', url: '/api/notes', headers, payload: input });
  assert.equal(store.evidence([input.id])[0].mood, undefined);
  store.saveInsight({ answer: 'synthetic derived insight' }, randomUUID());
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${input.id}`, headers })).json().deleted, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${input.id}`, headers })).json().deleted, 0);
  assert.equal((await app.inject({ url: `/api/notes/${input.id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers, payload: input })).statusCode, 410);
  assert.deepEqual(store.search({ query: '合成文本' }), []); assert.equal(store.insights().length, 0);
});

test('malformed note metadata and blank text reject before storage', async t => {
  const { app, store, headers } = await fixture(t);
  for (const input of [note({ text: ' \n\t ' }), note({ mood: '  ' }), note({ mood: '长'.repeat(81) }), note({ inferredMood: 'happy' })]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers, payload: input })).statusCode, 400);
  }
  const valid = noteCapture(noteSchema.parse(note({ mood: '显式标签' })));
  for (const input of [{ ...valid, source: 'screen' }, { ...valid, durationMs: 1 }, { ...valid, imageBase64: 'AAAA', imageMime: 'image/png' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/captures', headers, payload: input })).statusCode, 400);
  }
  assert.equal(store.stats().captures, 0);
});
