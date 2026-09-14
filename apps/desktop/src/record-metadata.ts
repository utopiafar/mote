import { app, powerMonitor } from 'electron';
import { arch } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { RecordMetadata } from '@mote/shared';
import { readDeviceMetadata, readPowerState } from './native';

/** Optional observations never invent a value when the platform probe fails. No identifiers or paths leave here. */
export async function collectRecordMetadata(helperPath: string, dataDirectory: string, method: NonNullable<RecordMetadata['collector']>['method'], signal?: AbortSignal): Promise<RecordMetadata> {
  const observedAt = new Date().toISOString();
  const [hardware, power, disk] = await Promise.allSettled([
    readDeviceMetadata(helperPath, signal), readPowerState(helperPath, signal), statfs(dataDirectory),
  ]);
  signal?.throwIfAborted();
  const device: NonNullable<RecordMetadata['device']> = { ...(hardware.status === 'fulfilled' ? hardware.value.device : {}), architecture: arch() };
  const locale = app.getLocale(); if (locale) device.locale = locale;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; if (zone) device.timeZone = zone;
  const state: NonNullable<RecordMetadata['state']> = { ...(hardware.status === 'fulfilled' ? hardware.value.state : {}), ...(power.status === 'fulfilled' ? power.value : {}) };
  const idle = powerMonitor.getSystemIdleTime(); if (Number.isSafeInteger(idle) && idle >= 0) state.idleSeconds = idle;
  const idleState = powerMonitor.getSystemIdleState(60);
  if (idleState === 'locked') state.screenLocked = true;
  else if (idleState === 'active' || idleState === 'idle') state.screenLocked = false;
  if (disk.status === 'fulfilled') {
    const bytes = disk.value.bavail * disk.value.bsize;
    if (Number.isSafeInteger(bytes) && bytes >= 0) state.availableStorageBytes = bytes;
  }
  return { version: 1, observedAt, collector: { version: app.getVersion(), ...(method ? { method } : {}) }, device, state };
}
