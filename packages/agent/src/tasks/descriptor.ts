import type {QueryInput} from '../query-contracts.js';

export const TASK_DESCRIPTOR_API_VERSION = '1' as const;
export type TaskResponseMode = NonNullable<QueryInput['responseMode']>;
export type TaskRetrieval = 'archive' | 'evidence' | 'none';
export type TaskProfile = Readonly<{output: TaskResponseMode; retrieval: TaskRetrieval}>;
export type TaskSelection = Readonly<{id: string; version: string}>;
/** Query procedures are selected by the Host query. Import procedures are only
 * available to the dedicated writable import runtime. */
export type SkillAvailability = 'query' | 'import';

export const TASK_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {answer: {type: 'string'}, citationIds: {type: 'array', items: {type: 'string'}}},
  required: ['answer', 'citationIds'],
  additionalProperties: false,
});

export interface SkillDescriptor {
  readonly apiVersion: typeof TASK_DESCRIPTOR_API_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly content: string;
  /** Default query; import procedures never enter an ordinary query session. */
  readonly availability?: SkillAvailability;
  /** Default only; an explicit Host responseMode always wins. */
  readonly responseMode?: TaskResponseMode;
}

export interface TaskDescriptor {
  readonly apiVersion: typeof TASK_DESCRIPTOR_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly profile: TaskProfile;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /** Deterministic Host-field selection only, never captured-text dispatch. */
  readonly select: (input: QueryInput) => boolean;
  readonly priority?: number;
}

export interface TaskPack {
  readonly tasks?: readonly TaskDescriptor[];
  readonly skills?: readonly SkillDescriptor[];
  readonly dispose?: () => void | Promise<void>;
}

export type TaskContractErrorCode =
  | 'invalid_task_descriptor'
  | 'invalid_skill_descriptor'
  | 'duplicate_task'
  | 'duplicate_skill'
  | 'unknown_skill'
  | 'skill_unavailable'
  | 'invalid_task_selection'
  | 'unknown_task'
  | 'task_version_mismatch'
  | 'ambiguous_task';

export class TaskContractError extends Error {
  readonly name = 'TaskContractError';
  constructor(readonly code: TaskContractErrorCode, message: string) {
    super(message);
  }
}

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const responseModes = new Set<TaskResponseMode>(['answer', 'personal-insight', 'memory-extraction', 'calendar-extraction']);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function validIdAndVersion(value: {id?: unknown; version?: unknown}, code: 'invalid_task_descriptor' | 'invalid_skill_descriptor'): void {
  if (typeof value.id !== 'string' || !idPattern.test(value.id)) throw new TaskContractError(code, 'Descriptor id must be a bounded lowercase identifier.');
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) throw new TaskContractError(code, 'Descriptor version must be a bounded exact version string.');
}

export function defineSkillDescriptor(input: SkillDescriptor): SkillDescriptor {
  const value = input as unknown;
  if (!plainRecord(value) || value.apiVersion !== TASK_DESCRIPTOR_API_VERSION) throw new TaskContractError('invalid_skill_descriptor', 'Skill descriptor apiVersion must be the exact string "1".');
  validIdAndVersion(value, 'invalid_skill_descriptor');
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string' || !value.description.trim() || typeof value.content !== 'string' || !value.content.trim()) {
    throw new TaskContractError('invalid_skill_descriptor', 'Skill name, description and content must be non-empty strings.');
  }
  if (value.responseMode !== undefined && (typeof value.responseMode !== 'string' || !responseModes.has(value.responseMode as TaskResponseMode))) {
    throw new TaskContractError('invalid_skill_descriptor', 'Skill responseMode must be a supported Host response mode.');
  }
  if (value.availability !== undefined && value.availability !== 'query' && value.availability !== 'import') {
    throw new TaskContractError('invalid_skill_descriptor', 'Skill availability must be query or import.');
  }
  return Object.freeze({
    apiVersion: TASK_DESCRIPTOR_API_VERSION,
    id: value.id as string,
    name: value.name as string,
    version: value.version as string,
    description: value.description as string,
    content: value.content as string,
    ...(value.availability ? {availability: value.availability as SkillAvailability} : {}),
    ...(value.responseMode ? {responseMode: value.responseMode as TaskResponseMode} : {}),
  });
}

export function defineTaskDescriptor(input: TaskDescriptor): TaskDescriptor {
  const value = input as unknown;
  if (!plainRecord(value) || value.apiVersion !== TASK_DESCRIPTOR_API_VERSION) throw new TaskContractError('invalid_task_descriptor', 'Task descriptor apiVersion must be the exact string "1".');
  validIdAndVersion(value, 'invalid_task_descriptor');
  if (!plainRecord(value.profile) || !responseModes.has(value.profile.output as TaskResponseMode) || !['archive', 'evidence', 'none'].includes(value.profile.retrieval as string)) {
    throw new TaskContractError('invalid_task_descriptor', 'Task profile must declare a supported output and retrieval scope.');
  }
  if (!plainRecord(value.outputSchema)) throw new TaskContractError('invalid_task_descriptor', 'Task descriptor requires an output schema.');
  if (typeof value.select !== 'function') throw new TaskContractError('invalid_task_descriptor', 'Task descriptor requires a Host-input selection function.');
  if (value.priority !== undefined && (typeof value.priority !== 'number' || !Number.isSafeInteger(value.priority))) throw new TaskContractError('invalid_task_descriptor', 'Task priority must be a safe integer.');
  return Object.freeze({
    apiVersion: TASK_DESCRIPTOR_API_VERSION,
    id: value.id as string,
    version: value.version as string,
    profile: freeze({output: value.profile.output, retrieval: value.profile.retrieval}) as TaskProfile,
    outputSchema: freeze(structuredClone(value.outputSchema)),
    select: value.select as (input: QueryInput) => boolean,
    ...(value.priority !== undefined ? {priority: value.priority as number} : {}),
  });
}
