import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, defaultConfig, publicConfig, updateConfig, validateLocalModelUrl, validateServerUrl } from '../src/config';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-config-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('configuration security', () => {
  it('requires TLS for remote nodes and rejects URL credentials, paths and deceptive loopback names', () => {
    expect(validateServerUrl('http://127.0.0.1:47832/')).toBe('http://127.0.0.1:47832');
    expect(validateServerUrl('https://mote.example')).toBe('https://mote.example');
    for (const url of ['http://192.168.1.2', 'http://localhost.example', 'https://user:secret@host.test', 'https://host.test/api', 'https://host.test?token=secret', 'file:///etc/passwd']) expect(() => validateServerUrl(url)).toThrow();
    expect(() => validateLocalModelUrl('https://mote.example/review')).toThrow();
  });
  it('requires a strong remote token and validates finite masks and cadence', () => {
    const config = defaultConfig();
    expect(() => updateConfig(config, { ...config, serverUrl: 'https://mote.example', token: 'short' })).toThrow('32');
    expect(updateConfig(config, { ...config, serverUrl: 'https://mote.example', token: 'a'.repeat(32) }).serverUrl).toBe('https://mote.example');
    expect(() => updateConfig(config, { ...config, intervalMs: 0 })).toThrow();
    expect(() => updateConfig(config, { ...config, masks: [{ x: NaN, y: 0, width: 0.2, height: 0.2 }] })).toThrow();
  });
  it('persists only an OS-encrypted token, keeps it out of public UI state and retains device identity', async () => {
    const store = new ConfigStore(directory, {
      available: () => true,
      encrypt: value => Buffer.from([...value].reverse().join('')),
      decrypt: value => [...value.toString()].reverse().join(''),
    });
    const config = { ...defaultConfig(), token: 'synthetic-secret-for-config-test' };
    await store.save(config);
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain(config.token);
    const loaded = await store.load();
    expect(loaded.token).toBe(config.token);
    expect(loaded.deviceId).toBe(config.deviceId);
    expect(publicConfig(loaded)).not.toHaveProperty('token');
    expect(publicConfig(loaded).tokenConfigured).toBe(true);
  });
  it('does not silently fall back to plaintext when secure storage is unavailable', async () => {
    const store = new ConfigStore(directory, { available: () => false, encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
    await expect(store.save({ ...defaultConfig(), token: 'synthetic-secret' })).rejects.toThrow('明文');
  });
  it('never reuses a token or moves queued notes/screens to a different central origin during configure', () => {
    const current = { ...defaultConfig(), token: 'old-node-only-token' };
    expect(() => updateConfig(current, { ...current, serverUrl: 'http://127.0.0.1:47999', token: undefined })).toThrow('新节点令牌');
    expect(() => updateConfig(current, { ...current, serverUrl: 'http://127.0.0.1:47999', token: 'explicit-new-node-token' }, 1)).toThrow('待上传记录');
    expect(updateConfig(current, { ...current, serverUrl: 'http://127.0.0.1:47999', token: 'explicit-new-node-token' }, 0).token).toBe('explicit-new-node-token');
    expect(updateConfig(current, { ...current, token: undefined }, 2).token).toBe(current.token);
  });

});

it('persists image deduplication and renamed identity without replacing the device ID', async () => {
  const config = defaultConfig();
  const next = updateConfig(config, { ...config, imageDedupeMode: 'exact', deviceName: ' Renamed Mac ' });
  expect(next.deviceName).toBe('Renamed Mac'); expect(next.deviceId).toBe(config.deviceId);
  expect(next.imageDedupeMode).toBe('exact');
  expect(() => updateConfig(config, { ...config, imageDedupeMode: 'invalid' as any })).toThrow();
});
