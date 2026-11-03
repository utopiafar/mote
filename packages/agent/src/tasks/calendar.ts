import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,type SkillDescriptor,type TaskDescriptor,type TaskPack,type TaskProfile} from './descriptor.js';
import {defaultTaskRegistry,type TaskRegistry} from './registry.js';

export const CALENDAR_TASK_VERSION = '1';
export const CALENDAR_SKILL_VERSION = '1.0.3';
export const CALENDAR_TASK_PROFILE = {output:'calendar-extraction',retrieval:'evidence'} as const satisfies TaskProfile;

/** Calendar work in this pack can only produce reviewable proposals. The
 * read-only action catalog is comparison context; no calendar mutation tool or
 * owner execution grant is registered here. */
export const calendarTaskDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'calendar',
  version: CALENDAR_TASK_VERSION,
  profile: CALENDAR_TASK_PROFILE,
  outputSchema: TASK_OUTPUT_SCHEMA,
  priority: 50,
  select: input => input.skill === 'calendar-extraction' || input.responseMode === 'calendar-extraction',
} as const satisfies TaskDescriptor;

export const calendarSkillDescriptor = {
  apiVersion: TASK_DESCRIPTOR_API_VERSION,
  id: 'calendar-extraction',
  name: 'calendar-extraction',
  version: CALENDAR_SKILL_VERSION,
  responseMode: 'calendar-extraction',
  description: 'Propose personal calendar events from original evidence for host validation and owner-scoped execution, distinguishing missing schedule values from semantic uncertainty and preserving provenance.',
  content: readFileSync(new URL('../../skills/calendar-extraction/SKILL.md', import.meta.url), 'utf8'),
} as const satisfies SkillDescriptor;

export function createCalendarTaskPack(): TaskPack {
  return Object.freeze({
    tasks: Object.freeze([calendarTaskDescriptor]),
    skills: Object.freeze([calendarSkillDescriptor]),
  });
}

export function installCalendarTaskPack(registry: TaskRegistry = defaultTaskRegistry): () => void | Promise<void> {
  return registry.register(createCalendarTaskPack());
}
