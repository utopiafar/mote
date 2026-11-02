import {CONTEXT_TOOLS} from '../../context-tools.js';
import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import {originalReadRange} from './originals.js';

/** Measurement pack: activity and media playback aggregates are produced by the
 * Host measurement consumer. The pack only normalizes the request and returns
 * the untrusted body; it never recomputes overlap unions, cross-device sums or
 * unknown coverage from app names or content. */
export interface MeasurementReadPackOptions {
  readonly timeZone?: string;
}

const invalid = (message: string): never => {
  throw new ContextToolError('invalid_tool_arguments', message, 'correct_arguments');
};

/** Keep private lineage receipts out of the public data field. The parent strips
 * these top-level fields before model disclosure and records them as private
 * dependencies; they must never appear as model-visible aggregate content. */
function untrustedMeasurement(value: unknown): {data: unknown; disclosureDependencies?: unknown; sourceContextDependencies?: unknown} {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const {disclosureDependencies, sourceContextDependencies, ...data} = value as Record<string, unknown>;
    return {
      data,
      ...(disclosureDependencies === undefined ? {} : {disclosureDependencies}),
      ...(sourceContextDependencies === undefined ? {} : {sourceContextDependencies}),
    };
  }
  return {data: value};
}

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw new Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

export function createMeasurementReadPack(options: MeasurementReadPackOptions = {}): readonly ToolDescriptor[] {
  void options.timeZone; // activity/media aggregates carry Host-produced values, not display projections.
  const activitySpec = spec('activity'), mediaSpec = spec('media_activity');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1',
      name: 'activity',
      version: '1',
      description: activitySpec[1],
      fields: activitySpec[2],
      kind: 'metadata',
      exposure: 'catalog',
      requires: ['activity'],
      parse(args) {
        originalReadRange(args, {});
        return {...args};
      },
      async execute(args, port: HostSessionPort) {
        const filters = originalReadRange(args, port.scope);
        port.assertCurrent();
        const measured = untrustedMeasurement(await port.read('activity', filters));
        port.assertCurrent();
        return {source: 'untrusted_personal_context', ...measured};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1',
      name: 'media_activity',
      version: '1',
      description: mediaSpec[1],
      fields: mediaSpec[2],
      kind: 'metadata',
      exposure: 'catalog',
      requires: ['mediaActivity'],
      parse(args) {
        if (args.source !== undefined && args.source !== 'media') invalid('media_activity requires the media source');
        if (args.appVisibility !== undefined && (typeof args.appVisibility !== 'string' || !['foreground', 'background', 'unknown'].includes(args.appVisibility))) invalid('Invalid appVisibility');
        if (args.playbackType !== undefined && (typeof args.playbackType !== 'string' || !['local', 'remote', 'unknown'].includes(args.playbackType))) invalid('Invalid playbackType');
        if (args.screenLocked !== undefined && typeof args.screenLocked !== 'boolean') invalid('screenLocked must be boolean');
        originalReadRange(args, {});
        return {...args};
      },
      async execute(args, port: HostSessionPort) {
        const filters = originalReadRange(args, port.scope);
        const request = {
          ...filters,
          source: 'media' as const,
          ...(args.appVisibility === undefined ? {} : {appVisibility: args.appVisibility as 'foreground' | 'background' | 'unknown'}),
          ...(args.screenLocked === undefined ? {} : {screenLocked: args.screenLocked as boolean}),
          ...(args.playbackType === undefined ? {} : {playbackType: args.playbackType as 'local' | 'remote' | 'unknown'}),
        };
        port.assertCurrent();
        const measured = untrustedMeasurement(await port.read('mediaActivity', request));
        port.assertCurrent();
        return {source: 'untrusted_personal_context', ...measured};
      },
    }),
  ]);
}
