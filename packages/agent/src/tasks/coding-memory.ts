import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,type SkillDescriptor,type TaskPack} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const CODING_MEMORY_SKILL_VERSION = '6.2.0';

/** Coding experience extraction shares the Memory task profile but keeps its
 * own versioned procedure for conversation-specific semantics. */
export const codingMemorySkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'coding-memory',
  name: 'coding-memory',
  version: CODING_MEMORY_SKILL_VERSION,
  responseMode: 'memory-extraction',
  description: 'Read agent conversations with speaker and project context; distinguish personal memories, coding experiences and task breadcrumbs.',
  content: readFileSync(new URL('../../skills/coding-memory/SKILL.md',import.meta.url),'utf8'),
} as const satisfies SkillDescriptor;

export function createCodingMemoryTaskPack(): TaskPack {
  return Object.freeze({skills: Object.freeze([codingMemorySkillDescriptor])});
}

export function installCodingMemoryTaskPack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createCodingMemoryTaskPack());
}
