import {createHash} from 'node:crypto';
import type {RuntimeToolIdentity} from '../runtime/contracts.js';
import {ContextToolError} from '../tool-errors.js';

/** Version of the tool-descriptor contract carried by every descriptor.
 * This is a string, unlike the numeric wire snapshot schemaVersion. */
export const TOOL_DESCRIPTOR_API_VERSION = '1' as const;
/** Version of the serializable registry snapshot DTO. */
export const TOOL_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** Finite capability kinds. A kind selects the one HostSessionPort entry a
 * contribution may declare; it never grants that entry. */
export type ToolCapabilityKind = 'read' | 'action_compare' | 'progress';
/** HostSessionPort entries a descriptor may declare. Declaring one is a
 * requirement statement, not an authorization: the parent Host decides every
 * actual read, calendar comparison and progress publication. */
export type ToolHostEntry = 'read' | 'actionCatalog' | 'progress';
export type ToolFields = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type ToolContractErrorCode =
  | 'invalid_tool_descriptor'
  | 'reserved_tool_name'
  | 'duplicate_tool'
  | 'invalid_tool_selection'
  | 'unknown_tool'
  | 'tool_version_mismatch'
  | 'invalid_tool_arguments'
  | 'stale_tool_pin';

const kindRequirements: Readonly<Record<ToolCapabilityKind, readonly ToolHostEntry[]>> = Object.freeze({
  read: Object.freeze(['read'] as const),
  action_compare: Object.freeze(['actionCatalog'] as const),
  progress: Object.freeze(['progress'] as const),
});

/** The exact Host entries a kind requires. Exported so a consumer can compare a
 * descriptor's declaration with its kind instead of trusting either alone. */
export function toolKindRequirements(kind: ToolCapabilityKind): readonly ToolHostEntry[] {
  return kindRequirements[kind];
}

/** Parent-bound port surface for one staged call. A pack receives this object
 * only for the duration of its own handler; it never receives a reader, store,
 * grant table, ledger, discovery state, sender, confirm or discard. The type
 * exposes every possible port entry, but the parent admits only the entries the
 * descriptor declared and the current task/scope/grants allow. */
export interface ToolExecutionHost {
  readonly tool: RuntimeToolIdentity;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  read(operation: string, ...args: unknown[]): Promise<unknown>;
  actionCatalog(args: Record<string, unknown>): unknown;
  progress(message: string): void;
}

export type ToolExecute = (
  args: Readonly<Record<string, unknown>>,
  host: ToolExecutionHost,
) => unknown | Promise<unknown>;

/** Author-facing shape. Runtime validation still runs because packs are
 * separate code and TypeScript types do not cross that boundary. */
export interface ToolDescriptorInput {
  readonly apiVersion: typeof TOOL_DESCRIPTOR_API_VERSION;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: ToolCapabilityKind;
  readonly requires: readonly ToolHostEntry[];
  readonly fields: ToolFields;
  readonly execute: ToolExecute;
}

/** Validated, deep-frozen descriptor. `execute` stays local: it is never part
 * of a snapshot, discovery document or schema projection. */
export interface ToolDescriptor extends ToolDescriptorInput {}

/** Process-local pin for one registration. The symbol token is deliberately
 * non-serializable: it cannot travel in the wire snapshot, and a later
 * registration of the same name/version creates a different token. */
export interface ToolPin {
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly token: symbol;
}

/** Pure wire DTO entry. It carries identity and the pinned schema, but no
 * handler, liveness token or grant. */
export interface ToolSnapshotEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: ToolCapabilityKind;
  readonly requires: readonly ToolHostEntry[];
  readonly fingerprint: string;
  readonly fields: ToolFields;
}

/** Serialized capability manifest. `schemaVersion` is the numeric wire
 * version; do not confuse it with the descriptor `apiVersion` string. */
export interface ToolSnapshot {
  readonly schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION;
  readonly tools: readonly ToolSnapshotEntry[];
  readonly fingerprint: string;
}

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const reservedNames = new Set(['skill', '_ready', 'capability_discover', 'capability_execute']);
const errorRecovery: Readonly<Record<ToolContractErrorCode, 'correct_arguments' | 'stop'>> = Object.freeze({
  invalid_tool_descriptor: 'stop',
  reserved_tool_name: 'stop',
  duplicate_tool: 'stop',
  invalid_tool_selection: 'correct_arguments',
  unknown_tool: 'correct_arguments',
  tool_version_mismatch: 'correct_arguments',
  invalid_tool_arguments: 'correct_arguments',
  stale_tool_pin: 'stop',
});

/** Only host-authored contract errors cross the model boundary. */
export function toolContractError(
  code: ToolContractErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ContextToolError {
  return new ContextToolError(code, message, errorRecovery[code], details);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Deterministic JSON with sorted object keys. Used for snapshot identity only;
 * it must not be confused with a signature or an authorization token. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}

/** Schema fingerprint of one tool. The serialization matches the existing
 * saved-query capability identity so an already pinned query stays comparable;
 * the snapshot-level fingerprint below is canonical instead. */
export function toolSchemaFingerprint(description: string, fields: ToolFields): string {
  return createHash('sha256').update(JSON.stringify([description, fields])).digest('hex');
}

function invalid(message: string): never {
  throw toolContractError('invalid_tool_descriptor', message);
}

function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => jsonSafe(item, depth + 1));
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= 1000 && keys.every(key => jsonSafe(value[key], depth + 1));
}

function validatedName(value: unknown): string {
  if (typeof value !== 'string') invalid('Tool name must match ^[a-z][a-z0-9_]{0,63}$');
  if (reservedNames.has(value) || value.startsWith('delegation_') || value.startsWith('_')) {
    throw toolContractError('reserved_tool_name', 'This tool name is reserved by the Host protocol.', {name: value});
  }
  if (!namePattern.test(value)) invalid('Tool name must match ^[a-z][a-z0-9_]{0,63}$');
  return value;
}

function validatedFields(value: unknown): ToolFields {
  if (!isPlainRecord(value)) invalid('Tool fields must be a plain property map');
  if (Object.keys(value).length > 64) invalid('Tool fields may declare at most 64 properties');
  for (const [key, schema] of Object.entries(value)) {
    if (!key || key.length > 64 || !isPlainRecord(schema) || !jsonSafe(schema)) invalid('Every tool field must be a bounded JSON schema object');
  }
  return deepFreeze(structuredClone(value) as ToolFields);
}

/** Validate and freeze one descriptor. Rejects a wrong apiVersion, a reserved or
 * duplicate name, an unknown kind, and a `requires` declaration that differs
 * from its kind: registration may not claim, omit or widen Host authority. */
export function defineToolDescriptor(input: ToolDescriptorInput): ToolDescriptor {
  const value = input as unknown;
  if (!isPlainRecord(value)) invalid('Tool descriptor must be a plain object');
  if (value.apiVersion !== TOOL_DESCRIPTOR_API_VERSION) invalid('Tool descriptor apiVersion must be the exact string "1"');
  const name = validatedName(value.name);
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) invalid('Tool version must be a bounded exact version string');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 4096) invalid('Tool description must be a non-empty bounded string');
  const kind = value.kind;
  if (kind !== 'read' && kind !== 'action_compare' && kind !== 'progress') invalid('Tool kind must be read, action_compare or progress');
  const expected = toolKindRequirements(kind);
  const requires = value.requires;
  if (!Array.isArray(requires) || requires.length !== expected.length || !expected.every(entry => requires.includes(entry))) {
    invalid('Tool requires must state exactly the Host entries its kind needs');
  }
  if (typeof value.execute !== 'function') invalid('Tool descriptor requires a local execute entry');
  return Object.freeze({
    apiVersion: TOOL_DESCRIPTOR_API_VERSION,
    name,
    version: value.version,
    description: value.description,
    kind,
    requires: Object.freeze([...requires] as ToolHostEntry[]),
    fields: validatedFields(value.fields),
    execute: value.execute as ToolExecute,
  });
}
