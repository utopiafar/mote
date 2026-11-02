import {createHash} from 'node:crypto';
import {JsonSchemaError, parameterSchemaSpecToJsonSchema, type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools';
import type {RuntimeToolIdentity} from '../runtime/contracts.js';
import {ContextToolError} from '../tool-errors.js';
import type {HostReadOperation, HostSessionPort} from './host-session.js';

/** Version of the tool-descriptor contract carried by every descriptor.
 * This is the literal string '1', unlike the numeric wire snapshot version. */
export const TOOL_DESCRIPTOR_API_VERSION = '1' as const;
/** Version of the serializable registry snapshot DTO. */
export const TOOL_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** HostSessionPort read operations, kept in the same order/name as the frozen
 * port. This list is only a registration-time spelling check; HostSessionPort
 * stays the single typed authority and every call still goes through it. */
export const HOST_READ_OPERATIONS = [
  'catalog', 'search', 'timeline', 'evidence',
  'materialCatalog', 'materialRead', 'segments', 'memories',
  'sources', 'sourceItems', 'sourceHistory', 'sourceContext',
  'readFileEvidence', 'fileChunks',
  'activity', 'mediaActivity', 'devices', 'readImage',
] as const satisfies readonly HostReadOperation[];
type MissingHostReadOperation = Exclude<HostReadOperation, (typeof HOST_READ_OPERATIONS)[number]>;
// Fails to compile if the frozen port adds an operation this list does not cover.
const hostReadOperationsComplete: MissingHostReadOperation extends never ? true : never = true;
void hostReadOperationsComplete;

/** Declared Host permission. Names are exactly the HostSessionPort entry names;
 * a declaration is validated by the Host and never creates a grant table. */
export type ToolPermission = HostReadOperation | 'actionCatalog' | 'progress';
/** What the contribution describes. This is descriptive only: it grants no
 * citation, original bytes or image pixels. */
export type ToolKind = 'originals' | 'derived' | 'metadata' | 'image';
/** How the Host may expose the tool in one task. Selected per descriptor; there
 * is no hidden built-in name allowlist. */
export type ToolExposure = 'native' | 'catalog';
export type ToolFields = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
/** Explicit run selection. Order is the caller's order, never registration order. */
export type ToolSelection = readonly {readonly name: string; readonly version: string}[];

export type ToolContractErrorCode =
  | 'invalid_tool_descriptor'
  | 'reserved_tool_name'
  | 'duplicate_tool'
  | 'invalid_tool_selection'
  | 'unknown_tool'
  | 'tool_version_mismatch'
  | 'invalid_tool_arguments'
  | 'tool_permission_denied'
  | 'stale_tool_pin';

const hostPermissions = new Set<string>([...HOST_READ_OPERATIONS, 'actionCatalog', 'progress']);
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
  tool_permission_denied: 'stop',
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
 * it is not a signature and grants nothing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}

/** Canonical identity of one tool: schema plus every declaration that changes
 * its surface. Permission order is normalized; object keys are sorted so a
 * reordered but equivalent descriptor keeps the same identity. This is the one
 * current format, not a legacy-compatible hash. */
export function toolFingerprint(
  description: string,
  fields: ToolFields,
  kind: ToolKind,
  exposure: ToolExposure,
  requires: readonly ToolPermission[],
): string {
  return createHash('sha256').update(canonicalJson({
    description,
    fields,
    kind,
    exposure,
    requires: [...requires].sort(),
  })).digest('hex');
}

export type ToolParse = (args: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
export type ToolExecute = (args: Readonly<Record<string, unknown>>, port: HostSessionPort) => unknown | Promise<unknown>;

/** Validated, deep-frozen descriptor owned by the parent A08 session. `parse`
 * and `execute` are local trusted code: they never enter a snapshot or a
 * discovery document, and `execute` receives only the parent-bound port. */
export interface ToolDescriptor {
  readonly apiVersion: typeof TOOL_DESCRIPTOR_API_VERSION;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly fields: ToolFields;
  readonly kind: ToolKind;
  readonly exposure: ToolExposure;
  readonly requires: readonly ToolPermission[];
  readonly parse: ToolParse;
  readonly execute: ToolExecute;
}

/** Pure wire DTO entry. Identity, pinned schema and declarations only: no
 * parse/execute callback, token, reader or other local secret. */
export interface ToolSnapshotEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly fields: ToolFields;
  readonly kind: ToolKind;
  readonly exposure: ToolExposure;
  readonly requires: readonly ToolPermission[];
  readonly fingerprint: string;
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
  if (!isPlainRecord(value)) invalid('Tool fields must be a plain ParameterSchemaSpec property map');
  if (Object.keys(value).length > 64) invalid('Tool fields may declare at most 64 properties');
  for (const [key, schema] of Object.entries(value)) {
    if (!key || key.length > 64 || !isPlainRecord(schema) || !jsonSafe(schema)) invalid('Every tool field must be a bounded JSON schema object');
  }
  // Reject a malformed ParameterSchemaSpec before it can enter a snapshot and
  // break runtime tool-list construction. This is the same production compiler
  // the DSH/Codex schema adapters use, not a second schema interpreter.
  try {
    parameterSchemaSpecToJsonSchema(value as unknown as ParameterSchemaSpec);
  } catch (error) {
    throw toolContractError('invalid_tool_descriptor', 'Tool fields must compile as a ParameterSchemaSpec.', {
      ...(error instanceof JsonSchemaError ? {violations: error.violations.slice(0, 8)} : {}),
    });
  }
  return deepFreeze(structuredClone(value) as ToolFields);
}

function validatedRequires(value: unknown): readonly ToolPermission[] {
  if (!Array.isArray(value)) invalid('Tool requires must be an array of HostSessionPort operations');
  if (value.length > 32) invalid('Tool requires may declare at most 32 permissions');
  for (const entry of value) {
    if (typeof entry !== 'string' || !hostPermissions.has(entry)) invalid('Tool requires may only name a HostSessionPort read operation, actionCatalog or progress');
  }
  if (new Set(value).size !== value.length) invalid('Tool requires must not repeat a permission');
  return Object.freeze([...value] as ToolPermission[]);
}

/** Validate and freeze one descriptor. Rejects a wrong apiVersion, a reserved or
 * malformed name/version, an unknown kind/exposure, a permission name that is
 * not a HostSessionPort entry, and a missing local parse/execute entry. */
export function defineToolDescriptor(input: ToolDescriptor): ToolDescriptor {
  const value = input as unknown;
  if (!isPlainRecord(value)) invalid('Tool descriptor must be a plain object');
  if (value.apiVersion !== TOOL_DESCRIPTOR_API_VERSION) invalid('Tool descriptor apiVersion must be the exact string "1"');
  const name = validatedName(value.name);
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) invalid('Tool version must be a bounded exact version string');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 4096) invalid('Tool description must be a non-empty bounded string');
  if (value.kind !== 'originals' && value.kind !== 'derived' && value.kind !== 'metadata' && value.kind !== 'image') invalid('Tool kind must be originals, derived, metadata or image');
  if (value.exposure !== 'native' && value.exposure !== 'catalog') invalid('Tool exposure must be native or catalog');
  const requires = validatedRequires(value.requires);
  if (typeof value.parse !== 'function') invalid('Tool descriptor requires a local parse entry');
  if (typeof value.execute !== 'function') invalid('Tool descriptor requires a local execute entry');
  return Object.freeze({
    apiVersion: TOOL_DESCRIPTOR_API_VERSION,
    name,
    version: value.version,
    description: value.description,
    fields: validatedFields(value.fields),
    kind: value.kind,
    exposure: value.exposure,
    requires,
    parse: value.parse as ToolParse,
    execute: value.execute as ToolExecute,
  });
}
