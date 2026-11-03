import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION,type SkillDescriptor,type TaskResponseMode} from './tasks/descriptor.js';
import {defaultTaskRegistry} from './tasks/registry.js';
import {CALENDAR_SKILL_VERSION,calendarSkillDescriptor,installCalendarTaskPack} from './tasks/calendar.js';
import {insightSkillDescriptor,installInsightTaskPack} from './tasks/insight.js';
import {importProcedureSkillDescriptor,installImportProcedurePack} from './tasks/import-procedure.js';

export const SKILL_VERSION = CALENDAR_SKILL_VERSION;
const catalog = [
  {id:'coding-memory',name:'coding-memory',version:'6.2.0',responseMode:'memory-extraction',description:'Read agent conversations with speaker and project context; distinguish personal memories, coding experiences and task breadcrumbs.'},
  {id:'memory-strategy',name:'memory-strategy',version:'1.0.0',responseMode:'memory-extraction',description:'Execute a host-selected bounded Memory extraction or review policy with shared evidence guarantees.'},
  {id:'memory-integration',name:'memory-integration',version:'1.0.0',responseMode:'memory-extraction',description:'Execute a host-selected Memory integration or review policy using read-only cards and original evidence.'},
  {id:'memory-extraction',name:'memory-extraction',version:'3.4.0',responseMode:'memory-extraction',description:'Propose durable memories from an explicit batch of original evidence, preserving attribution and provenance.'},
  {id:'memory-consolidation',name:'memory-consolidation',version:'3.4.0',description:'Consolidate episodic text memories into supported semantic or procedural proposals; revisit originals and preserve conflicting and historical evidence.'},
  {id:'working-memory',name:'working-memory',version:'1.0.0',description:'Compact conversation context into a bounded textual working memory, preserving decisions, open questions and attribution.'},
] as const satisfies readonly {id:string;name:string;description:string;version:string;responseMode?:TaskResponseMode}[];
export type MoteSkillId = typeof catalog[number]['id'] | typeof calendarSkillDescriptor.id | typeof insightSkillDescriptor.id | typeof importProcedureSkillDescriptor.id;
const content = (id:string) => readFileSync(new URL(`../skills/${id}/SKILL.md`,import.meta.url),'utf8');
const memorySkills = catalog.map(skill=>({...skill,content:content(skill.id)}));
const bundled = [
  calendarSkillDescriptor,
  insightSkillDescriptor,
  ...memorySkills,
  importProcedureSkillDescriptor,
];
installCalendarTaskPack();
installInsightTaskPack();
installImportProcedurePack();
defaultTaskRegistry.register({skills:memorySkills.map(skill=>({...skill,apiVersion:TASK_DESCRIPTOR_API_VERSION}))});
export const bundledSkills = bundled.map((skill):SkillDescriptor=>{
  const availability = 'availability' in skill ? skill.availability : undefined;
  return {
    apiVersion:TASK_DESCRIPTOR_API_VERSION,id:skill.id,name:skill.name,version:skill.version,description:skill.description,content:skill.content,...(availability?{availability}:{}),
  };
});
export function skillCatalog(){return bundledSkills.map(({content,availability:_availability,...skill})=>skill);}
export function skillContent(id:MoteSkillId){return defaultTaskRegistry.skill(id).content;}
