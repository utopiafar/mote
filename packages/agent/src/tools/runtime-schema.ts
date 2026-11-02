import {parameterSchemaSpecToJsonSchema, type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools';
import type {CodexTool} from '../codex-session.js';
import type {RuntimeToolDefinition, RuntimeToolIdentity} from '../runtime/contracts.js';
import {deepFreeze, type ToolFields, type ToolSnapshotEntry} from './descriptor.js';

/** Fields a schema projection needs; a snapshot entry, discovery entry or
 * descriptor all provide them. */
export type ToolSchemaSource = Pick<ToolSnapshotEntry, 'name' | 'version' | 'description' | 'fingerprint' | 'fields'>;

/** One object-rooted JSON Schema shared by both runtime adapters. It uses the
 * same production DSH projection that the current Codex and DSH tool lists
 * consume, plus closed additionalProperties so an undeclared argument fails. */
export function toolInputSchema(fields: ToolFields): Readonly<Record<string, unknown>> {
  return deepFreeze({...parameterSchemaSpecToJsonSchema(fields as unknown as ParameterSchemaSpec), additionalProperties: false});
}

/** Host-side identity for one pinned tool. Version and fingerprint live here,
 * in the Host pin, because neither runtime protocol frame carries them. */
export function toRuntimeToolIdentity(tool: ToolSchemaSource): RuntimeToolIdentity {
  return Object.freeze({name: tool.name, version: tool.version, fingerprint: tool.fingerprint});
}

/** Mote's private Host→runtime definition. This structure does carry version and
 * fingerprint because the Host child configuration is a Mote channel, not the
 * DSH tool frame or the Codex function-call frame. */
export function toRuntimeToolDefinition(tool: ToolSchemaSource): RuntimeToolDefinition {
  return Object.freeze({...toRuntimeToolIdentity(tool), description: tool.description, inputSchema: toolInputSchema(tool.fields)});
}

/** One DSH tool frame. The DSH protocol carries name, description and parameters
 * only: version/fingerprint stay in the Host pin, so this adapter must not stamp
 * a version here and present it as protocol identity. */
export interface DshToolFrame {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export function toDshTool(tool: ToolSchemaSource): DshToolFrame {
  return Object.freeze({name: tool.name, description: tool.description, parameters: toolInputSchema(tool.fields)});
}

/** One Codex function-call tool. Codex likewise has no tool-version field; the
 * Host pin is the only version authority. */
export function toCodexTool(tool: ToolSchemaSource): CodexTool {
  return Object.freeze({type: 'function', name: tool.name, description: tool.description, inputSchema: toolInputSchema(tool.fields)});
}

/** Project one snapshot into both runtime frames without changing their order or
 * schemas. The two adapters consume the same pinned fields, so a schema cannot
 * drift between runtimes. */
export function runtimeToolFrames(tools: readonly ToolSchemaSource[]): Readonly<{dsh: readonly DshToolFrame[]; codex: readonly CodexTool[]}> {
  return Object.freeze({
    dsh: Object.freeze(tools.map(toDshTool)),
    codex: Object.freeze(tools.map(toCodexTool)),
  });
}
