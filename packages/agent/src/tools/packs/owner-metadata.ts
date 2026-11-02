import {recordMetadataSchema} from '@mote/shared';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {displayTime} from '../../time.js';
import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';

/** Owner metadata pack: device directory snapshots, read-only calendar
 * comparison and display-only progress. It never gets a reader, store, ledger,
 * action executor or grant table; discovery, task selection, private receipts
 * and citations remain parent-owned. */
export interface OwnerMetadataPackOptions {
  readonly timeZone?: string;
}

const invalid = (message: string): never => {
  throw new ContextToolError('invalid_tool_arguments', message, 'correct_arguments');
};

const ACTION_EVIDENCE_POLICY = 'Untrusted prior proposals; sameAs identifiers only, not original citation grants.';

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw new Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

/** Migrated device projection: drop bodies/paths, keep reported health and its
 * observation time, and never turn a stale report into archive coverage. */
function projectDevice(value: unknown, timeZone: string, observedAt?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const device = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['deviceId', 'deviceName', 'platform']) {
    if (typeof device[key] === 'string') result[key] = device[key].slice(0, 300);
  }
  const healthReport: Record<string, unknown> = {};
  for (const [key, label] of [['status', 'statusAsReported'], ['lastSeenAt', 'receivedAt'], ['lastCaptureAt', 'lastCaptureAtAsReported']] as const) {
    if (typeof device[key] === 'string') {
      healthReport[label] = device[key].slice(0, 100);
      if (key !== 'status' && Number.isFinite(Date.parse(device[key] as string)))
        healthReport['display' + label[0].toUpperCase() + label.slice(1)] = displayTime(device[key] as string, timeZone);
    }
  }
  if (typeof device.queueDepth === 'number' && Number.isSafeInteger(device.queueDepth) && device.queueDepth >= 0)
    healthReport.queueDepthAsReported = device.queueDepth;
  if (Object.keys(healthReport).length) result.healthReport = healthReport;
  const metadata = recordMetadataSchema.safeParse(device.metadata);
  if (metadata.success) result.metadata = {...metadata.data, displayObservedAt: displayTime(metadata.data.observedAt, timeZone)};
  if (observedAt !== undefined) {
    result.directoryObservedAt = observedAt;
    result.displayDirectoryObservedAt = displayTime(observedAt, timeZone);
  }
  return result;
}

function actionScope(scope: Readonly<{after?: string; before?: string; deviceId?: string}>): {after?: string; before?: string; deviceId?: string} {
  return {
    ...(scope.after === undefined ? {} : {after: scope.after}),
    ...(scope.before === undefined ? {} : {before: scope.before}),
    ...(scope.deviceId === undefined ? {} : {deviceId: scope.deviceId}),
  };
}

export function createOwnerMetadataPack(options: OwnerMetadataPackOptions = {}): readonly ToolDescriptor[] {
  const timeZone = options.timeZone ?? 'UTC';
  const devicesSpec = spec('devices'), actionSpec = spec('action_catalog'), progressSpec = spec('progress_update');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1',
      name: 'devices',
      version: '1',
      description: devicesSpec[1],
      fields: devicesSpec[2],
      kind: 'metadata',
      exposure: 'catalog',
      requires: ['devices'],
      parse(args) {
        return {...args};
      },
      async execute(_args, port: HostSessionPort) {
        const raw = await port.read('devices');
        let items: unknown[] = [];
        let observedAt: string | undefined;
        let page: Record<string, unknown> | undefined;
        if (Array.isArray(raw)) {
          items = raw;
        } else if (raw && typeof raw === 'object') {
          page = raw as Record<string, unknown>;
          if (!Array.isArray(page.items)) invalid('Device reader returned invalid metadata');
          items = page.items as unknown[];
          if (typeof page.observedAt === 'string' && Number.isFinite(Date.parse(page.observedAt))) observedAt = page.observedAt;
        } else {
          invalid('Device reader returned invalid metadata');
        }
        const selected = port.scope.deviceId;
        const data = items
          .filter(device => !selected || Boolean(device && typeof device === 'object' && (device as Record<string, unknown>).deviceId === selected))
          .map(device => projectDevice(device, timeZone, observedAt));
        return {
          source: 'untrusted_personal_context',
          data,
          ...(page?.disclosureDependencies === undefined ? {} : {disclosureDependencies: page.disclosureDependencies}),
          ...(page?.sourceContextDependencies === undefined ? {} : {sourceContextDependencies: page.sourceContextDependencies}),
        };
      },
    }),
    defineToolDescriptor({
      apiVersion: '1',
      name: 'action_catalog',
      version: '1',
      description: actionSpec[1],
      fields: actionSpec[2],
      kind: 'metadata',
      exposure: 'catalog',
      requires: ['actionCatalog'],
      parse(args) {
        if (Object.keys(args).some(key => !['query', 'id', 'cursor', 'limit'].includes(key))) invalid('Invalid action catalog arguments');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) invalid('Invalid action catalog arguments');
        if (args.id !== undefined && (typeof args.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.id))) invalid('Invalid action catalog arguments');
        if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 4096)) invalid('Invalid action catalog arguments');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20)) invalid('Invalid action catalog arguments');
        return Object.freeze({...args, limit: Number(args.limit ?? 8)});
      },
      async execute(args, port: HostSessionPort) {
        const value = await port.actionCatalog({
          ...actionScope(port.scope),
          ...(args.query === undefined ? {} : {query: args.query as string}),
          ...(args.id === undefined ? {} : {id: args.id as string}),
          ...(args.cursor === undefined ? {} : {cursor: args.cursor as string}),
          limit: args.limit as number,
        });
        return {
          source: 'untrusted_personal_context',
          data: value,
          evidencePolicy: ACTION_EVIDENCE_POLICY,
        };
      },
    }),
    defineToolDescriptor({
      apiVersion: '1',
      name: 'progress_update',
      version: '1',
      description: progressSpec[1],
      fields: progressSpec[2],
      kind: 'metadata',
      exposure: 'native',
      requires: ['progress'],
      parse(args) {
        if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 600) invalid('Progress message must contain 1–600 characters');
        return Object.freeze({message: (args.message as string).trim()});
      },
      execute(args, port: HostSessionPort) {
        port.progress(args.message as string);
        return {ok: true};
      },
    }),
  ]);
}
