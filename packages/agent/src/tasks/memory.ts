import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,type SkillDescriptor,type TaskDescriptor,type TaskPack,type TaskProfile} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const MEMORY_TASK_ID = 'extraction';
export const MEMORY_TASK_VERSION = '1';
export const MEMORY_EXTRACTION_SKILL_VERSION = '3.4.0';
export const MEMORY_CONSOLIDATION_SKILL_VERSION = '3.4.0';
export const MEMORY_STRATEGY_SKILL_VERSION = '1.0.0';
export const MEMORY_INTEGRATION_SKILL_VERSION = '1.0.0';
/** Every Memory phase reads only the host-supplied original ranges. */
export const MEMORY_TASK_PROFILE = {output:'memory-extraction',retrieval:'evidence'} as const satisfies TaskProfile;

const content = (id:string) => readFileSync(new URL(`../../skills/${id}/SKILL.md`,import.meta.url),'utf8');

/** The extraction profile is the Host-selected procedure for every Memory
 * phase; the selected skill supplies the exact versioned procedure. */
export const memoryTaskDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: MEMORY_TASK_ID,
  version: MEMORY_TASK_VERSION,
  profile: MEMORY_TASK_PROFILE,
  outputSchema: TASK_OUTPUT_SCHEMA,
  priority: 30,
  select: (input) => input.responseMode === 'memory-extraction'
    || ['memory-extraction','memory-consolidation','memory-strategy','memory-integration','coding-memory'].includes(input.skill ?? ''),
} as const satisfies TaskDescriptor;

export const memoryExtractionSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'memory-extraction',
  name: 'memory-extraction',
  version: MEMORY_EXTRACTION_SKILL_VERSION,
  responseMode: 'memory-extraction',
  description: 'Propose durable memories from an explicit batch of original evidence, preserving attribution and provenance.',
  content: content('memory-extraction'),
} as const satisfies SkillDescriptor;

export const memoryConsolidationSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'memory-consolidation',
  name: 'memory-consolidation',
  version: MEMORY_CONSOLIDATION_SKILL_VERSION,
  description: 'Consolidate episodic text memories into supported semantic or procedural proposals; revisit originals and preserve conflicting and historical evidence.',
  content: content('memory-consolidation'),
} as const satisfies SkillDescriptor;

export const memoryStrategySkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'memory-strategy',
  name: 'memory-strategy',
  version: MEMORY_STRATEGY_SKILL_VERSION,
  responseMode: 'memory-extraction',
  description: 'Execute a host-selected bounded Memory extraction or review policy with shared evidence guarantees.',
  content: content('memory-strategy'),
} as const satisfies SkillDescriptor;

export const memoryIntegrationSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'memory-integration',
  name: 'memory-integration',
  version: MEMORY_INTEGRATION_SKILL_VERSION,
  responseMode: 'memory-extraction',
  description: 'Execute a host-selected Memory integration or review policy using read-only cards and original evidence.',
  content: content('memory-integration'),
} as const satisfies SkillDescriptor;

export const memorySkillDescriptors = Object.freeze([
  memoryStrategySkillDescriptor,
  memoryIntegrationSkillDescriptor,
  memoryExtractionSkillDescriptor,
  memoryConsolidationSkillDescriptor,
]);

export function createMemoryTaskPack(): TaskPack {
  return Object.freeze({
    tasks: Object.freeze([memoryTaskDescriptor]),
    skills: memorySkillDescriptors,
  });
}

export function installMemoryTaskPack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createMemoryTaskPack());
}
