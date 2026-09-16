import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLocalContent, decodeLocalContent, decryptLocalContent, encodeLocalContent, isEncryptedContent, LocalContentKeyStore, localContentPolicy } from '../src/local-content';
import { defaultConfig } from '../src/config';
import { DurableQueue, imageHash } from '../src/queue';
import { NoteDraftStore } from '../src/note-draft';
import { SourceSync } from '../src/source-sync';
import { event, image } from './fixtures';

let directory: string;
const key = Buffer.alloc(32, 73);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-content-storage-')); configureLocalContent({ enabled: false }); });
afterEach(async () => { configureLocalContent({ enabled: false }); await rm(directory, { recursive: true, force: true }); });

it('defaults to plaintext and only creates an OS-wrapped independent content key when enabled', async () => {
  const secrets = { available: () => true, encrypt: (value: string) => Buffer.from(value).map(v => v ^ 91), decrypt: (value: Buffer) => Buffer.from(value).map(v => v ^ 91).toString() };
  const store = new LocalContentKeyStore(directory, secrets);
  await store.initialize(false);
  expect(defaultConfig().localContentEncryption).toBe(false);
  expect(await readdir(directory)).toEqual([]);
  expect(encodeLocalContent(image)).toEqual(image);
  await store.setEnabled(true);
  const firstKey = localContentPolicy().key!;
  const stored = JSON.parse(await readFile(join(directory, 'content-key.json'), 'utf8'));
  expect(Buffer.from(stored.encryptedKey, 'base64').toString()).not.toContain(Buffer.from(firstKey).toString('hex'));
  const ciphertext = encodeLocalContent(image);
  configureLocalContent({ enabled: false });
  const reopened = new LocalContentKeyStore(directory, secrets); await reopened.initialize(false);
  expect(localContentPolicy().enabled).toBe(false);
  expect(decodeLocalContent(ciphertext)).toEqual(image);
  expect(localContentPolicy().key).toEqual(firstKey);
  expect(encodeLocalContent(image)).toEqual(image);
});

it('authenticates encrypted content and never treats failed decryption as plaintext', () => {
  configureLocalContent({ enabled: true, key });
  const encrypted = encodeLocalContent('generated sensitive text');
  expect(isEncryptedContent(encrypted)).toBe(true);
  expect(encrypted.includes(Buffer.from('generated sensitive text'))).toBe(false);
  expect(() => decodeLocalContent(encrypted, { enabled: false })).toThrow('密钥不可用');
  expect(() => decodeLocalContent(encrypted, { enabled: false, key: Buffer.alloc(32) })).toThrow();
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1;
  expect(() => decodeLocalContent(damaged)).toThrow();
  const escaped = encodeLocalContent(encrypted, { enabled: false });
  expect(decodeLocalContent(escaped, { enabled: false })).toEqual(encrypted);
});

it('encrypts queue records/images, drafts and source indexes, then decrypts mixed content without changing record identities', async () => {
  const config = defaultConfig();
  const queue = new DurableQueue(join(directory, 'queue'), config); await queue.initialize();
  await queue.enqueue(event(), image); // Existing plaintext remains readable after enabling.
  configureLocalContent({ enabled: true, key });
  const second = { ...event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), ocrText: 'encrypted record' };
  const secondImage = Buffer.from(image); secondImage[7] = 99;
  await queue.enqueue(second, secondImage);
  await queue.syncCheckpoint('2026-09-16T00:00:00Z');
  const drafts = new NoteDraftStore(join(directory, 'notes')); await drafts.initialize();
  const draft = { ...drafts.get(), text: 'encrypted draft', revision: 1 }; await drafts.update(draft);
  const sourcePath = join(directory, 'sources', 'state.json');
  const sources = new SourceSync(sourcePath); await sources.initialize();
  await sources.stage({ items: [{ externalId: 'fixture', title: 'source title', text: 'source body', kind: 'file', layer: 'snapshot', deleted: false }], seen: ['fixture'], skipped: 0, complete: true }, false);
  const paths = [join(directory, 'queue', 'events', second.id + '.json'), join(directory, 'queue', 'blobs', imageHash(secondImage) + '.jpg'), join(directory, 'queue', 'sync-checkpoint.json'), join(directory, 'notes', 'draft.json'), sourcePath];
  for (const path of paths) expect(isEncryptedContent(await readFile(path))).toBe(true);
  const reopened = new DurableQueue(join(directory, 'queue'), config); await reopened.initialize();
  expect(reopened.stats().depth).toBe(2); expect(await reopened.imageForBrowser(second.id)).toEqual(secondImage);
  const reopenedDraft = new NoteDraftStore(join(directory, 'notes')); await reopenedDraft.initialize(); expect(reopenedDraft.get().text).toBe(draft.text);
  const reopenedSource = new SourceSync(sourcePath); await reopenedSource.initialize(); expect(reopenedSource.status().pending).toBe(1);
  const archive = join(directory, 'export.json'); await reopened.exportArchiveFile(archive);
  expect(JSON.parse(await readFile(archive, 'utf8')).records).toHaveLength(2);
  const imported = new DurableQueue(join(directory, 'imported'), config); await imported.initialize(); await imported.importArchiveFile(archive);
  expect(await imported.imageForBrowser(second.id)).toEqual(secondImage);
  expect(isEncryptedContent(await readFile(join(directory, 'imported', 'events', second.id + '.json')))).toBe(true);
  configureLocalContent({ enabled: false, key });
  const result = await decryptLocalContent([join(directory, 'queue'), join(directory, 'notes'), join(directory, 'sources')], new AbortController().signal, () => {});
  expect(result).toMatchObject({ state: 'completed', decrypted: 5, failed: 0 });
  for (const path of paths) expect(isEncryptedContent(await readFile(path))).toBe(false);
  expect(JSON.parse(await readFile(paths[0], 'utf8')).event).toEqual(second);
  expect(await readFile(paths[1])).toEqual(secondImage);
  const plaintext = new DurableQueue(join(directory, 'queue'), config); await plaintext.initialize(); expect(plaintext.stats().depth).toBe(2);
});

it('cancels between files, resumes safely and preserves corrupt ciphertext', async () => {
  configureLocalContent({ enabled: true, key });
  for (let i = 0; i < 5; i++) await writeFile(join(directory, `${i}.json`), encodeLocalContent(JSON.stringify({ i })));
  const bad = encodeLocalContent('damaged'); bad[bad.length - 1] ^= 1; await writeFile(join(directory, 'broken.json'), bad);
  const cancel = new AbortController();
  const partial = await decryptLocalContent([directory], cancel.signal, progress => { if (progress.processed === 1) cancel.abort(); });
  expect(partial).toMatchObject({ state: 'cancelled', processed: 1, decrypted: 1 });
  const complete = await decryptLocalContent([directory], new AbortController().signal, () => {});
  expect(complete).toMatchObject({ state: 'failed', decrypted: 4, skipped: 1, failed: 1 });
  expect(await readFile(join(directory, 'broken.json'))).toEqual(bad);
  for (let i = 0; i < 5; i++) expect(JSON.parse(await readFile(join(directory, `${i}.json`), 'utf8'))).toEqual({ i });
});
