import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,type SkillDescriptor,type TaskPack} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const IMPORT_SKILL_VERSION = '1.0.6';

/** The import procedure belongs only to the dedicated writable import runtime.
 * It is registered so that runtime can read one versioned procedure, while an
 * ordinary query is refused before any context is assembled. */
export const importProcedureSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'document-import',
  name: 'document-import',
  version: IMPORT_SKILL_VERSION,
  availability: 'import',
  description: 'Inspect user-selected files and write a generic records manifest for a reviewable import.',
  content: readFileSync(new URL('../../skills/document-import/SKILL.md', import.meta.url), 'utf8'),
} as const satisfies SkillDescriptor;

export function createImportProcedurePack(): TaskPack {
  return Object.freeze({skills: Object.freeze([importProcedureSkillDescriptor])});
}

export function installImportProcedurePack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createImportProcedurePack());
}
