import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ device: vi.fn(), power: vi.fn(), disk: vi.fn(), idle: vi.fn(), idleState: vi.fn() }));
vi.mock('../src/native', () => ({ readDeviceMetadata: mocks.device, readPowerState: mocks.power }));
vi.mock('node:fs/promises', () => ({ statfs: mocks.disk }));
vi.mock('electron', () => ({ app: { getVersion: () => 'synthetic-version', getLocale: () => 'zh-CN' }, powerMonitor: { getSystemIdleTime: mocks.idle, getSystemIdleState: mocks.idleState } }));
import { collectRecordMetadata } from '../src/record-metadata';
beforeEach(() => { vi.clearAllMocks(); mocks.device.mockResolvedValue({ device: { model: 'SyntheticMac1,1', osVersion: '13.3' }, state: { powerSave: true, thermalState: 'fair' } }); mocks.power.mockResolvedValue({ batteryPercent: 40, charging: false, onBattery: true }); mocks.disk.mockResolvedValue({ bavail: 20, bsize: 4096 }); mocks.idle.mockReturnValue(15); mocks.idleState.mockReturnValue('locked'); });
describe('bounded observed record metadata', () => {
  it('reports only measured capabilities and never exposes filesystem paths or hardware identifiers', async () => {
    const result = await collectRecordMetadata('/synthetic/helper', '/synthetic/private-data', 'screen_capture');
    expect(result.state).toMatchObject({ batteryPercent: 40, onBattery: true, powerSave: true, thermalState: 'fair', idleSeconds: 15, screenLocked: true, availableStorageBytes: 81920 });
    expect(result.collector).toEqual({ version: 'synthetic-version', method: 'screen_capture' }); expect(result.device?.model).toBe('SyntheticMac1,1');
    expect(result.state).not.toHaveProperty('networkType'); expect(result.state).not.toHaveProperty('screenInteractive'); expect(JSON.stringify(result)).not.toContain('private-data');
  });
  it('omits failed or unknown observations rather than inventing battery, storage or screen state', async () => {
    mocks.device.mockRejectedValue(new Error('fixture')); mocks.power.mockRejectedValue(new Error('fixture')); mocks.disk.mockRejectedValue(new Error('fixture')); mocks.idle.mockReturnValue(-1); mocks.idleState.mockReturnValue('unknown');
    const result = await collectRecordMetadata('/synthetic/helper', '/synthetic/path', undefined);
    expect(result.state).toEqual({}); expect(result.device).not.toHaveProperty('model'); expect(result.collector).not.toHaveProperty('method');
  });
  it('does not let a cancelled capture persist late metadata after optional probes settle', async () => {
    const abort = new AbortController(); abort.abort(); await expect(collectRecordMetadata('/synthetic/helper', '/synthetic/path', undefined, abort.signal)).rejects.toThrow();
  });
});
