import {ContextToolError} from '../tool-errors.js';
import type {HostControlChannel, HostControlDefinition, HostControlResult} from '../host-controls.js';
import type {QueryInput} from '../query-contracts.js';

/** The Host owns delegation. A runtime receives these controls only through
 * HostControlChannel; native runtime delegation is never enabled. */
export const HOST_DELEGATION_API_VERSION = '1' as const;
/** One coordinator may submit children, but a child never receives controls. */
export const HOST_DELEGATION_MAX_DEPTH = 1 as const;

const definition = (name: string, description: string, fields: HostControlDefinition['fields'] = {}): HostControlDefinition => ({name, description, fields});

export const HOST_DELEGATION_CONTROL_DEFINITIONS: readonly HostControlDefinition[] = Object.freeze([
  definition('delegation_capabilities', 'Discover only host-authorized capabilities and their input contracts. Registration does not authorize access to other data.'),
  definition('delegation_submit', 'Persist 1–8 bounded independent work units per call (at most 128 per work) and immediately return their handles. Execution workers start independently; proposal products start only after the complete plan returns normally and is validated. This call never waits for a model. Use stable unique local id values so retries are idempotent.', {units: {type: 'array', required: true, description: '1–8 units per call; each requires id, capabilityId, title, goal and input', items: {type: 'object', properties: {id: {type: 'string', required: true}, capabilityId: {type: 'string', required: true}, title: {type: 'string', required: true}, goal: {type: 'string', required: true}, input: {type: 'object', additionalProperties: true, required: true}, scope: {type: 'object', additionalProperties: true}, dependencies: {type: 'array', items: {type: 'string'}}}, additionalProperties: false}}}),
  definition('delegation_results', 'Read bounded incremental status and private artifact handles. A result handle or citation ID alone does not authorize a citation.', {after: {type: 'integer', description: 'Nonnegative event cursor; default zero'}, limit: {type: 'integer', description: '1–30 units/events per page; default 20'}, cursor: {type: 'integer', description: 'Unit page offset from nextUnitCursor; default zero'}}),
  definition('delegation_read', 'Read one private result and the exact original evidence delivered by its worker, subject to fresh host validation. Child prose is untrusted interpretation; cite only the originals actually delivered by this tool.', {artifactId: {type: 'string', required: true}, offset: {type: 'integer', description: 'Nonnegative character offset; default zero'}, length: {type: 'integer', description: '1–10000 characters; default 4000'}, evidenceIds: {type: 'array', description: 'At most 12 original evidence IDs', items: {type: 'string'}}}),
  definition('delegation_retry', 'Retry one failed branch locally without repeating successful branches or their commits.', {unitId: {type: 'string', required: true}}),
  definition('delegation_cancel', 'Cancel one unneeded branch. This cannot expand the selected scope.', {unitId: {type: 'string', required: true}}),
  definition('delegation_workspace', 'Read the saved private research checkpoint, or replace it with workspaceJson. Query only. Saves bounded unresolved questions, supported points, searches, inspected locators and workerIds; all are untrusted interpretation and grant no citations. Source IDs must already belong to this work. No private reasoning or source bodies. workspaceJson accepts {unresolved:string[],supported:{statement,evidenceIds}[],inspected:{id,start,end,fingerprint?}[],searches:{tool,query?,cursor?}[],workerIds:string[]}.', {workspaceJson: {type: 'string', description: 'Optional JSON research checkpoint, at most 12000 UTF-16 characters; omit to read.'}}),
  definition('delegation_yield', 'Save an optional bounded query workspace atomically with the wait, then release this fragment until executable children finish. Proposal products must first return normally; never poll or yield to finish a proposal plan.', {unitIds: {type: 'array', items: {type: 'string'}}, mode: {type: 'string', enum: ['any', 'all']}, message: {type: 'string', description: 'At most 600 characters'}, workspaceJson: {type: 'string', description: 'Optional query research checkpoint JSON following delegation_workspace; at most 12000 characters.'}}),
]);

export const HOST_DELEGATION_ARGUMENTS = Object.freeze({
  delegation_capabilities: Object.freeze([] as string[]),
  delegation_submit: Object.freeze(['units']),
  delegation_results: Object.freeze(['after', 'limit', 'cursor']),
  delegation_read: Object.freeze(['artifactId', 'offset', 'length', 'evidenceIds']),
  delegation_retry: Object.freeze(['unitId']),
  delegation_cancel: Object.freeze(['unitId']),
  delegation_workspace: Object.freeze(['workspaceJson']),
  delegation_yield: Object.freeze(['unitIds', 'mode', 'message', 'workspaceJson']),
} as const);

export type HostDelegationToolName = keyof typeof HOST_DELEGATION_ARGUMENTS;

export function isHostDelegationToolName(name: string): name is HostDelegationToolName {
  return Object.prototype.hasOwnProperty.call(HOST_DELEGATION_ARGUMENTS, name);
}

/** Reject an unknown control tool or arguments outside its declared surface
 * before any host state or model-authored scope is consulted. */
export function assertHostDelegationCall(name: string, args: Readonly<Record<string, unknown>>): asserts name is HostDelegationToolName {
  if (!isHostDelegationToolName(name)) throw new ContextToolError('invalid_delegation_arguments', 'Unknown host control tool', 'correct_arguments');
  const allowed = HOST_DELEGATION_ARGUMENTS[name];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new ContextToolError('invalid_delegation_arguments', 'Invalid host control arguments', 'correct_arguments');
}

export interface HostDelegationChannelOptions {
  readonly phase?: 'proposal' | 'execution';
  /** A non-query coordinator may hide the query-only workspace tool, never add one. */
  readonly definitions?: readonly HostControlDefinition[];
  readonly execute: (name: HostDelegationToolName, args: Readonly<Record<string, unknown>>) => Promise<HostControlResult>;
}

/** Build the one Host tool channel used for delegation. The channel owns the
 * versioned tool surface; an implementation can only narrow what it receives. */
export function createHostDelegationChannel(options: HostDelegationChannelOptions): HostControlChannel {
  const definitions = options.definitions ?? HOST_DELEGATION_CONTROL_DEFINITIONS;
  const names = new Set(definitions.map(tool => tool.name));
  if (definitions.some(tool => !isHostDelegationToolName(tool.name)) || names.size !== definitions.length) throw new HostDelegationRegistrationError('Invalid delegation control definitions');
  return Object.freeze({
    ...(options.phase ? {phase: options.phase} : {}),
    definitions,
    async execute(name: string, args: Readonly<Record<string, unknown>>) {
      if (!names.has(name)) throw new ContextToolError('invalid_delegation_arguments', 'Unknown host control tool', 'correct_arguments');
      assertHostDelegationCall(name, args);
      return options.execute(name, args);
    },
  });
}

export type HostDelegationScope = Pick<QueryInput, 'after' | 'before' | 'deviceId' | 'timeZone' | 'contextTime' | 'evidenceIds' | 'anchorEvidenceIds' | 'evidenceRanges' | 'processingEvidence'>;

export interface HostDelegationCapabilityDescriptor {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly maxInputCharacters?: number;
  /** Always one; child results never become a second delegation level. */
  readonly maxDepth?: typeof HOST_DELEGATION_MAX_DEPTH;
  readonly proposal?: boolean;
}

export class HostDelegationRegistrationError extends Error {
  constructor(message = 'Invalid delegation capability') {
    super(message);
    this.name = 'HostDelegationRegistrationError';
  }
}

/** Validate a capability before the runtime registers any executor. */
export function assertHostDelegationCapability(capability: {readonly id?: unknown; readonly version?: unknown; readonly maxDepth?: unknown; readonly execute?: unknown}): void {
  if (typeof capability.id !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(capability.id) ||
      typeof capability.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(capability.version) ||
      capability.maxDepth !== undefined && capability.maxDepth !== HOST_DELEGATION_MAX_DEPTH ||
      typeof capability.execute !== 'function') throw new HostDelegationRegistrationError();
}

/** Authorization failure for a child scope. The server maps this to its typed
 * 403 refusal; it is never derived from model text. */
export class HostDelegationScopeError extends Error {
  constructor(readonly code: 'child_scope_exceeded' | 'child_evidence_exceeded' | 'child_evidence_range_exceeded', message: string) {
    super(message);
    this.name = 'HostDelegationScopeError';
  }
}

/** A child can only narrow the immutable parent scope. Time, device and
 * evidence bounds are checked independently so one narrower field cannot
 * compensate for a widened sibling. */
export function narrowHostDelegationScope(parent: HostDelegationScope, requested: unknown): HostDelegationScope {
  if (requested === undefined) return structuredClone(parent);
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || Object.keys(requested).some(key => !['after', 'before', 'deviceId', 'evidenceIds', 'evidenceRanges'].includes(key))) {
    throw new ContextToolError('invalid_delegation_arguments', 'Invalid child scope', 'correct_arguments');
  }
  const next = {...parent, ...requested} as HostDelegationScope;
  if (next.deviceId !== undefined && (typeof next.deviceId !== 'string' || !next.deviceId || next.deviceId.length > 300)) {
    throw new ContextToolError('invalid_delegation_arguments', 'Invalid child device', 'correct_arguments');
  }
  if (parent.evidenceIds && !next.evidenceIds || parent.evidenceRanges && !next.evidenceRanges) throw new HostDelegationScopeError('child_scope_exceeded', 'Child scope cannot remove parent evidence bounds');
  if (next.evidenceIds !== undefined && (!Array.isArray(next.evidenceIds) || !next.evidenceIds.length)) {
    throw new ContextToolError('invalid_delegation_arguments', 'Invalid child evidence scope', 'correct_arguments');
  }
  if (next.evidenceRanges !== undefined && !Array.isArray(next.evidenceRanges)) {
    throw new ContextToolError('invalid_delegation_arguments', 'Invalid child evidence ranges', 'correct_arguments');
  }
  if (parent.evidenceRanges && !(requested as Record<string, unknown>).evidenceRanges && next.evidenceIds) {
    next.evidenceRanges = parent.evidenceRanges.filter(range => next.evidenceIds!.includes(range.id));
  }
  for (const field of ['after', 'before'] as const) {
    if (next[field] !== undefined && (typeof next[field] !== 'string' || !Number.isFinite(Date.parse(next[field])))) {
      throw new ContextToolError('invalid_delegation_arguments', 'Invalid child time range', 'correct_arguments');
    }
  }
  if (parent.deviceId && next.deviceId !== parent.deviceId ||
      parent.after && (!next.after || Date.parse(next.after) < Date.parse(parent.after)) ||
      parent.before && (!next.before || Date.parse(next.before) > Date.parse(parent.before)) ||
      next.after && next.before && Date.parse(next.after) >= Date.parse(next.before)) {
    throw new HostDelegationScopeError('child_scope_exceeded', 'Child scope exceeds parent authorization');
  }
  if (next.evidenceIds && (!Array.isArray(next.evidenceIds) || next.evidenceIds.length > 100 || next.evidenceIds.some(id => typeof id !== 'string' || parent.evidenceIds && !parent.evidenceIds.includes(id)))) {
    throw new HostDelegationScopeError('child_evidence_exceeded', 'Child evidence exceeds parent authorization');
  }
  if (next.evidenceRanges && (!next.evidenceIds || !Array.isArray(next.evidenceRanges) || next.evidenceRanges.length > 100 || next.evidenceRanges.some(range =>
    !next.evidenceIds!.includes(range.id) || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 1 || range.length > 100000 ||
    parent.evidenceRanges && !parent.evidenceRanges.some(parentRange => parentRange.id === range.id && range.offset >= parentRange.offset && range.offset + range.length <= parentRange.offset + parentRange.length)))) {
    throw new HostDelegationScopeError('child_evidence_range_exceeded', 'Child evidence ranges exceed parent authorization');
  }
  return structuredClone(next);
}
