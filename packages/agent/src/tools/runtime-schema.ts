import {parameterSchemaSpecToJsonSchema, type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools';
import type {CodexTool} from '../codex-session.js';
import type {RuntimeToolDefinition, RuntimeToolIdentity} from '../runtime/contracts.js';
import {deepFreeze, type ToolFields, type ToolSnapshotEntry} from './descriptor.js';

/** A wire snapshot or a local snapshot handle: both expose the pure entries. */
export interface ToolSnapshotView {
  readonly entries: readonly ToolSnapshotEntry[];
}

/** The single fields→JSON Schema conversion. It uses the production DSH
 * projection shared by both runtimes and closes additionalProperties so an
 * undeclared argument fails. No other module may re-implement this conversion. */
export function toolInputSchema(fields: ToolFields): Readonly<Record<string, unknown>> {
  return deepFreeze({...parameterSchemaSpecToJsonSchema(fields as unknown as ParameterSchemaSpec), additionalProperties: false});
}

/** Host-side pin for one tool. Version/fingerprint live here, not in a runtime
 * protocol frame. */
export function toRuntimeToolIdentity(entry: ToolSnapshotEntry): RuntimeToolIdentity {
  return Object.freeze({name: entry.name, version: entry.version, fingerprint: entry.fingerprint});
}

/** Mote's private Host→runtime definitions. This structure carries the Host pin
 * (version/fingerprint) because the Host child configuration is a Mote channel,
 * not the DSH tool frame or the Codex function-call frame. */
export function toRuntimeToolDefinitions(snapshot: ToolSnapshotView): readonly RuntimeToolDefinition[] {
  return Object.freeze(snapshot.entries.map(entry => Object.freeze({
    ...toRuntimeToolIdentity(entry),
    description: entry.description,
    inputSchema: toolInputSchema(entry.fields),
  })));
}

/** Codex function tools. The Codex protocol has no tool-version field, so this
 * adapter deliberately emits none; the Host keeps the pin beside the tool list
 * and never pretends the frame carries identity. */
export function toCodexTools(snapshot: ToolSnapshotView): readonly CodexTool[] {
  return Object.freeze(snapshot.entries.map(entry => Object.freeze({
    type: 'function' as const,
    name: entry.name,
    description: entry.description,
    inputSchema: toolInputSchema(entry.fields),
  })));
}
