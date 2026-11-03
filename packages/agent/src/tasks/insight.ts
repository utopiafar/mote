import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,type SkillDescriptor,type TaskDescriptor,type TaskPack,type TaskProfile} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const INSIGHT_TASK_VERSION = '1';
export const INSIGHT_SKILL_VERSION = '1.0.5';
export const INSIGHT_TASK_PROFILE = {output:'personal-insight',retrieval:'archive'} as const satisfies TaskProfile;

/** Scheduled Insight reviews are advisory readings of the host snapshot. A
 * partial snapshot remains usable, but it never becomes evidence of complete
 * coverage or of an owner action. */
export const insightTaskDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'insight',
  version: INSIGHT_TASK_VERSION,
  profile: INSIGHT_TASK_PROFILE,
  outputSchema: TASK_OUTPUT_SCHEMA,
  priority: 40,
  select: input => input.skill === 'personal-insight' || input.responseMode === 'personal-insight',
} as const satisfies TaskDescriptor;

export const insightSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'personal-insight',
  name: 'personal-insight',
  version: INSIGHT_SKILL_VERSION,
  responseMode: 'personal-insight',
  description: 'Review personal context and distinguish evidence from inference, using the host-selected answer or insight-report format.',
  content: readFileSync(new URL('../../skills/personal-insight/SKILL.md', import.meta.url), 'utf8'),
} as const satisfies SkillDescriptor;

export function createInsightTaskPack(): TaskPack {
  return Object.freeze({
    tasks: Object.freeze([insightTaskDescriptor]),
    skills: Object.freeze([insightSkillDescriptor]),
  });
}

export function installInsightTaskPack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createInsightTaskPack());
}
