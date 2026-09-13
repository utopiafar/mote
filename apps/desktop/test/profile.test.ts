import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../src/config';
import { profileDefaults, resolveProfile } from '../src/profile';
import { NoteDraftStore } from '../src/note-draft';
import { DurableQueue } from '../src/queue';
import { EventJournal } from '../src/support';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-profile-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const secrets = { available: () => true, encrypt: (s: string) => Buffer.from(`fixture encryption:${s}`), decrypt: (b: Buffer) => b.toString().slice('fixture encryption:'.length) };
it('preserves the exact legacy path and safely resolves explicit dev/test/prod profiles', () => {
  expect(resolveProfile([], {}, '/private/old')).toMatchObject({ name: 'legacy', legacy: true, dataDirectory: '/private/old', defaultServerUrl: 'http://127.0.0.1:47832' });
  expect(resolveProfile(['--profile=legacy'], {}, '/private/old').dataDirectory).toBe('/private/old');
  expect(resolveProfile(['--profile', 'dev'], { MOTE_PROFILE: 'prod' }, '/private/old')).toMatchObject({ dataDirectory: '/private/old-profiles/dev', defaultServerUrl: 'http://127.0.0.1:47842' });
  expect(resolveProfile([], { MOTE_PROFILE: 'test' }, '/private/old').defaultServerUrl).toMatch(/47852$/);
  for (const value of ['', '../old', '/tmp', 'DEV', 'a'.repeat(33)]) expect(() => resolveProfile([`--profile=${value}`], {}, '/private/old')).toThrow();
  expect(() => resolveProfile(['--profile'], {}, '/private/old')).toThrow();
  expect(() => resolveProfile(['--profile=dev', '--profile=test'], {}, '/private/old')).toThrow();
});
it('never seeds dev with the daily local node or credentials from an overridden profile', () => {
  const dev = resolveProfile([], { MOTE_PROFILE: 'dev' }, directory);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(() => profileDefaults(dev, { MOTE_PROFILE: 'dev', MOTE_URL: `http://${host}:47832` })).toThrow('不能自动连接');
  const fresh = profileDefaults(dev, { MOTE_PROFILE: 'prod', MOTE_URL: 'https://formal.example', MOTE_TOKEN: 'synthetic formal secret' });
  expect(fresh.serverUrl).toBe(dev.defaultServerUrl); expect(fresh.token).toBeUndefined();
  const ambient = profileDefaults(dev, { MOTE_URL: 'https://formal.example', MOTE_TOKEN: 'synthetic remote token 1234567890123456789' });
  expect(ambient.serverUrl).toBe(dev.defaultServerUrl); expect(ambient.token).toBeUndefined();
  const explicit = profileDefaults(dev, { MOTE_PROFILE: 'dev', MOTE_URL: 'https://dev.example', MOTE_TOKEN: 'synthetic dev token 1234567890123456789' });
  expect(explicit.serverUrl).toBe('https://dev.example'); expect(explicit.token).toMatch(/^synthetic dev/);
  expect(profileDefaults(dev, { MOTE_TOKEN: 'inherited secret without destination' }).token).toBeUndefined();
});
it('isolates stable identity, encrypted credentials, drafts, outbox and events; saved credentials win over bootstrap', async () => {
  const states = [];
  for (const name of ['legacy', 'dev', 'test']) {
    const profile = resolveProfile([`--profile=${name}`], {}, join(directory, 'original'));
    const seed = () => profileDefaults(profile, { MOTE_PROFILE: profile.name, MOTE_URL: profile.defaultServerUrl, MOTE_TOKEN: `synthetic token for ${name}` });
    const store = new ConfigStore(profile.dataDirectory, secrets, seed); const config = await store.load(); await store.save(config);
    const draft = new NoteDraftStore(join(profile.dataDirectory, 'notes')); await draft.initialize();
    await draft.update({ ...draft.get(), text: `private synthetic draft ${name}`, revision: 1 });
    const queue = new DurableQueue(join(profile.dataDirectory, 'queue'), config); await queue.initialize();
    await draft.submit(draft.get(), config, 'macos', queue);
    await draft.update({ ...draft.get(), text: `remaining private ${name}`, revision: 1 });
    const journal = new EventJournal(join(profile.dataDirectory, 'diagnostics'), () => true); await journal.record('NOTE', 'OK');
    states.push({ profile, config, queue });
  }
  expect(new Set(states.map(s => s.config.deviceId)).size).toBe(3);
  for (const { profile, config } of states) {
    const restarted = new ConfigStore(profile.dataDirectory, secrets, () => profileDefaults(profile, { MOTE_URL: 'https://different.example', MOTE_TOKEN: 'synthetic new bootstrap token 123456789' }));
    expect(await restarted.load()).toEqual(config);
    const ignoredBootstrap = new ConfigStore(profile.dataDirectory, secrets, () => profileDefaults(profile, {}), () => { throw new Error('invalid environment must not affect saved node'); });
    expect(await ignoredBootstrap.load()).toEqual(config);
    const draft = new NoteDraftStore(join(profile.dataDirectory, 'notes')); await draft.initialize(); expect(draft.get().text).toBe(`remaining private ${profile.name}`);
    const queue = new DurableQueue(join(profile.dataDirectory, 'queue'), config); await queue.initialize(); expect(queue.stats().depth).toBe(1);
    const entry = await queue.next(); expect(entry?.record.event.deviceId).toBe(config.deviceId); expect(entry?.record.event.ocrText).toBe(`private synthetic draft ${profile.name}`); expect(entry?.image).toBeUndefined();
    expect((await new EventJournal(join(profile.dataDirectory, 'diagnostics'), () => true).read()).length).toBe(1);
    const raw = JSON.parse(await readFile(join(profile.dataDirectory, 'config.json'), 'utf8')); expect(raw.config.token).toBeUndefined(); expect(raw.encryptedToken).toBeTruthy();
  }
});
