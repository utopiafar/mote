import {readFileSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,type SkillDescriptor,type TaskDescriptor,type TaskPack,type TaskProfile} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const IMPORT_TASK_VERSION = '1';
export const IMPORT_SKILL_VERSION = '1.0.6';
export const IMPORT_TASK_ID = 'import';
export const IMPORT_SKILL_ID = 'document-import';
/** Import never receives archive tools. Its provider owns a separate writable
 * workspace and returns a host-validated preview, not a query answer. */
export const IMPORT_TASK_PROFILE = {output:'answer',retrieval:'none'} as const satisfies TaskProfile;

export const importTaskDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: IMPORT_TASK_ID,
  version: IMPORT_TASK_VERSION,
  profile: IMPORT_TASK_PROFILE,
  outputSchema: TASK_OUTPUT_SCHEMA,
  priority: 70,
  select: input => input.skill === IMPORT_SKILL_ID || input.taskSelection?.id === IMPORT_TASK_ID,
} as const satisfies TaskDescriptor;

/** The import procedure belongs only to the dedicated writable import runtime.
 * It is registered so that runtime can read one versioned procedure, while an
 * ordinary query is refused before any context is assembled. */
export const importSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: IMPORT_SKILL_ID,
  name: IMPORT_SKILL_ID,
  version: IMPORT_SKILL_VERSION,
  availability: 'import',
  description: 'Inspect user-selected files and write a generic records manifest for a reviewable import.',
  content: readFileSync(new URL('../../skills/document-import/SKILL.md', import.meta.url), 'utf8'),
} as const satisfies SkillDescriptor;

export class ImportTaskContractError extends Error {
  readonly name = 'ImportTaskContractError';
  constructor(readonly code: 'import_records_path_outside_workspace') {
    super('Import preview artifacts must remain inside the import workspace');
  }
}

/** Resolve a model-reported artifact path without allowing it to escape the
 * import workspace. Existence and manifest contents remain Host validation. */
export function resolveImportRecordsPath(workspace: string, recordsPath: string | undefined): string | undefined {
  if (recordsPath === undefined) return undefined;
  if (!recordsPath.trim()) throw new ImportTaskContractError('import_records_path_outside_workspace');
  const root = resolve(workspace), path = resolve(root, recordsPath), rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ImportTaskContractError('import_records_path_outside_workspace');
  }
  return path;
}

export function createImportTaskPack(): TaskPack {
  return Object.freeze({
    tasks: Object.freeze([importTaskDescriptor]),
    skills: Object.freeze([importSkillDescriptor]),
  });
}

export function installImportTaskPack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createImportTaskPack());
}
