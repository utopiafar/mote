import {TASK_DESCRIPTOR_API_VERSION,type SkillDescriptor} from './tasks/descriptor.js';
import {defaultTaskRegistry} from './tasks/registry.js';
import {CALENDAR_SKILL_VERSION,calendarSkillDescriptor,installCalendarTaskPack} from './tasks/calendar.js';
import {insightSkillDescriptor,installInsightTaskPack} from './tasks/insight.js';
import {importSkillDescriptor,installImportTaskPack} from './tasks/import.js';
import {codingMemorySkillDescriptor,installCodingMemoryTaskPack} from './tasks/coding-memory.js';
import {installMemoryTaskPack,memoryConsolidationSkillDescriptor,memoryExtractionSkillDescriptor,memoryIntegrationSkillDescriptor,memorySkillDescriptors,memoryStrategySkillDescriptor} from './tasks/memory.js';
import {workingSkillDescriptor} from './tasks/working.js';

export const SKILL_VERSION = CALENDAR_SKILL_VERSION;
export type MoteSkillId = typeof codingMemorySkillDescriptor.id | typeof memoryStrategySkillDescriptor.id | typeof memoryIntegrationSkillDescriptor.id | typeof memoryExtractionSkillDescriptor.id | typeof memoryConsolidationSkillDescriptor.id | typeof workingSkillDescriptor.id | typeof calendarSkillDescriptor.id | typeof insightSkillDescriptor.id | typeof importSkillDescriptor.id;
const bundled = [
  calendarSkillDescriptor,
  insightSkillDescriptor,
  codingMemorySkillDescriptor,
  ...memorySkillDescriptors,
  workingSkillDescriptor,
  importSkillDescriptor,
];
installCalendarTaskPack();
installInsightTaskPack();
installImportTaskPack();
installMemoryTaskPack();
installCodingMemoryTaskPack();
export const bundledSkills = bundled.map((skill):SkillDescriptor=>{
  const availability = 'availability' in skill ? skill.availability : undefined;
  return {
    apiVersion:TASK_DESCRIPTOR_API_VERSION,id:skill.id,name:skill.name,version:skill.version,description:skill.description,content:skill.content,...(availability?{availability}:{}),
  };
});
export function skillCatalog(){return bundledSkills.map(({content,availability:_availability,...skill})=>skill);}
export function skillContent(id:MoteSkillId){return defaultTaskRegistry.skill(id).content;}
