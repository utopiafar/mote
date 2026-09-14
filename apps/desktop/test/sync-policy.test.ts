import { describe, expect, it } from 'vitest';
import { defaultConfig, updateConfig } from '../src/config';
import { decideSync } from '../src/sync-policy';
const origin = Date.parse('2026-09-14T00:00:00.000Z');
const config = { ...defaultConfig(), token: 'synthetic-sync-token' };
const pending = { pendingRecords: 1, oldestPendingAt: new Date(origin).toISOString() };
describe('durable synchronization policy', () => {
  it('allows local configuration and performs no implicit or explicit network work without both connection fields', () => {
    expect(updateConfig(config, { ...config, serverUrl: '', token: '' })).toMatchObject({ serverUrl: '', token: undefined });
    for (const connection of [{ serverUrl: '', token: 'unused-token' }, { serverUrl: config.serverUrl, token: undefined }]) {
      expect(decideSync({ ...config, ...connection }, pending, origin, true)).toMatchObject({ ready: false, state: 'unconfigured' });
    }
  });
  it('uses persisted oldest pending timestamps for interval deadlines across restarts', () => {
    const interval = { ...config, syncMode: 'interval' as const };
    expect(decideSync(interval, pending, origin + 14 * 60000)).toMatchObject({ ready: false, nextUploadAt: new Date(origin + 15 * 60000).toISOString() });
    expect(decideSync(interval, structuredClone(pending), origin + 15 * 60000).ready).toBe(true);
    expect(decideSync(interval, { ...pending, lastUploadAt: new Date(origin + 10 * 60000).toISOString() }, origin + 20 * 60000).ready).toBe(false);
  });
  it('releases batches on combined count or oldest-item deadline and lets manual sync override cadence', () => {
    const batch = { ...config, syncMode: 'batch' as const, syncBatchSize: 20 };
    expect(decideSync(batch, { ...pending, pendingRecords: 19 }, origin + 1000).ready).toBe(false);
    expect(decideSync(batch, { ...pending, pendingRecords: 20 }, origin + 1000).ready).toBe(true);
    expect(decideSync(batch, pending, origin + 15 * 60000).ready).toBe(true);
    expect(decideSync(batch, pending, origin + 1000, true).ready).toBe(true);
  });
  it('never auto uploads in manual mode, even after a retry deadline or restart', () => {
    const manual = { ...config, syncMode: 'manual' as const };
    expect(decideSync(manual, { ...pending, nextRetryAt: new Date(origin + 1000).toISOString() }, origin + 86400000)).toMatchObject({ state: 'manual', ready: false });
    expect(decideSync(manual, pending, origin, true).ready).toBe(true);
  });
  it('respects persisted retry backoff and validates scheduling bounds', () => {
    const retryAt = new Date(origin + 30000).toISOString();
    expect(decideSync(config, { ...pending, nextRetryAt: retryAt }, origin)).toMatchObject({ ready: false, nextUploadAt: retryAt });
    expect(decideSync(config, { ...pending, nextRetryAt: retryAt }, origin + 30000).ready).toBe(true);
    for (const value of [{ syncIntervalMinutes: 14 }, { syncIntervalMinutes: 1441 }, { syncBatchSize: 0 }, { syncBatchSize: 501 }, { syncMode: 'unknown' }]) expect(() => updateConfig(config, { ...config, ...value } as never)).toThrow();
  });
});
it('schedules metadata-only source changes without inventing a record count', () => {
  const metadata = { pendingRecords: 0, pendingUpdates: 1, oldestPendingAt: new Date(origin).toISOString() };
  for (const syncMode of ['interval', 'batch'] as const) {
    expect(decideSync({ ...config, syncMode }, metadata, origin)).toMatchObject({ pendingRecords: 0, ready: false, state: 'waiting', nextUploadAt: new Date(origin + 15 * 60000).toISOString() });
    expect(decideSync({ ...config, syncMode }, metadata, origin + 15 * 60000).ready).toBe(true);
  }
  expect(decideSync({ ...config, syncMode: 'manual' }, metadata, origin + 86400000).ready).toBe(false);
});
