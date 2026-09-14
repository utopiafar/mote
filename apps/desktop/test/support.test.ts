import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, publicConfig } from '../src/config';
import { EventJournal, buildSupportBundle, failureCode, httpFailure, TransportFailure } from '../src/support';
import { resolveProfile } from '../src/profile';
import type { Status } from '../src/contracts';
let directory: string;
it('viewer distinguishes missing history from corrupt history without modifying the file', async () => {
  const journal = new EventJournal(directory, () => false);
  expect(await journal.read(true)).toEqual([]);
  await writeFile(join(directory, 'events.json'), 'broken generated fixture');
  await expect(journal.read(true)).rejects.toThrow();
  expect(await readFile(join(directory, 'events.json'), 'utf8')).toBe('broken generated fixture');
});
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-support-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('bounds concurrent events, restores after restart, strips unknown fields and honors opt-out', async () => {
  let enabled = false; const journal = new EventJournal(directory, () => enabled, 3);
  await journal.record('APP', 'STARTED'); expect(await journal.read()).toEqual([]);
  const orphan = join(directory, 'events.json.2147483647.11111111-1111-4111-8111-111111111111.tmp');
  await writeFile(orphan, 'synthetic unfinished event');
  enabled = true;
  await Promise.all(Array.from({ length: 6 }, (_, i) => journal.record('UPLOAD', 'AUTH', { httpStatus: 401, elapsedMs: i })));
  await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await journal.read()).map(e => e.elapsedMs)).toEqual([3,4,5]);
  enabled = false; await journal.record('NOTE', 'OK'); expect((await journal.read()).length).toBe(3);
  const rows = JSON.parse(await readFile(join(directory, 'events.json'), 'utf8'));
  rows[0].message = 'private OCR token'; rows[0].token = 'private'; rows.push({ atMs: Date.now(), stage: 'private', code: 'OK' });
  await writeFile(join(directory, 'events.json'), JSON.stringify(rows));
  const resumed = new EventJournal(directory, () => true, 3); expect(JSON.stringify(await resumed.read())).not.toContain('private'); expect((await resumed.read()).length).toBe(3);
});
it('classifies explicit transport/type codes without reading a sensitive error message', () => {
  expect(failureCode(new TransportFailure('private reason', 'AUTH', 401), 'UPLOAD')).toBe('AUTH');
  expect(failureCode(Object.assign(new Error('secret'), { cause: { code: 'ECONNREFUSED' } }), 'UPLOAD')).toBe('NETWORK');
  expect(failureCode(Object.assign(new Error('secret'), { name: 'TimeoutError' }), 'MODEL')).toBe('TIMEOUT');
  expect(failureCode(new Error('timeout auth denied keyword'), 'MODEL')).toBe('MODEL_UNAVAILABLE');
  expect(httpFailure(401)).toBe('AUTH'); expect(httpFailure(409)).toBe('CONFLICT'); expect(httpFailure(503)).toBe('SERVER');
});
it('support export includes safe counters and fixed events, never arbitrary status/config content', () => {
  const c = defaultConfig(); c.deviceName = 'private device'; c.token = 'private token'; c.reviewPolicy = 'private policy'; c.serverUrl = 'https://private-host.example';
  const status = { running:false, state:'paused', message:'private OCR', lastUploadError:'private note', queueDepth:2, queueBytes:90, encryptedTokenStorage:true,
    config:publicConfig(c), diagnostics:{ enabled:true, sampleCount:1, fileBytes:22, error:'private error', counters:{ saved:1, secret:'private counter' }, latest:{ rssBytes:100, message:'private latest', cpuUserMicros:Infinity } },
    nsfw:{ error:'private model reason', bytes:12, lastDurationMs:3, blockedCount:1, modelId:'private model', downloadSource:'private URL' },
  } as unknown as Status;
  const output = JSON.stringify(buildSupportBundle(resolveProfile(['--profile=dev'], {}, '/private/user'), '0.2.1', status, [{ atMs: 1, stage:'UPLOAD', code:'AUTH', httpStatus:401 }]));
  expect(output).not.toContain('private'); expect(output).not.toContain(c.deviceId); expect(output).not.toContain('Infinity');
  expect(JSON.parse(output)).toMatchObject({ app:{profile:'dev'}, state:{queueDepth:2}, diagnostics:{counters:{saved:1}}, events:[{stage:'UPLOAD',code:'AUTH'}] });
});
